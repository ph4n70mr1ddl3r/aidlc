const db = require('../models/database');
const { requireAuth, requireAdminOrManager } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { paginate, paginationBaseUrl, addSearch, buildFilters, safeId, safePositiveFloat, safeInt, safeDate, trim } = require('../utils');
const { LICENSE_TYPES: VALID_LICENSE_TYPES } = require('../constants');

const router = require('express').Router();
router.use(requireAuth, auditMiddleware);

// Cached prepared statements for show/edit routes (static SQL).
const _showLicenseStmt = db.prepare('SELECT * FROM licenses WHERE id = ?');
const _editLicenseStmt = db.prepare('SELECT id, license_key FROM licenses WHERE id = ?');
const _deleteLicenseStmt = db.prepare('DELETE FROM licenses WHERE id = ?');

// Cached prepared statements for create/update routes
const _licenseInsertStmt = db.prepare(`
    INSERT INTO licenses (software_name, vendor, license_key, license_type, total_seats, used_seats, purchase_date, expiry_date, cost, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
const _licenseUpdateStmt = db.prepare(`
    UPDATE licenses SET software_name = ?, vendor = ?, license_key = ?, license_type = ?,
      total_seats = ?, used_seats = ?, purchase_date = ?, expiry_date = ?, cost = ?, notes = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `);

// List licenses (paginated)
router.get('/', (req, res) => {
  const { page, limit, offset } = paginate(req);

  const filters = buildFilters({
    'license_type': { value: VALID_LICENSE_TYPES.includes(req.query.license_type) ? req.query.license_type : '' }
  }, ['license_type']);

  const where = [...filters.where];
  const params = [...filters.params];
  addSearch(where, params, req.query.search, ['software_name', 'vendor']);

  const whereClause = where.length ? where.join(' AND ') : '1=1';

  const total = db.prepare(`SELECT COUNT(*) as c FROM licenses WHERE ${whereClause}`).get(...params).c;
  const totalPages = Math.ceil(total / limit) || 1;

  const licenses = db.prepare(`
    SELECT * FROM licenses WHERE ${whereClause} ORDER BY software_name ASC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  res.render('pages/licenses/index', {
    title: 'Software Licenses', licenses, filters: req.query,
    page, limit, totalPages, total,
    baseUrl: paginationBaseUrl(req)
  });
});

// New license
router.get('/new', requireAdminOrManager, (req, res) => {
  res.render('pages/licenses/form', { title: 'New License', license: {}, isEdit: false });
});

// Create license
router.post('/', requireAdminOrManager, (req, res) => {
  const software_name = trim(req.body.software_name);
  const vendor = trim(req.body.vendor);
  const license_key = trim(req.body.license_key);
  const { license_type, total_seats, used_seats, purchase_date, expiry_date, cost } = req.body;
  const notes = trim(req.body.notes);

  if (!software_name) {
    req.flash('error', 'Software name is required');
    return res.redirect('/licenses/new');
  }
  if (software_name.length > 200) {
    req.flash('error', 'Software name must be at most 200 characters');
    return res.redirect('/licenses/new');
  }

  if (license_type && !VALID_LICENSE_TYPES.includes(license_type)) {
    req.flash('error', 'Invalid license type');
    return res.redirect('/licenses/new');
  }

  const seats = Math.max(1, safeInt(total_seats, 1));
  const used = safeInt(used_seats, 0);
  if (used > seats) {
    req.flash('error', 'Used seats cannot exceed total seats');
    return res.redirect('/licenses/new');
  }
  const clampedUsed = Math.max(0, used);

  try {
    const result = _licenseInsertStmt.run(software_name.substring(0, 200), (vendor || '').substring(0, 200) || null, (license_key || '').substring(0, 500) || null, license_type || null,
      seats, clampedUsed,
      safeDate(purchase_date), safeDate(expiry_date), cost ? safePositiveFloat(cost) : null, (notes || '').substring(0, 2000) || null);

    req.audit('create', 'license', result.lastInsertRowid, `Created license for ${software_name}`);
    req.flash('success', `License for ${software_name} created`);
    res.redirect('/licenses');
  } catch (err) {
    console.error('License create error:', err.message);
    req.flash('error', 'Error creating license. Please try again.');
    res.redirect('/licenses/new');
  }
});

