const db = require('../models/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { paginate, paginationBaseUrl, addSearch, buildFilters } = require('../utils');

const router = require('express').Router();
router.use(requireAuth, auditMiddleware);

// Allowed filter values (whitelist)
const VALID_CATEGORIES = ['laptop','desktop','server','monitor','printer','network','phone','tablet','software','peripheral','other'];
const VALID_STATUSES = ['in_use','in_storage','in_repair','disposed','reserved'];

// List assets (paginated)
router.get('/', (req, res) => {
  const { page, limit, offset } = paginate(req);

  const filters = buildFilters({
    'a.category': { value: VALID_CATEGORIES.includes(req.query.category) ? req.query.category : '' },
    'a.status': { value: VALID_STATUSES.includes(req.query.status) ? req.query.status : '' },
    'a.assigned_to': { value: req.query.assigned_to ? parseInt(req.query.assigned_to) || '' : '' },
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

  const staff = db.prepare('SELECT id, first_name, last_name FROM users WHERE is_active = 1 ORDER BY first_name').all();

  res.render('pages/assets/index', {
    title: 'Assets', assets, staff, filters: req.query,
    page, totalPages, total,
    baseUrl: paginationBaseUrl(req),
  });
});

// New asset form
router.get('/new', requireRole('admin', 'manager'), (req, res) => {
  const staff = db.prepare('SELECT id, first_name, last_name FROM users WHERE is_active = 1 ORDER BY first_name').all();
  res.render('pages/assets/form', { title: 'New Asset', asset: {}, staff, isEdit: false });
});

// Create asset
router.post('/', requireRole('admin', 'manager'), (req, res) => {
  const { asset_tag, name, category, manufacturer, model, serial_number, status,
          condition_rating, purchase_date, purchase_price, warranty_expiry,
          assigned_to, location, notes } = req.body;

  if (!asset_tag || !name || !category) {
    req.flash('error', 'Asset tag, name, and category are required');
    return res.redirect('/assets/new');
  }

  if (!VALID_CATEGORIES.includes(category)) {
    req.flash('error', 'Invalid category');
    return res.redirect('/assets/new');
  }

  try {
    const result = db.prepare(`
      INSERT INTO assets (asset_tag, name, category, manufacturer, model, serial_number,
        status, condition_rating, purchase_date, purchase_price, warranty_expiry,
        assigned_to, location, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(asset_tag, name, category, manufacturer || null, model || null, serial_number || null,
      status || 'in_storage', condition_rating || 'good', purchase_date || null,
      purchase_price ? parseFloat(purchase_price) : null,
      warranty_expiry || null, assigned_to || null, location || null, notes || null);

    req.audit('create', 'asset', result.lastInsertRowid, `Created asset ${asset_tag}`);
    req.flash('success', `Asset ${asset_tag} created successfully`);
    res.redirect('/assets');
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      req.flash('error', 'Asset tag or serial number already exists');
    } else {
      req.flash('error', 'Error creating asset. Please check your input and try again.');
    }
    res.redirect('/assets/new');
  }
});

// Show asset
router.get('/:id', (req, res) => {
  const asset = db.prepare(`
    SELECT a.*, u.first_name || ' ' || u.last_name as assigned_name, u.email as assigned_email
    FROM assets a
    LEFT JOIN users u ON a.assigned_to = u.id
    WHERE a.id = ?
  `).get(req.params.id);

  if (!asset) {
    req.flash('error', 'Asset not found');
    return res.redirect('/assets');
  }

  const relatedTickets = db.prepare(`
    SELECT id, ticket_number, title, status, priority, created_at
    FROM tickets WHERE asset_id = ? ORDER BY created_at DESC LIMIT 10
  `).all(req.params.id);

  res.render('pages/assets/show', { title: asset.name, asset, relatedTickets });
});

// Edit asset form
router.get('/:id/edit', requireRole('admin', 'manager'), (req, res) => {
  const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id);
  if (!asset) {
    req.flash('error', 'Asset not found');
    return res.redirect('/assets');
  }
  const staff = db.prepare('SELECT id, first_name, last_name FROM users WHERE is_active = 1 ORDER BY first_name').all();
  res.render('pages/assets/form', { title: 'Edit Asset', asset, staff, isEdit: true });
});

// Update asset
router.put('/:id', requireRole('admin', 'manager'), (req, res) => {
  const { asset_tag, name, category, manufacturer, model, serial_number, status,
          condition_rating, purchase_date, purchase_price, warranty_expiry,
          assigned_to, location, notes } = req.body;

  try {
    db.prepare(`
      UPDATE assets SET asset_tag = ?, name = ?, category = ?, manufacturer = ?,
        model = ?, serial_number = ?, status = ?, condition_rating = ?,
        purchase_date = ?, purchase_price = ?, warranty_expiry = ?,
        assigned_to = ?, location = ?, notes = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(asset_tag, name, category, manufacturer || null, model || null, serial_number || null,
      status, condition_rating, purchase_date || null,
      purchase_price ? parseFloat(purchase_price) : null,
      warranty_expiry || null, assigned_to || null, location || null, notes || null, req.params.id);

    req.audit('update', 'asset', parseInt(req.params.id), `Updated asset ${asset_tag}`);
    req.flash('success', 'Asset updated successfully');
    res.redirect(`/assets/${req.params.id}`);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      req.flash('error', 'Asset tag or serial number already exists');
    } else {
      req.flash('error', 'Error updating asset. Please check your input and try again.');
    }
    res.redirect(`/assets/${req.params.id}/edit`);
  }
});

// Delete asset
router.delete('/:id', requireRole('admin', 'manager'), (req, res) => {
  try {
    const deleteStmt = db.transaction(() => {
      db.prepare('UPDATE tickets SET asset_id = NULL WHERE asset_id = ?').run(req.params.id);
      db.prepare('DELETE FROM assets WHERE id = ?').run(req.params.id);
    });
    deleteStmt();
    req.audit('delete', 'asset', parseInt(req.params.id), 'Deleted asset');
    req.flash('success', 'Asset deleted');
  } catch (err) {
    req.flash('error', 'Error deleting asset');
  }
  res.redirect('/assets');
});

module.exports = router;
