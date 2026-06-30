const db = require('../models/database');
const { requireAuth, requireAdminOrManager } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { paginate, paginationBaseUrl, addSearch, buildFilters, safeId, safePositiveFloat, safeDate, trim, getActiveStaff, isActiveUser, countQuery, selectQuery, safeQueryValue } = require('../utils');
const { ASSET_CATEGORIES: VALID_CATEGORIES, ASSET_STATUSES: VALID_STATUSES, ASSET_CONDITIONS: VALID_CONDITIONS, MAX_MEDIUM_STR, MAX_SHORT_STR, MAX_NOTES, MAX_ASSET_TAG } = require('../constants');
const { invalidateDashboardCache } = require('./dashboard');
const rateLimit = require('express-rate-limit');

// Rate limit asset write operations to prevent abuse
const assetWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50,
  message: 'Too many asset operations. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});

const router = require('express').Router();
router.use(requireAuth, auditMiddleware);

// Cached prepared statements for show/edit/delete routes (static SQL).
// List/index queries build dynamic WHERE clauses so can't be cached.
const _showStmt = db.prepare(`
    SELECT a.*, u.first_name || ' ' || u.last_name as assigned_name, u.email as assigned_email
    FROM assets a
    LEFT JOIN users u ON a.assigned_to = u.id
    WHERE a.id = ?
  `);
const _relatedTicketsStmt = db.prepare(`
    SELECT id, ticket_number, title, status, priority, created_at
    FROM tickets WHERE asset_id = ? ORDER BY created_at DESC LIMIT 10
  `);
