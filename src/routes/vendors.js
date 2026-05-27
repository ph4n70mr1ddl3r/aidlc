const db = require('../models/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { paginate, paginationBaseUrl, addSearch, buildFilters, safeId, safeInt } = require('../utils');

const router = require('express').Router();
router.use(requireAuth, auditMiddleware);

const VALID_CATEGORIES_VENDOR = ['Hardware', 'Cloud', 'Security', 'Network', 'Maintenance', 'Software', 'Consulting', 'Telecom', 'Other'];

// List vendors (paginated)
router.get('/', (req, res) => {
  const { page, limit, offset } = paginate(req);

  const filters = buildFilters({
    'v.category': { value: VALID_CATEGORIES_VENDOR.includes(req.query.category) ? req.query.category : '' },
  });

  const where = [...filters.where];
  const params = [...filters.params];
  addSearch(where, params, req.query.search, ['v.name', 'v.contact_person', 'v.email']);

  const whereClause = where.length ? where.join(' AND ') : '1=1';

  const total = db.prepare(`SELECT COUNT(*) as c FROM vendors v WHERE ${whereClause}`).get(...params).c;
  const totalPages = Math.ceil(total / limit) || 1;

  const vendors = db.prepare(`
    SELECT * FROM vendors v WHERE ${whereClause} ORDER BY v.name ASC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  res.render('pages/vendors/index', {
    title: 'Vendors', vendors, filters: req.query,
    page, totalPages, total,
    baseUrl: paginationBaseUrl(req),
  });
});

// New vendor
router.get('/new', requireRole('admin', 'manager'), (req, res) => {
  res.render('pages/vendors/form', { title: 'New Vendor', vendor: {}, isEdit: false });
});

// Create vendor
router.post('/', requireRole('admin', 'manager'), (req, res) => {
  const { name, contact_person, email, phone, address, website, category, contract_start, contract_end, notes, rating } = req.body;

  if (!name) {
    req.flash('error', 'Vendor name is required');
    return res.redirect('/vendors/new');
  }

  if (category && !VALID_CATEGORIES_VENDOR.includes(category)) {
    req.flash('error', 'Invalid category');
    return res.redirect('/vendors/new');
  }

  const safeCategory = VALID_CATEGORIES_VENDOR.includes(category) ? category : null;

  try {
    const result = db.prepare(`
      INSERT INTO vendors (name, contact_person, email, phone, address, website, category, contract_start, contract_end, notes, rating)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name.substring(0, 200), (contact_person || '').substring(0, 100) || null, (email || '').substring(0, 200) || null, (phone || '').substring(0, 50) || null, (address || '').substring(0, 500) || null,
      (website || '').substring(0, 500) || null, safeCategory, contract_start || null, contract_end || null,
      (notes || '').substring(0, 2000) || null, rating ? Math.max(1, Math.min(5, safeInt(rating, 0))) : null);

    req.audit('create', 'vendor', result.lastInsertRowid, `Created vendor ${name}`);
    req.flash('success', `Vendor ${name} created`);
    res.redirect('/vendors');
  } catch (err) {
    req.flash('error', 'Error creating vendor. Please try again.');
    res.redirect('/vendors/new');
  }
});

// Show vendor
router.get('/:id', (req, res) => {
  const id = safeId(req.params.id);
  if (!id) { req.flash('error', 'Invalid vendor ID'); return res.redirect('/vendors'); }

  const vendor = db.prepare('SELECT * FROM vendors WHERE id = ?').get(id);
  if (!vendor) {
    req.flash('error', 'Vendor not found');
    return res.redirect('/vendors');
  }
  res.render('pages/vendors/show', { title: vendor.name, vendor });
});

// Edit vendor
router.get('/:id/edit', requireRole('admin', 'manager'), (req, res) => {
  const id = safeId(req.params.id);
  if (!id) { req.flash('error', 'Invalid vendor ID'); return res.redirect('/vendors'); }

  const vendor = db.prepare('SELECT * FROM vendors WHERE id = ?').get(id);
  if (!vendor) {
    req.flash('error', 'Vendor not found');
    return res.redirect('/vendors');
  }
  res.render('pages/vendors/form', { title: 'Edit Vendor', vendor, isEdit: true });
});

// Update vendor
router.put('/:id', requireRole('admin', 'manager'), (req, res) => {
  const id = safeId(req.params.id);
  if (!id) { req.flash('error', 'Invalid vendor ID'); return res.redirect('/vendors'); }

  const { name, contact_person, email, phone, address, website, category, contract_start, contract_end, notes, rating, is_active } = req.body;

  const safeCategory = VALID_CATEGORIES_VENDOR.includes(category) ? category : null;

  try {
    db.prepare(`
      UPDATE vendors SET name = ?, contact_person = ?, email = ?, phone = ?, address = ?,
        website = ?, category = ?, contract_start = ?, contract_end = ?, notes = ?, rating = ?,
        is_active = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(name.substring(0, 200), (contact_person || '').substring(0, 100) || null, (email || '').substring(0, 200) || null, (phone || '').substring(0, 50) || null, (address || '').substring(0, 500) || null,
      (website || '').substring(0, 500) || null, safeCategory,
      contract_start || null, contract_end || null, (notes || '').substring(0, 2000) || null,
      rating ? Math.max(1, Math.min(5, safeInt(rating, 0))) : null,
      is_active ? 1 : 0, id);

    req.audit('update', 'vendor', id, `Updated vendor ${name}`);
    req.flash('success', 'Vendor updated');
    res.redirect(`/vendors/${id}`);
  } catch (err) {
    req.flash('error', 'Error updating vendor. Please try again.');
    res.redirect(`/vendors/${id}/edit`);
  }
});

// Delete vendor
router.delete('/:id', requireRole('admin', 'manager'), (req, res) => {
  const id = safeId(req.params.id);
  if (!id) { req.flash('error', 'Invalid vendor ID'); return res.redirect('/vendors'); }

  try {
    db.prepare('DELETE FROM vendors WHERE id = ?').run(id);
    req.audit('delete', 'vendor', id, 'Deleted vendor');
    req.flash('success', 'Vendor deleted');
  } catch (err) {
    req.flash('error', 'Error deleting vendor');
  }
  res.redirect('/vendors');
});

module.exports = router;