// Show license
router.get('/:id', (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid license ID'); return res.redirect('/licenses');
  }

  const license = _showLicenseStmt.get(id);
  if (!license) {
    req.flash('error', 'License not found');
    return res.redirect('/licenses');
  }
  res.render('pages/licenses/show', { title: license.software_name, license });
});

// AJAX endpoint for license key reveal (admin/manager only)
router.get('/:id/key', requireAdminOrManager, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'Invalid license ID' });
  }

  const license = _editLicenseStmt.get(id);
  if (!license) {
    return res.status(404).json({ error: 'License not found' });
  }
  res.json({ key: license.license_key || '' });
});

// Edit license
router.get('/:id/edit', requireAdminOrManager, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid license ID');
    return res.redirect('/licenses');
  }

  const license = _showLicenseStmt.get(id);
  if (!license) {
    req.flash('error', 'License not found');
    return res.redirect('/licenses');
  }
  res.render('pages/licenses/form', { title: 'Edit License', license, isEdit: true });
});

// Update license
router.put('/:id', requireAdminOrManager, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid license ID');
    return res.redirect('/licenses');
  }

  const software_name = trim(req.body.software_name);
  const vendor = trim(req.body.vendor);
  const license_key = trim(req.body.license_key);
  const { license_type, total_seats, used_seats, purchase_date, expiry_date, cost } = req.body;
  const notes = trim(req.body.notes);

  if (!software_name) {
    req.flash('error', 'Software name is required');
    return res.redirect(`/licenses/${id}/edit`);
  }
  if (software_name.length > 200) {
    req.flash('error', 'Software name must be at most 200 characters');
    return res.redirect(`/licenses/${id}/edit`);
  }
  if (license_type && !VALID_LICENSE_TYPES.includes(license_type)) {
    req.flash('error', 'Invalid license type');
    return res.redirect(`/licenses/${id}/edit`);
  }

  const seats = Math.max(1, safeInt(total_seats, 1));
  const used = safeInt(used_seats, 0);
  if (used > seats) {
    req.flash('error', 'Used seats cannot exceed total seats');
    return res.redirect(`/licenses/${id}/edit`);
  }
  const clampedUsed = Math.max(0, used);

  try {
    // Verify license exists before updating; fetch existing key for preservation
    const existing = _editLicenseStmt.get(id);
    if (!existing) {
      req.flash('error', 'License not found');
      return res.redirect('/licenses');
    }

    // If license_key field was left blank on edit, preserve the existing key
    const safeKey = (license_key || '').substring(0, 500) || existing.license_key;

    _licenseUpdateStmt.run(software_name.substring(0, 200), (vendor || '').substring(0, 200) || null, safeKey, license_type || null,
      seats, clampedUsed,
      safeDate(purchase_date), safeDate(expiry_date), cost ? safePositiveFloat(cost) : null, (notes || '').substring(0, 2000) || null, id);

    req.audit('update', 'license', id, `Updated license for ${software_name}`);
    req.flash('success', 'License updated');
    res.redirect(`/licenses/${id}`);
  } catch (err) {
    console.error('License update error:', err.message);
    req.flash('error', 'Error updating license. Please try again.');
    res.redirect(`/licenses/${id}/edit`);
  }
});

// Delete license
router.delete('/:id', requireAdminOrManager, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid license ID');
    return res.redirect('/licenses');
  }

  try {
    const result = _deleteLicenseStmt.run(id);
    if (result.changes === 0) {
      req.flash('error', 'License not found');
    } else {
      req.audit('delete', 'license', id, 'Deleted license');
      req.flash('success', 'License deleted');
    }
  } catch (err) {
    console.error('License delete error:', err.message);
    req.flash('error', 'Error deleting license');
  }
  res.redirect('/licenses');
});

module.exports = router;
