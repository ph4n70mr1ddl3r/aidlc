const db = require('../models/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { paginate, paginationBaseUrl, addSearch, buildFilters, safeId, safePositiveFloat, safeInt, safeDate, trim, getActiveStaff, isActiveUser } = require('../utils');
const { ASSET_CATEGORIES: VALID_CATEGORIES, ASSET_STATUSES: VALID_STATUSES, ASSET_CONDITIONS: VALID_CONDITIONS } = require('../constants');

const router = require('express').Router();
router.use(requireAuth, auditMiddleware);

// List assets (paginated)
router.get('/', (req, res) => {
  const { page, limit, offset } = paginate(req);

  const filters = buildFilters({
    'a.category': { value: VALID_CATEGORIES.includes(req.query.category) ? req.query.category : '' },
    'a.status': { value: VALID_STATUSES.includes(req.query.status) ? req.query.status : '' },
    'a.assigned_to': { value: req.query.assigned_to ? safeId(req.query.assigned_to) || '' : '' },
  });

  const where = [...filters.where];
  const params = [...filters.params];
  addSearch(where, params, req.query.search, ['a.name', 'a.asset_tag', 'a.serial_number', 'a.manufacturer']);

  const whereClause = where.length ? where.join(' AND ') : '1=1';

  const total = db.prepare(`SELECT COUNT(*) as c FROM assets a WHERE ${whereClause}`).get(...params).c;
  const totalPages = Math.ceil(total / limit) || 1;

  const assets = db.prepare(`
    SELECT a.*, u.first_name || ' ' || u.last_name as assigned_name
    FROM assets a
    LEFT JOIN users u ON a.assigned_to = u.id
    WHERE ${whereClause}
    ORDER BY a.name ASC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const staff = getActiveStaff(db);

  res.render('pages/assets/index', {
    title: 'Assets', assets, staff, filters: req.query,
    page, totalPages, total,
    baseUrl: paginationBaseUrl(req),
  });
});

// New asset form
router.get('/new', requireRole('admin', 'manager'), (req, res) => {
  const staff = getActiveStaff(db);
  // Generate next asset tag server-side (avoid client-side randomness)
  const last = db.prepare('SELECT asset_tag FROM assets ORDER BY id DESC LIMIT 1').get();
  let nextTag = 'AST-001';
  if (last && last.asset_tag) {
    const num = parseInt(last.asset_tag.replace(/\D/g, ''), 10);
    if (num) nextTag = 'AST-' + String(num + 1).padStart(3, '0');
  }
  res.render('pages/assets/form', { title: 'New Asset', asset: { asset_tag: nextTag }, staff, isEdit: false });
});

// Create asset
router.post('/', requireRole('admin', 'manager'), (req, res) => {
  const asset_tag = trim(req.body.asset_tag);
  const name = trim(req.body.name);
  const category = req.body.category;
  const manufacturer = trim(req.body.manufacturer);
  const model = trim(req.body.model);
  const serial_number = trim(req.body.serial_number);
  const status = req.body.status;
  const condition_rating = req.body.condition_rating;
  const purchase_date = req.body.purchase_date;
  const purchase_price = req.body.purchase_price;
  const warranty_expiry = req.body.warranty_expiry;
  const assigned_to = req.body.assigned_to;
  const location = trim(req.body.location);
  const notes = trim(req.body.notes);

  if (!asset_tag || !name || !category) {
    req.flash('error', 'Asset tag, name, and category are required');
    return res.redirect('/assets/new');
  }
  if (name.length > 200) {
    req.flash('error', 'Asset name must be at most 200 characters');
    return res.redirect('/assets/new');
  }

  if (!VALID_CATEGORIES.includes(category)) {
    req.flash('error', 'Invalid category');
    return res.redirect('/assets/new');
  }
  const safeStatus = VALID_STATUSES.includes(status) ? status : 'in_storage';
  const safeCondition = VALID_CONDITIONS.includes(condition_rating) ? condition_rating : 'good';

  // Validate assignee is an active user
  const createAssignee = assigned_to ? safeId(assigned_to) : null;
  if (createAssignee && !isActiveUser(db, createAssignee)) {
    req.flash('error', 'Selected assignee is not available');
    return res.redirect('/assets/new');
  }

  try {
    const result = db.prepare(`
      INSERT INTO assets (asset_tag, name, category, manufacturer, model, serial_number,
        status, condition_rating, purchase_date, purchase_price, warranty_expiry,
        assigned_to, location, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      asset_tag.substring(0, 50), name.substring(0, 200), category, (manufacturer || '').substring(0, 100) || null,
      (model || '').substring(0, 100) || null, (serial_number || '').substring(0, 100) || null,
      safeStatus, safeCondition, safeDate(purchase_date),
      purchase_price !== undefined && purchase_price !== '' ? safePositiveFloat(purchase_price) : null,
      safeDate(warranty_expiry), createAssignee, (location || '').substring(0, 100) || null, (notes || '').substring(0, 2000) || null
    );

    req.audit('create', 'asset', result.lastInsertRowid, `Created asset ${asset_tag}`);
    req.flash('success', `Asset ${asset_tag} created successfully`);
    res.redirect('/assets');
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      req.flash('error', 'Asset tag or serial number already exists');
    } else {
      console.error('Asset create error:', err.message);
      req.flash('error', 'Error creating asset. Please check your input and try again.');
    }
    res.redirect('/assets/new');
  }
});

