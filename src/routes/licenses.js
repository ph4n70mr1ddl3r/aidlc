const db = require('../models/database');
const { requireAuth, requireAdminOrManager } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { paginate, paginationBaseUrl, addSearch, buildFilters, safeId, safePositiveFloat, safeInt, safeDate, trim, countQuery, selectQuery, safeQueryValue, isPrivileged } = require('../utils');
const { LICENSE_TYPES: VALID_LICENSE_TYPES, MAX_MEDIUM_STR, MAX_LONG_STR, MAX_NOTES } = require('../constants');
const { invalidateDashboardCache } = require('./dashboard');
const rateLimit = require('express-rate-limit');

const licenseWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: 'Too many license operations. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});

const router = require('express').Router();
router.use(requireAuth, auditMiddleware);

// Rate limit license key reveal to prevent bulk exfiltration
// (higher limit than write operations since this is just a read)
const licenseKeyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: 'Too many key reveal requests. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});

// Cached prepared statements for show/edit routes (static SQL).
const _showLicenseStmt = db.prepare('SELECT * FROM licenses WHERE id = ?');
const _deleteLicenseStmt = db.prepare('DELETE FROM licenses WHERE id = ?');

// Cached prepared statements for create/update routes
const _licenseInsertStmt = db.prepare(`
    INSERT INTO licenses (software_name, vendor, license_key, license_type, total_seats, used_seats, purchase_date, expiry_date, cost, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
const _licenseUpdateStmt = db.prepare(`
    UPDATE licenses SET software_name = ?, vendor = ?,
      license_key = COALESCE(NULLIF(?, ''), license_key),
      license_type = ?,
      total_seats = ?, used_seats = ?, purchase_date = ?, expiry_date = ?, cost = ?, notes = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `);

// List licenses (paginated)
router.get('/', (req, res) => {
  const { page, limit, offset } = paginate(req);

  const qLicenseType = safeQueryValue(req.query.license_type);
  const filters = buildFilters({
    'l.license_type': { value: VALID_LICENSE_TYPES.includes(qLicenseType) ? qLicenseType : '' }
  }, ['l.license_type']);

  const where = [...filters.where];
  const params = [...filters.params];
  addSearch(where, params, safeQueryValue(req.query.search), ['l.software_name', 'l.vendor']);

  const whereClause = where.length ? where.join(' AND ') : '1=1';

  const total = countQuery(db, 'licenses', 'l', whereClause, params);
  const totalPages = Math.ceil(total / limit) || 1;

  const licenses = selectQuery(db, `
    SELECT l.id, l.software_name, l.vendor, l.license_type, l.total_seats, l.used_seats,
      l.purchase_date, l.expiry_date, l.cost, l.notes, l.created_at, l.updated_at
    FROM licenses l WHERE ${whereClause} ORDER BY l.software_name ASC LIMIT ? OFFSET ?
  `, [...params, limit, offset]);

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
router.post('/', requireAdminOrManager, licenseWriteLimiter, (req, res) => {
  const software_name = trim(safeQueryValue(req.body.software_name));
  const vendor = trim(safeQueryValue(req.body.vendor));
  const license_key = trim(safeQueryValue(req.body.license_key));
  const license_type = trim(safeQueryValue(req.body.license_type));
  const total_seats = safeQueryValue(req.body.total_seats);
  const used_seats = safeQueryValue(req.body.used_seats);
  const purchase_date = safeQueryValue(req.body.purchase_date);
  const expiry_date = safeQueryValue(req.body.expiry_date);
  const cost = safeQueryValue(req.body.cost);
  const notes = trim(safeQueryValue(req.body.notes));

  if (!software_name) {
    req.flash('error', 'Software name is required');
    return res.redirect('/licenses/new');
  }
  if (software_name.length > MAX_MEDIUM_STR) {
    req.flash('error', `Software name must be at most ${MAX_MEDIUM_STR} characters`);
    return res.redirect('/licenses/new');
  }
  if (vendor && vendor.length > MAX_MEDIUM_STR) {
    req.flash('error', `Vendor must be at most ${MAX_MEDIUM_STR} characters`);
    return res.redirect('/licenses/new');
  }
  if (license_key && license_key.length > MAX_LONG_STR) {
    req.flash('error', `License key must be at most ${MAX_LONG_STR} characters`);
    return res.redirect('/licenses/new');
  }
  if (notes && notes.length > MAX_NOTES) {
    req.flash('error', `Notes must be at most ${MAX_NOTES} characters`);
    return res.redirect('/licenses/new');
  }

  if (license_type && !VALID_LICENSE_TYPES.includes(license_type)) {
    req.flash('error', 'Invalid license type');
    return res.redirect('/licenses/new');
  }

  const seats = Math.max(1, safeInt(total_seats, 1));
  const used = safeInt(used_seats, 0);
  if (used < 0) {
    req.flash('error', 'Used seats cannot be negative');
    return res.redirect('/licenses/new');
  }
  if (used > seats) {
    req.flash('error', 'Used seats cannot exceed total seats');
    return res.redirect('/licenses/new');
  }

  // Validate date ordering
  const sPurchase = safeDate(purchase_date);
  const sExpiry = safeDate(expiry_date);
  if (sPurchase && sExpiry && sExpiry < sPurchase) {
    req.flash('error', 'Expiry date must be on or after purchase date');
    return res.redirect('/licenses/new');
  }

  try {
    const result = _licenseInsertStmt.run(software_name.substring(0, MAX_MEDIUM_STR), (vendor || '').substring(0, MAX_MEDIUM_STR) || null, (license_key || '').substring(0, MAX_LONG_STR) || null, license_type || null,
      seats, used,
      sPurchase, sExpiry, cost !== undefined && cost !== '' ? safePositiveFloat(cost) : null, (notes || '').substring(0, MAX_NOTES) || null);

    req.audit('create', 'license', result.lastInsertRowid, `Created license for ${software_name}`);
    req.flash('success', `License for ${software_name} created`);
    invalidateDashboardCache();
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
    req.flash('error', 'Invalid license ID');
    return res.redirect('/licenses');
  }

  const license = _showLicenseStmt.get(id);
  if (!license) {
    req.flash('error', 'License not found');
    return res.redirect('/licenses');
  }
  if (!isPrivileged(req.session.user)) {
    license.license_key = null;
  }
  res.render('pages/licenses/show', { title: license.software_name, license });
});

// AJAX endpoint for license key reveal (admin/manager only)
// POST (not GET) so the endpoint benefits from CSRF protection — GET requests
// are not checked by doubleCsrfProtection and could leak keys via cross-site
// request forgery.
router.post('/:id/key', requireAdminOrManager, licenseKeyLimiter, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'Invalid license ID' });
  }

  const license = _showLicenseStmt.get(id);
  if (!license) {
    return res.status(404).json({ error: 'License not found' });
  }
  req.audit('read', 'license', id, `Revealed license key for ${license.software_name}`);
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
router.put('/:id', requireAdminOrManager, licenseWriteLimiter, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid license ID');
    return res.redirect('/licenses');
  }

  const software_name = trim(safeQueryValue(req.body.software_name));
  const vendor = trim(safeQueryValue(req.body.vendor));
  const license_key = trim(safeQueryValue(req.body.license_key));
  const license_type = trim(safeQueryValue(req.body.license_type));
  const total_seats = safeQueryValue(req.body.total_seats);
  const used_seats = safeQueryValue(req.body.used_seats);
  const purchase_date = safeQueryValue(req.body.purchase_date);
  const expiry_date = safeQueryValue(req.body.expiry_date);
  const cost = safeQueryValue(req.body.cost);
  const notes = trim(safeQueryValue(req.body.notes));

  if (!software_name) {
    req.flash('error', 'Software name is required');
    return res.redirect(`/licenses/${id}/edit`);
  }
  if (software_name.length > MAX_MEDIUM_STR) {
    req.flash('error', `Software name must be at most ${MAX_MEDIUM_STR} characters`);
    return res.redirect(`/licenses/${id}/edit`);
  }
  if (vendor && vendor.length > MAX_MEDIUM_STR) {
    req.flash('error', `Vendor must be at most ${MAX_MEDIUM_STR} characters`);
    return res.redirect(`/licenses/${id}/edit`);
  }
  if (license_key && license_key.length > MAX_LONG_STR) {
    req.flash('error', `License key must be at most ${MAX_LONG_STR} characters`);
    return res.redirect(`/licenses/${id}/edit`);
  }
  if (notes && notes.length > MAX_NOTES) {
    req.flash('error', `Notes must be at most ${MAX_NOTES} characters`);
    return res.redirect(`/licenses/${id}/edit`);
  }
  if (license_type && !VALID_LICENSE_TYPES.includes(license_type)) {
    req.flash('error', 'Invalid license type');
    return res.redirect(`/licenses/${id}/edit`);
  }

  const seats = Math.max(1, safeInt(total_seats, 1));
  const used = safeInt(used_seats, 0);
  if (used < 0) {
    req.flash('error', 'Used seats cannot be negative');
    return res.redirect(`/licenses/${id}/edit`);
  }
  if (used > seats) {
    req.flash('error', 'Used seats cannot exceed total seats');
    return res.redirect(`/licenses/${id}/edit`);
  }

  // Validate date ordering
  const sPurchase = safeDate(purchase_date);
  const sExpiry = safeDate(expiry_date);
  if (sPurchase && sExpiry && sExpiry < sPurchase) {
    req.flash('error', 'Expiry date must be on or after purchase date');
    return res.redirect(`/licenses/${id}/edit`);
  }

  try {
    // Verify license exists before updating (separate from the COALESCE/NULLIF
    // guard that preserves the key when the field is blank on edit).
    const existing = _showLicenseStmt.get(id);
    if (!existing) {
      req.flash('error', 'License not found');
      return res.redirect('/licenses');
    }

    // If license_key field is blank on edit, COALESCE/NULLIF in the UPDATE SQL
    // preserves the existing key atomically, avoiding a TOCTOU between a prior
    // SELECT (to fetch the key) and the UPDATE below.
    const safeKey = (license_key || '').substring(0, MAX_LONG_STR) || null;

    _licenseUpdateStmt.run(software_name.substring(0, MAX_MEDIUM_STR), (vendor || '').substring(0, MAX_MEDIUM_STR) || null, safeKey, license_type || null,
      seats, used,
      sPurchase, sExpiry, cost !== undefined && cost !== '' ? safePositiveFloat(cost) : null, (notes || '').substring(0, MAX_NOTES) || null, id);

    req.audit('update', 'license', id, `Updated license for ${software_name}`);
    req.flash('success', 'License updated');
    invalidateDashboardCache();
    res.redirect(`/licenses/${id}`);
  } catch (err) {
    console.error('License update error:', err.message);
    req.flash('error', 'Error updating license. Please try again.');
    res.redirect(`/licenses/${id}/edit`);
  }
});

// Delete license
router.delete('/:id', requireAdminOrManager, licenseWriteLimiter, (req, res) => {
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
      invalidateDashboardCache();
    }
  } catch (err) {
    console.error('License delete error:', err.message);
    req.flash('error', 'Error deleting license');
  }
  res.redirect('/licenses');
});

module.exports = router;