const _editStmt = db.prepare('SELECT * FROM assets WHERE id = ?');
const _deleteDetachTicketsStmt = db.prepare('UPDATE tickets SET asset_id = NULL WHERE asset_id = ?');
const _deleteStmt = db.prepare('DELETE FROM assets WHERE id = ?');
const _insertStmt = db.prepare(`
    INSERT INTO assets (asset_tag, name, category, manufacturer, model, serial_number,
      status, condition_rating, purchase_date, purchase_price, warranty_expiry,
      assigned_to, location, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
const _assetExistsStmt = db.prepare('SELECT id FROM assets WHERE id = ?');
const _updateStmt = db.prepare(`
    UPDATE assets SET asset_tag = ?, name = ?, category = ?, manufacturer = ?,
      model = ?, serial_number = ?, status = ?, condition_rating = ?,
      purchase_date = ?, purchase_price = ?, warranty_expiry = ?,
      assigned_to = ?, location = ?, notes = ?, updated_at = datetime('now')
    WHERE id = ?
  `);

// Asset counter for atomic tag generation (prevents race conditions)
const _assetCounterGetStmt = db.prepare(`
    INSERT INTO asset_counter (counter_key, next_seq)
    VALUES ('asset_tag', 1)
    ON CONFLICT(counter_key) DO UPDATE SET next_seq = next_seq + 1
    RETURNING next_seq
  `);
// Read-only preview of next tag (does NOT increment the counter)
const _assetCounterPreviewStmt = db.prepare(`
    SELECT COALESCE(MAX(next_seq), 0) + 1 as next_seq FROM asset_counter WHERE counter_key = 'asset_tag'
  `);

// List assets (paginated)
router.get('/', (req, res) => {
  const { page, limit, offset } = paginate(req);

  const filters = buildFilters({
    'a.category': { value: VALID_CATEGORIES.includes(safeQueryValue(req.query.category)) ? safeQueryValue(req.query.category) : '' },
    'a.status': { value: VALID_STATUSES.includes(safeQueryValue(req.query.status)) ? safeQueryValue(req.query.status) : '' },
    'a.assigned_to': { value: safeQueryValue(req.query.assigned_to) ? safeId(safeQueryValue(req.query.assigned_to)) || '' : '' }
  }, ['a.category', 'a.status', 'a.assigned_to']);

  const where = [...filters.where];
  const params = [...filters.params];
  addSearch(where, params, safeQueryValue(req.query.search), ['a.name', 'a.asset_tag', 'a.serial_number', 'a.manufacturer']);

  const whereClause = where.length ? where.join(' AND ') : '1=1';

  const total = countQuery(db, 'assets', 'a', whereClause, params);
  const totalPages = Math.ceil(total / limit) || 1;

  const assets = selectQuery(db, `
    SELECT a.*, u.first_name || ' ' || u.last_name as assigned_name
    FROM assets a
    LEFT JOIN users u ON a.assigned_to = u.id
    WHERE ${whereClause}
    ORDER BY a.name ASC
    LIMIT ? OFFSET ?
  `, [...params, limit, offset]);

  const staff = getActiveStaff(db);

  res.render('pages/assets/index', {
    title: 'Assets', assets, staff, filters: req.query,
    page, limit, totalPages, total,
    baseUrl: paginationBaseUrl(req)
  });
});

// New asset form
router.get('/new', requireAdminOrManager, (req, res) => {
  const staff = getActiveStaff(db);
  // Preview tag only — use read-only SELECT to avoid incrementing the counter
  const previewRow = _assetCounterPreviewStmt.get();
  const previewTag = 'AST-' + String(previewRow.next_seq).padStart(3, '0');
  res.render('pages/assets/form', { title: 'New Asset', asset: { asset_tag: previewTag }, staff, isEdit: false });
});

// Create asset
router.post('/', requireAdminOrManager, assetWriteLimiter, (req, res) => {
  const name = trim(safeQueryValue(req.body.name));
  const category = trim(safeQueryValue(req.body.category));
  const manufacturer = trim(safeQueryValue(req.body.manufacturer));
  const model = trim(safeQueryValue(req.body.model));
  const serial_number = trim(safeQueryValue(req.body.serial_number));
  const status = trim(safeQueryValue(req.body.status));
  const condition_rating = trim(safeQueryValue(req.body.condition_rating));
  const purchase_date = safeQueryValue(req.body.purchase_date);
  const purchase_price = safeQueryValue(req.body.purchase_price);
  const warranty_expiry = safeQueryValue(req.body.warranty_expiry);
  const assigned_to = safeQueryValue(req.body.assigned_to);
  const location = trim(safeQueryValue(req.body.location));
  const notes = trim(safeQueryValue(req.body.notes));

  if (!name || !category) {
    req.flash('error', 'Name and category are required');
    return res.redirect('/assets/new');
  }
  if (name.length > MAX_MEDIUM_STR) {
    req.flash('error', `Asset name must be at most ${MAX_MEDIUM_STR} characters`);
    return res.redirect('/assets/new');
  }
  if (manufacturer && manufacturer.length > MAX_SHORT_STR) {
    req.flash('error', `Manufacturer must be at most ${MAX_SHORT_STR} characters`);
    return res.redirect('/assets/new');
  }
  if (model && model.length > MAX_SHORT_STR) {
    req.flash('error', `Model must be at most ${MAX_SHORT_STR} characters`);
    return res.redirect('/assets/new');
  }
  if (serial_number && serial_number.length > MAX_SHORT_STR) {
    req.flash('error', `Serial number must be at most ${MAX_SHORT_STR} characters`);
    return res.redirect('/assets/new');
  }
  if (location && location.length > MAX_SHORT_STR) {
    req.flash('error', `Location must be at most ${MAX_SHORT_STR} characters`);
    return res.redirect('/assets/new');
  }
  if (notes && notes.length > MAX_NOTES) {
    req.flash('error', `Notes must be at most ${MAX_NOTES} characters`);
    return res.redirect('/assets/new');
  }

  if (!VALID_CATEGORIES.includes(category)) {
    req.flash('error', 'Invalid category');
    return res.redirect('/assets/new');
  }
  if (!VALID_STATUSES.includes(status)) {
    req.flash('error', 'Invalid status');
    return res.redirect('/assets/new');
  }
  if (condition_rating && !VALID_CONDITIONS.includes(condition_rating)) {
    req.flash('error', 'Invalid condition rating');
    return res.redirect('/assets/new');
  }
  const safeCondition = condition_rating || 'good';

  // Validate assignee is an active user
  const createAssignee = assigned_to ? safeId(assigned_to) : null;
  if (createAssignee && !isActiveUser(db, createAssignee)) {
    req.flash('error', 'Selected assignee is not available');
    return res.redirect('/assets/new');
  }

  try {
    // Generate asset tag atomically using dedicated counter table
    const createAsset = db.transaction(() => {
      const counterRow = _assetCounterGetStmt.get();
      const asset_tag = ('AST-' + String(counterRow.next_seq).padStart(3, '0')).substring(0, MAX_ASSET_TAG);

      const result = _insertStmt.run(
        asset_tag, name.substring(0, MAX_MEDIUM_STR), category, (manufacturer || '').substring(0, MAX_SHORT_STR) || null,
        (model || '').substring(0, MAX_SHORT_STR) || null, (serial_number || '').substring(0, MAX_SHORT_STR) || null,
        status, safeCondition, safeDate(purchase_date),
        safePositiveFloat(purchase_price),
        safeDate(warranty_expiry), createAssignee, (location || '').substring(0, MAX_SHORT_STR) || null, (notes || '').substring(0, MAX_NOTES) || null
      );
      return { asset_tag, id: result.lastInsertRowid };
    });

    const { asset_tag, id } = createAsset();
    req.audit('create', 'asset', id, `Created asset ${asset_tag}`);
    req.flash('success', `Asset ${asset_tag} created successfully`);
    invalidateDashboardCache();
    res.redirect('/assets');
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
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
  if (!id) {
    req.flash('error', 'Invalid asset ID');
    return res.redirect('/assets');
  }

  const asset = _showStmt.get(id);

  if (!asset) {
    req.flash('error', 'Asset not found');
    return res.redirect('/assets');
  }

  const relatedTickets = _relatedTicketsStmt.all(id);

  res.render('pages/assets/show', { title: asset.name, asset, relatedTickets });
});

// Edit asset form
router.get('/:id/edit', requireAdminOrManager, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid asset ID');
    return res.redirect('/assets');
  }

  const asset = _editStmt.get(id);
  if (!asset) {
    req.flash('error', 'Asset not found');
    return res.redirect('/assets');
  }
  const staff = getActiveStaff(db);
  res.render('pages/assets/form', { title: 'Edit Asset', asset, staff, isEdit: true });
});

// Update asset
router.put('/:id', requireAdminOrManager, assetWriteLimiter, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid asset ID');
    return res.redirect('/assets');
  }

  const asset_tag = trim(safeQueryValue(req.body.asset_tag));
  const name = trim(safeQueryValue(req.body.name));
  const category = trim(safeQueryValue(req.body.category));
  const manufacturer = trim(safeQueryValue(req.body.manufacturer));
  const model = trim(safeQueryValue(req.body.model));
  const serial_number = trim(safeQueryValue(req.body.serial_number));
  const status = trim(safeQueryValue(req.body.status));
  const condition_rating = trim(safeQueryValue(req.body.condition_rating));
  const purchase_date = safeQueryValue(req.body.purchase_date);
  const purchase_price = safeQueryValue(req.body.purchase_price);
  const warranty_expiry = safeQueryValue(req.body.warranty_expiry);
  const assigned_to = safeQueryValue(req.body.assigned_to);
  const location = trim(safeQueryValue(req.body.location));
  const notes = trim(safeQueryValue(req.body.notes));

  if (!asset_tag || !name || !category) {
    req.flash('error', 'Asset tag, name, and category are required');
    return res.redirect(`/assets/${id}/edit`);
  }
  if (!/^AST-\d{3,}$/.test(asset_tag) || asset_tag.length > MAX_ASSET_TAG) {
    req.flash('error', 'Asset tag must match format AST-XXX (e.g. AST-001)');
    return res.redirect(`/assets/${id}/edit`);
  }
  if (name.length > MAX_MEDIUM_STR) {
    req.flash('error', `Asset name must be at most ${MAX_MEDIUM_STR} characters`);
    return res.redirect(`/assets/${id}/edit`);
  }
  if (manufacturer && manufacturer.length > MAX_SHORT_STR) {
    req.flash('error', `Manufacturer must be at most ${MAX_SHORT_STR} characters`);
    return res.redirect(`/assets/${id}/edit`);
  }
  if (model && model.length > MAX_SHORT_STR) {
    req.flash('error', `Model must be at most ${MAX_SHORT_STR} characters`);
    return res.redirect(`/assets/${id}/edit`);
  }
  if (serial_number && serial_number.length > MAX_SHORT_STR) {
    req.flash('error', `Serial number must be at most ${MAX_SHORT_STR} characters`);
    return res.redirect(`/assets/${id}/edit`);
  }
  if (location && location.length > MAX_SHORT_STR) {
    req.flash('error', `Location must be at most ${MAX_SHORT_STR} characters`);
    return res.redirect(`/assets/${id}/edit`);
  }
  if (notes && notes.length > MAX_NOTES) {
    req.flash('error', `Notes must be at most ${MAX_NOTES} characters`);
    return res.redirect(`/assets/${id}/edit`);
  }
  if (!VALID_CATEGORIES.includes(category)) {
    req.flash('error', 'Invalid category');
    return res.redirect(`/assets/${id}/edit`);
  }
  if (!VALID_STATUSES.includes(status)) {
    req.flash('error', 'Invalid status');
    return res.redirect(`/assets/${id}/edit`);
  }
  if (condition_rating && !VALID_CONDITIONS.includes(condition_rating)) {
    req.flash('error', 'Invalid condition rating');
    return res.redirect(`/assets/${id}/edit`);
  }
  const safeCondition = condition_rating || 'good';

  // Validate assignee is an active user
  const updateAssignee = assigned_to ? safeId(assigned_to) : null;
  if (updateAssignee && !isActiveUser(db, updateAssignee)) {
    req.flash('error', 'Selected assignee is not available');
    return res.redirect(`/assets/${id}/edit`);
  }

  try {
    // Verify asset exists before updating
    const existing = _assetExistsStmt.get(id);
    if (!existing) {
      req.flash('error', 'Asset not found');
      return res.redirect('/assets');
    }

    const result = _updateStmt.run(
      asset_tag.substring(0, MAX_ASSET_TAG), name.substring(0, MAX_MEDIUM_STR), category,
      (manufacturer || '').substring(0, MAX_SHORT_STR) || null, (model || '').substring(0, MAX_SHORT_STR) || null,
      (serial_number || '').substring(0, MAX_SHORT_STR) || null, status, safeCondition,
      safeDate(purchase_date), safePositiveFloat(purchase_price),
      safeDate(warranty_expiry), updateAssignee,
      (location || '').substring(0, MAX_SHORT_STR) || null, (notes || '').substring(0, MAX_NOTES) || null, id
    );

    if (result.changes === 0) {
      req.flash('error', 'Asset not found');
      return res.redirect('/assets');
    }

    req.audit('update', 'asset', id, `Updated asset ${asset_tag}`);
    req.flash('success', 'Asset updated successfully');
    invalidateDashboardCache();
    res.redirect(`/assets/${id}`);
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      req.flash('error', 'Asset tag or serial number already exists');
    } else {
      console.error('Asset update error:', err.message);
      req.flash('error', 'Error updating asset. Please check your input and try again.');
    }
    res.redirect(`/assets/${id}/edit`);
  }
});

// Delete asset
router.delete('/:id', requireAdminOrManager, assetWriteLimiter, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid asset ID');
    return res.redirect('/assets');
  }

  try {
    const deleteStmt = db.transaction(() => {
      _deleteDetachTicketsStmt.run(id);
      const result = _deleteStmt.run(id);
      return result.changes;
    });
    const changes = deleteStmt();
    if (changes === 0) {
      req.flash('error', 'Asset not found');
    } else {
      req.audit('delete', 'asset', id, 'Deleted asset');
      req.flash('success', 'Asset deleted');
      invalidateDashboardCache();
    }
  } catch (err) {
    console.error('Asset delete error:', err.message);
    req.flash('error', 'Error deleting asset');
  }
  res.redirect('/assets');
});

module.exports = router;