// Show asset
router.get('/:id', (req, res) => {
  const id = safeId(req.params.id);
  if (!id) { req.flash('error', 'Invalid asset ID'); return res.redirect('/assets'); }

  const asset = db.prepare(`
    SELECT a.*, u.first_name || ' ' || u.last_name as assigned_name, u.email as assigned_email
    FROM assets a
    LEFT JOIN users u ON a.assigned_to = u.id
    WHERE a.id = ?
  `).get(id);

  if (!asset) {
    req.flash('error', 'Asset not found');
    return res.redirect('/assets');
  }

  const relatedTickets = db.prepare(`
    SELECT id, ticket_number, title, status, priority, created_at
    FROM tickets WHERE asset_id = ? ORDER BY created_at DESC LIMIT 10
  `).all(id);

  res.render('pages/assets/show', { title: asset.name, asset, relatedTickets });
});

// Edit asset form
router.get('/:id/edit', requireRole('admin', 'manager'), (req, res) => {
  const id = safeId(req.params.id);
  if (!id) { req.flash('error', 'Invalid asset ID'); return res.redirect('/assets'); }

  const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
  if (!asset) {
    req.flash('error', 'Asset not found');
    return res.redirect('/assets');
  }
  const staff = getActiveStaff(db);
  res.render('pages/assets/form', { title: 'Edit Asset', asset, staff, isEdit: true });
});

// Update asset
router.put('/:id', requireRole('admin', 'manager'), (req, res) => {
  const id = safeId(req.params.id);
  if (!id) { req.flash('error', 'Invalid asset ID'); return res.redirect('/assets'); }

  const asset_tag = trim(req.body.asset_tag);
  const name = trim(req.body.name);
  const category = req.body.category;
  const manufacturer = trim(req.body.manufacturer);
  const model = trim(req.body.model);
  const serial_number = trim(req.body.serial_number);
  const status = req.body.status;
  const condition_rating = req.body.condition_rating;
  const purchase_date = req.body.purchase_date;
  const purchase_price = req.body.purchase_price;
  const warranty_expiry = req.body.warranty_expiry;
  const assigned_to = req.body.assigned_to;
  const location = trim(req.body.location);
  const notes = trim(req.body.notes);

  if (!asset_tag || !name || !category) {
    req.flash('error', 'Asset tag, name, and category are required');
    return res.redirect(`/assets/${id}/edit`);
  }
  if (name.length > 200) {
    req.flash('error', 'Asset name must be at most 200 characters');
    return res.redirect(`/assets/${id}/edit`);
  }
  if (!VALID_CATEGORIES.includes(category)) {
    req.flash('error', 'Invalid category');
    return res.redirect(`/assets/${id}/edit`);
  }
  const safeStatus = VALID_STATUSES.includes(status) ? status : 'in_storage';
  const safeCondition = VALID_CONDITIONS.includes(condition_rating) ? condition_rating : 'good';

  // Validate assignee is an active user
  const updateAssignee = assigned_to ? safeId(assigned_to) : null;
  if (updateAssignee && !isActiveUser(db, updateAssignee)) {
    req.flash('error', 'Selected assignee is not available');
    return res.redirect(`/assets/${id}/edit`);
  }

  try {
    // Verify asset exists before updating
    const existing = db.prepare('SELECT id FROM assets WHERE id = ?').get(id);
    if (!existing) { req.flash('error', 'Asset not found'); return res.redirect('/assets'); }

    db.prepare(`
      UPDATE assets SET asset_tag = ?, name = ?, category = ?, manufacturer = ?,
        model = ?, serial_number = ?, status = ?, condition_rating = ?,
        purchase_date = ?, purchase_price = ?, warranty_expiry = ?,
        assigned_to = ?, location = ?, notes = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      asset_tag.substring(0, 50), name.substring(0, 200), category,
      (manufacturer || '').substring(0, 100) || null, (model || '').substring(0, 100) || null,
      (serial_number || '').substring(0, 100) || null, safeStatus, safeCondition,
      safeDate(purchase_date), purchase_price !== undefined && purchase_price !== '' ? safePositiveFloat(purchase_price) : null,
      safeDate(warranty_expiry), updateAssignee,
      (location || '').substring(0, 100) || null, (notes || '').substring(0, 2000) || null, id
    );

    req.audit('update', 'asset', id, `Updated asset ${asset_tag}`);
    req.flash('success', 'Asset updated successfully');
    res.redirect(`/assets/${id}`);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      req.flash('error', 'Asset tag or serial number already exists');
    } else {
      console.error('Asset update error:', err.message);
      req.flash('error', 'Error updating asset. Please check your input and try again.');
    }
    res.redirect(`/assets/${id}/edit`);
  }
});

// Delete asset
router.delete('/:id', requireRole('admin', 'manager'), (req, res) => {
  const id = safeId(req.params.id);
  if (!id) { req.flash('error', 'Invalid asset ID'); return res.redirect('/assets'); }

  try {
    const deleteStmt = db.transaction(() => {
      db.prepare('UPDATE tickets SET asset_id = NULL WHERE asset_id = ?').run(id);
      const result = db.prepare('DELETE FROM assets WHERE id = ?').run(id);
      return result.changes;
    });
    const changes = deleteStmt();
    if (changes === 0) {
      req.flash('error', 'Asset not found');
    } else {
      req.audit('delete', 'asset', id, 'Deleted asset');
      req.flash('success', 'Asset deleted');
    }
  } catch (err) {
    console.error('Asset delete error:', err.message);
    req.flash('error', 'Error deleting asset');
  }
  res.redirect('/assets');
});

module.exports = router;
