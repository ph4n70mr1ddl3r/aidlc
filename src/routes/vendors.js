const db = require('../models/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { paginate, paginationBaseUrl, addSearch, buildFilters, safeId, safeInt, isValidEmail, isValidUrl, safeDate, trim } = require('../utils');
const { VENDOR_CATEGORIES: VALID_CATEGORIES_VENDOR } = require('../constants');

const router = require('express').Router();
router.use(requireAuth, auditMiddleware);

// List vendors (paginated)
router.get('/', (req, res) => {
  const { page, limit, offset } = paginate(req);

  const filters = buildFilters({
    'v.category': { value: VALID_CATEGORIES_VENDOR.includes(req.query.category) ? req.query.category : '' },
    'v.is_active': { value: req.query.is_active === '1' ? 1 : req.query.is_active === '0' ? 0 : '' },
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
  const name = trim(req.body.name);
  const contact_person = trim(req.body.contact_person);
  const email = trim(req.body.email);
  const phone = trim(req.body.phone);
  const address = trim(req.body.address);
  const website = trim(req.body.website);
  const { category, contract_start, contract_end } = req.body;
  const notes = trim(req.body.notes);
  const { rating } = req.body;

  if (!name) {
    req.flash('error', 'Vendor name is required');
    return res.redirect('/vendors/new');
  }

  if (email && !isValidEmail(email)) {
    req.flash('error', 'Please enter a valid email address');
    return res.redirect('/vendors/new');
  }

  if (website && !isValidUrl(website)) {
    req.flash('error', 'Website must be a valid http/https URL');
    return res.redirect('/vendors/new');
  }

  if (category && !VALID_CATEGORIES_VENDOR.includes(category)) {
    req.flash('error', 'Invalid category');
    return res.redirect('/vendors/new');
  }

  const safeCategory = VALID_CATEGORIES_VENDOR.includes(category) ? category : null;

  const sContractStart = safeDate(contract_start);
  const sContractEnd = safeDate(contract_end);
  if (sContractStart && sContractEnd && sContractEnd < sContractStart) {
    req.flash('error', 'Contract end must be on or after contract start');
    return res.redirect('/vendors/new');
  }

  try {
    const result = db.prepare(`
      INSERT INTO vendors (name, contact_person, email, phone, address, website, category, contract_start, contract_end, notes, rating)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name.substring(0, 200), (contact_person || '').substring(0, 100) || null, (email || '').substring(0, 200) || null, (phone || '').substring(0, 50) || null, (address || '').substring(0, 500) || null,
      (website || '').substring(0, 500) || null, safeCategory, sContractStart, sContractEnd,
      (notes || '').substring(0, 2000) || null, rating ? Math.max(1, Math.min(5, safeInt(rating, 0))) : null);

    req.audit('create', 'vendor', result.lastInsertRowid, `Created vendor ${name}`);
    req.flash('success', `Vendor ${name} created`);
    res.redirect('/vendors');
  } catch (err) {
    console.error('Vendor create error:', err.message);
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

  const name = trim(req.body.name);
  const contact_person = trim(req.body.contact_person);
  const email = trim(req.body.email);
  const phone = trim(req.body.phone);
  const address = trim(req.body.address);
  const website = trim(req.body.website);
  const { category, contract_start, contract_end } = req.body;
  const notes = trim(req.body.notes);
  const { rating } = req.body;

  if (!name) {
    req.flash('error', 'Vendor name is required');
    return res.redirect(`/vendors/${id}/edit`);
  }
  if (email && !isValidEmail(email)) {
    req.flash('error', 'Please enter a valid email address');
    return res.redirect(`/vendors/${id}/edit`);
  }
  if (website && !isValidUrl(website)) {
    req.flash('error', 'Website must be a valid http/https URL');
    return res.redirect(`/vendors/${id}/edit`);
  }
  const safeCategory = VALID_CATEGORIES_VENDOR.includes(category) ? category : null;

  const sContractStart = safeDate(contract_start);
  const sContractEnd = safeDate(contract_end);
  if (sContractStart && sContractEnd && sContractEnd < sContractStart) {
    req.flash('error', 'Contract end must be on or after contract start');
    return res.redirect(`/vendors/${id}/edit`);
  }

  try {
    // Verify vendor exists before updating
    const existing = db.prepare('SELECT id, is_active FROM vendors WHERE id = ?').get(id);
    if (!existing) { req.flash('error', 'Vendor not found'); return res.redirect('/vendors'); }

    // Disallow deactivation via edit form — use dedicated route instead to ensure
    // any future cleanup logic (unassignment, notifications) runs consistently.

    db.prepare(`
      UPDATE vendors SET name = ?, contact_person = ?, email = ?, phone = ?, address = ?,
        website = ?, category = ?, contract_start = ?, contract_end = ?, notes = ?, rating = ?,
        is_active = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(name.substring(0, 200), (contact_person || '').substring(0, 100) || null, (email || '').substring(0, 200) || null, (phone || '').substring(0, 50) || null, (address || '').substring(0, 500) || null,
      (website || '').substring(0, 500) || null, safeCategory,
      sContractStart, sContractEnd, (notes || '').substring(0, 2000) || null,
      rating ? Math.max(1, Math.min(5, safeInt(rating, 0))) : null,
      1, id);

    req.audit('update', 'vendor', id, `Updated vendor ${name}`);
    req.flash('success', 'Vendor updated');
    res.redirect(`/vendors/${id}`);
  } catch (err) {
    console.error('Vendor update error:', err.message);
    req.flash('error', 'Error updating vendor. Please try again.');
    res.redirect(`/vendors/${id}/edit`);
  }
});

// Deactivate vendor (dedicated route — mirrors staff pattern)
router.put('/:id/deactivate', requireRole('admin', 'manager'), (req, res) => {
  const id = safeId(req.params.id);
  if (!id) { req.flash('error', 'Invalid vendor ID'); return res.redirect('/vendors'); }

  try {
    const existing = db.prepare('SELECT is_active FROM vendors WHERE id = ?').get(id);
    if (!existing) { req.flash('error', 'Vendor not found'); return res.redirect('/vendors'); }
    if (!existing.is_active) { req.flash('info', 'Vendor is already inactive'); return res.redirect(`/vendors/${id}`); }

    db.prepare(`UPDATE vendors SET is_active = 0, updated_at = datetime('now') WHERE id = ?`).run(id);
    req.audit('deactivate', 'vendor', id, 'Deactivated vendor');
    req.flash('success', 'Vendor deactivated');
  } catch (err) {
    console.error('Vendor deactivate error:', err.message);
    req.flash('error', 'Error deactivating vendor');
  }
  res.redirect(`/vendors/${id}`);
});

// Reactivate vendor
router.put('/:id/reactivate', requireRole('admin', 'manager'), (req, res) => {
  const id = safeId(req.params.id);
  if (!id) { req.flash('error', 'Invalid vendor ID'); return res.redirect('/vendors'); }

  try {
    const existing = db.prepare('SELECT is_active FROM vendors WHERE id = ?').get(id);
    if (!existing) { req.flash('error', 'Vendor not found'); return res.redirect('/vendors'); }
    if (existing.is_active) { req.flash('info', 'Vendor is already active'); return res.redirect(`/vendors/${id}`); }

    db.prepare(`UPDATE vendors SET is_active = 1, updated_at = datetime('now') WHERE id = ?`).run(id);
    req.audit('reactivate', 'vendor', id, 'Reactivated vendor');
    req.flash('success', 'Vendor reactivated');
  } catch (err) {
    console.error('Vendor reactivate error:', err.message);
    req.flash('error', 'Error reactivating vendor');
  }
  res.redirect(`/vendors/${id}`);
});

// Delete vendor
router.delete('/:id', requireRole('admin', 'manager'), (req, res) => {
  const id = safeId(req.params.id);
  if (!id) { req.flash('error', 'Invalid vendor ID'); return res.redirect('/vendors'); }

  try {
    const result = db.prepare('DELETE FROM vendors WHERE id = ?').run(id);
    if (result.changes === 0) {
      req.flash('error', 'Vendor not found');
    } else {
      req.audit('delete', 'vendor', id, 'Deleted vendor');
      req.flash('success', 'Vendor deleted');
    }
  } catch (err) {
    console.error('Vendor delete error:', err.message);
    req.flash('error', 'Error deleting vendor');
  }
  res.redirect('/vendors');
});

module.exports = router;
