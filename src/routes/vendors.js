const db = require('../models/database');
const { requireAuth, requireAdminOrManager } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { paginate, paginationBaseUrl, addSearch, buildFilters, safeId, isValidEmail, isValidUrl, safeDate, trim, sanitizePhone, isValidPhone, countQuery, selectQuery, safeQueryValue } = require('../utils');
const { VENDOR_CATEGORIES: VALID_CATEGORIES_VENDOR, MAX_MEDIUM_STR, MAX_SHORT_STR, MAX_ADDRESS, MAX_EMAIL, MAX_PHONE, MAX_NOTES, MAX_LONG_STR } = require('../constants');
const { invalidateDashboardCache } = require('./dashboard');

const rateLimit = require('express-rate-limit');

const vendorWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: 'Too many vendor operations. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});

const router = require('express').Router();
router.use(requireAuth, auditMiddleware);

/**
 * Parse and validate a vendor rating from a form field value.
 * Returns { value, error } where:
 *   - value is the parsed integer (1-5) or null for empty/optional fields
 *   - error is a string message or null if valid
 */
function _validateVendorRating(value) {
  // Reject arrays from HTTP parameter pollution (e.g. ?rating[]=3&rating[]=5),
  // which parseInt() would silently coerce to its first element ("3,5" -> 3).
  // Mirrors the array guards in safeId / safeInt / safePositiveFloat. Rating is
  // optional, so treat a malformed (array) input as "no value" rather than an
  // error, consistent with how those sanitizers fall back on arrays.
  if (Array.isArray(value)) {
    return { value: null, error: null };
  }
  if (value === undefined || value === '' || value === null) {
    return { value: null, error: null };
  }
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1 || n > 5) {
    return { value: null, error: 'Rating must be between 1 and 5' };
  }
  return { value: n, error: null };
}

// Cached prepared statements for show/edit routes (static SQL).
const _showVendorStmt = db.prepare('SELECT * FROM vendors WHERE id = ?');
const _vendorStatusStmt = db.prepare('SELECT is_active FROM vendors WHERE id = ?');
const _deactivateStmt = db.prepare('UPDATE vendors SET is_active = 0, updated_at = datetime(\'now\') WHERE id = ?');
const _reactivateStmt = db.prepare('UPDATE vendors SET is_active = 1, updated_at = datetime(\'now\') WHERE id = ?');
const _vendorUpdateCheckStmt = db.prepare('SELECT id, name, is_active FROM vendors WHERE id = ?');
const _updateStmt = db.prepare(`
    UPDATE vendors SET name = ?, contact_person = ?, email = ?, phone = ?, address = ?,
      website = ?, category = ?, contract_start = ?, contract_end = ?, notes = ?, rating = ?,
      is_active = ?, updated_at = datetime('now')
    WHERE id = ?
  `);
const _licenseSyncStmt = db.prepare('UPDATE licenses SET vendor = ?, updated_at = datetime(\'now\') WHERE LOWER(vendor) = LOWER(?)');
const _licenseDependentsStmt = db.prepare('SELECT id, software_name FROM licenses WHERE LOWER(vendor) = LOWER(?)');
const _deleteDetachLicensesStmt = db.prepare('UPDATE licenses SET vendor = NULL, updated_at = datetime(\'now\') WHERE LOWER(vendor) = LOWER(?)');
const _deleteStmt = db.prepare('DELETE FROM vendors WHERE id = ?');

// Cached prepared statements for vendor create route
const _vendorInsertStmt = db.prepare(`
    INSERT INTO vendors (name, contact_person, email, phone, address, website, category, contract_start, contract_end, notes, rating)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

// List vendors (paginated)
router.get('/', (req, res) => {
  const { page, limit, offset } = paginate(req);

  const qCategory = safeQueryValue(req.query.category);
  const qIsActive = safeQueryValue(req.query.is_active);
  const filters = buildFilters({
    'v.category': { value: VALID_CATEGORIES_VENDOR.includes(qCategory) ? qCategory : '' },
    'v.is_active': { value: qIsActive === '1' ? 1 : qIsActive === '0' ? 0 : '' }
  }, ['v.category', 'v.is_active']);

  const where = [...filters.where];
  const params = [...filters.params];
  addSearch(where, params, safeQueryValue(req.query.search), ['v.name', 'v.contact_person', 'v.email']);

  const whereClause = where.length ? where.join(' AND ') : '1=1';

  const total = countQuery(db, 'vendors', 'v', whereClause, params);
  const totalPages = Math.ceil(total / limit) || 1;

  const vendors = selectQuery(db, `
    SELECT * FROM vendors v WHERE ${whereClause} ORDER BY v.name ASC LIMIT ? OFFSET ?
  `, [...params, limit, offset]);

  res.render('pages/vendors/index', {
    title: 'Vendors', vendors, filters: req.query,
    page, limit, totalPages, total,
    baseUrl: paginationBaseUrl(req)
  });
});

// New vendor
router.get('/new', requireAdminOrManager, (req, res) => {
  res.render('pages/vendors/form', { title: 'New Vendor', vendor: {}, isEdit: false });
});

// Create vendor
router.post('/', requireAdminOrManager, vendorWriteLimiter, (req, res) => {
  const name = trim(safeQueryValue(req.body.name));
  const contact_person = trim(safeQueryValue(req.body.contact_person));
  const email = trim(safeQueryValue(req.body.email)).toLowerCase();
  const phone = sanitizePhone(safeQueryValue(req.body.phone));
  const address = trim(safeQueryValue(req.body.address));
  const website = trim(safeQueryValue(req.body.website));
  const category = trim(safeQueryValue(req.body.category));
  const contract_start = safeQueryValue(req.body.contract_start);
  const contract_end = safeQueryValue(req.body.contract_end);
  const notes = trim(safeQueryValue(req.body.notes));
  const rating = safeQueryValue(req.body.rating);

  if (!name) {
    req.flash('error', 'Vendor name is required');
    return res.redirect('/vendors/new');
  }
  if (name.length > MAX_MEDIUM_STR) {
    req.flash('error', `Vendor name must be at most ${MAX_MEDIUM_STR} characters`);
    return res.redirect('/vendors/new');
  }
  if (contact_person && contact_person.length > MAX_SHORT_STR) {
    req.flash('error', `Contact person must be at most ${MAX_SHORT_STR} characters`);
    return res.redirect('/vendors/new');
  }
  if (address && address.length > MAX_ADDRESS) {
    req.flash('error', `Address must be at most ${MAX_ADDRESS} characters`);
    return res.redirect('/vendors/new');
  }
  if (notes && notes.length > MAX_NOTES) {
    req.flash('error', `Notes must be at most ${MAX_NOTES} characters`);
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
  if (website && website.length > MAX_LONG_STR) {
    req.flash('error', `Website must be at most ${MAX_LONG_STR} characters`);
    return res.redirect('/vendors/new');
  }

  if (phone && phone.length > MAX_PHONE) {
    req.flash('error', `Phone number must be at most ${MAX_PHONE} characters`);
    return res.redirect('/vendors/new');
  }

  if (phone && !isValidPhone(phone)) {
    req.flash('error', 'Please enter a valid phone number');
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

  // Validate rating range upfront instead of silently defaulting to null
  const { value: safeRating, error: ratingErr } = _validateVendorRating(rating);
  if (ratingErr) {
    req.flash('error', ratingErr);
    return res.redirect('/vendors/new');
  }

  try {
    const result = _vendorInsertStmt.run(name.substring(0, MAX_MEDIUM_STR), (contact_person || '').substring(0, MAX_SHORT_STR) || null, (email || '').substring(0, MAX_EMAIL) || null, phone ? phone.substring(0, MAX_PHONE) : null, (address || '').substring(0, MAX_ADDRESS) || null,
      (website || '').substring(0, MAX_LONG_STR) || null, safeCategory, sContractStart, sContractEnd,
      (notes || '').substring(0, MAX_NOTES) || null, safeRating);

    req.audit('create', 'vendor', result.lastInsertRowid, `Created vendor ${name}`);
    req.flash('success', `Vendor ${name} created`);
    invalidateDashboardCache();
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
  if (!id) {
    req.flash('error', 'Invalid vendor ID');
    return res.redirect('/vendors');
  }

  const vendor = _showVendorStmt.get(id);
  if (!vendor) {
    req.flash('error', 'Vendor not found');
    return res.redirect('/vendors');
  }
  res.render('pages/vendors/show', { title: vendor.name, vendor });
});

// Edit vendor
router.get('/:id/edit', requireAdminOrManager, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid vendor ID');
    return res.redirect('/vendors');
  }

  const vendor = _showVendorStmt.get(id);
  if (!vendor) {
    req.flash('error', 'Vendor not found');
    return res.redirect('/vendors');
  }
  res.render('pages/vendors/form', { title: 'Edit Vendor', vendor, isEdit: true });
});

// Update vendor
router.put('/:id', requireAdminOrManager, vendorWriteLimiter, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid vendor ID');
    return res.redirect('/vendors');
  }

  const name = trim(safeQueryValue(req.body.name));
  const contact_person = trim(safeQueryValue(req.body.contact_person));
  const email = trim(safeQueryValue(req.body.email)).toLowerCase();
  const phone = sanitizePhone(safeQueryValue(req.body.phone));
  const address = trim(safeQueryValue(req.body.address));
  const website = trim(safeQueryValue(req.body.website));
  const category = trim(safeQueryValue(req.body.category));
  const contract_start = safeQueryValue(req.body.contract_start);
  const contract_end = safeQueryValue(req.body.contract_end);
  const notes = trim(safeQueryValue(req.body.notes));
  const rating = safeQueryValue(req.body.rating);

  if (!name) {
    req.flash('error', 'Vendor name is required');
    return res.redirect(`/vendors/${id}/edit`);
  }
  if (name.length > MAX_MEDIUM_STR) {
    req.flash('error', `Vendor name must be at most ${MAX_MEDIUM_STR} characters`);
    return res.redirect(`/vendors/${id}/edit`);
  }
  if (contact_person && contact_person.length > MAX_SHORT_STR) {
    req.flash('error', `Contact person must be at most ${MAX_SHORT_STR} characters`);
    return res.redirect(`/vendors/${id}/edit`);
  }
  if (address && address.length > MAX_ADDRESS) {
    req.flash('error', `Address must be at most ${MAX_ADDRESS} characters`);
    return res.redirect(`/vendors/${id}/edit`);
  }
  if (notes && notes.length > MAX_NOTES) {
    req.flash('error', `Notes must be at most ${MAX_NOTES} characters`);
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
  if (website && website.length > MAX_LONG_STR) {
    req.flash('error', `Website must be at most ${MAX_LONG_STR} characters`);
    return res.redirect(`/vendors/${id}/edit`);
  }
  if (phone && phone.length > MAX_PHONE) {
    req.flash('error', `Phone number must be at most ${MAX_PHONE} characters`);
    return res.redirect(`/vendors/${id}/edit`);
  }

  if (phone && !isValidPhone(phone)) {
    req.flash('error', 'Please enter a valid phone number');
    return res.redirect(`/vendors/${id}/edit`);
  }
  if (category && !VALID_CATEGORIES_VENDOR.includes(category)) {
    req.flash('error', 'Invalid category');
    return res.redirect(`/vendors/${id}/edit`);
  }
  const safeCategory = VALID_CATEGORIES_VENDOR.includes(category) ? category : null;

  const sContractStart = safeDate(contract_start);
  const sContractEnd = safeDate(contract_end);
  if (sContractStart && sContractEnd && sContractEnd < sContractStart) {
    req.flash('error', 'Contract end must be on or after contract start');
    return res.redirect(`/vendors/${id}/edit`);
  }

  // Validate rating range upfront instead of silently defaulting to null
  const { value: safeRating, error: ratingErr } = _validateVendorRating(rating);
  if (ratingErr) {
    req.flash('error', ratingErr);
    return res.redirect(`/vendors/${id}/edit`);
  }

  try {
    const updateVendor = db.transaction(() => {
      // Verify vendor exists and fetch current state inside the transaction
      // to avoid a TOCTOU race with concurrent activate/deactivate requests.
      const existing = _vendorUpdateCheckStmt.get(id);
      if (!existing) {
        throw new Error('NOT_FOUND');
      }

      // Preserve existing is_active — use dedicated activate/deactivate routes
      // to change vendor status, ensuring any future cleanup logic runs consistently.
      _updateStmt.run(name.substring(0, MAX_MEDIUM_STR), (contact_person || '').substring(0, MAX_SHORT_STR) || null, (email || '').substring(0, MAX_EMAIL) || null, phone ? phone.substring(0, MAX_PHONE) : null, (address || '').substring(0, MAX_ADDRESS) || null,
        (website || '').substring(0, MAX_LONG_STR) || null, safeCategory,
        sContractStart, sContractEnd, (notes || '').substring(0, MAX_NOTES) || null,
        safeRating,
        existing.is_active ? 1 : 0, id);

      // Sync name change to license references (licenses.vendor is a text field
      // matching the vendor's name — not a foreign key).
      if (existing.name !== name) {
        _licenseSyncStmt.run(name, existing.name);
      }
    });
    updateVendor();

    req.audit('update', 'vendor', id, `Updated vendor ${name}`);
    req.flash('success', 'Vendor updated');
    invalidateDashboardCache();
    res.redirect(`/vendors/${id}`);
  } catch (err) {
    if (err.message === 'NOT_FOUND') {
      req.flash('error', 'Vendor not found');
      return res.redirect('/vendors');
    }
    console.error('Vendor update error:', err.message);
    req.flash('error', 'Error updating vendor. Please try again.');
    res.redirect(`/vendors/${id}/edit`);
  }
});

// Deactivate vendor (dedicated route — mirrors staff pattern)
router.put('/:id/deactivate', requireAdminOrManager, vendorWriteLimiter, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid vendor ID');
    return res.redirect('/vendors');
  }

  try {
    const existing = _vendorStatusStmt.get(id);
    if (!existing) {
      req.flash('error', 'Vendor not found');
      return res.redirect('/vendors');
    }
    if (!existing.is_active) {
      req.flash('info', 'Vendor is already inactive');
      return res.redirect(`/vendors/${id}`);
    }

    _deactivateStmt.run(id);
    req.audit('deactivate', 'vendor', id, 'Deactivated vendor');
    req.flash('success', 'Vendor deactivated');
    invalidateDashboardCache();
  } catch (err) {
    console.error('Vendor deactivate error:', err.message);
    req.flash('error', 'Error deactivating vendor');
  }
  res.redirect(`/vendors/${id}`);
});

// Reactivate vendor
router.put('/:id/reactivate', requireAdminOrManager, vendorWriteLimiter, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid vendor ID');
    return res.redirect('/vendors');
  }

  try {
    const existing = _vendorStatusStmt.get(id);
    if (!existing) {
      req.flash('error', 'Vendor not found');
      return res.redirect('/vendors');
    }
    if (existing.is_active) {
      req.flash('info', 'Vendor is already active');
      return res.redirect(`/vendors/${id}`);
    }

    _reactivateStmt.run(id);
    req.audit('reactivate', 'vendor', id, 'Reactivated vendor');
    req.flash('success', 'Vendor reactivated');
    invalidateDashboardCache();
  } catch (err) {
    console.error('Vendor reactivate error:', err.message);
    req.flash('error', 'Error reactivating vendor');
  }
  res.redirect(`/vendors/${id}`);
});

// Delete vendor (must be deactivated first to prevent accidental data loss)
router.delete('/:id', requireAdminOrManager, vendorWriteLimiter, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid vendor ID');
    return res.redirect('/vendors');
  }

  try {
    // Check for dependent licenses and delete everything in a single transaction
    // to avoid race conditions between the SELECT and DELETE.
    const deleteVendor = db.transaction(() => {
      // Prevent deleting active vendors — force deactivation first so the user
      // consciously acknowledges the action (mirrors the staff deactivation pattern).
      const vendor = _showVendorStmt.get(id);
      if (!vendor) {
        return { changes: 0, active: false, licenseCount: 0 };
      }
      if (vendor.is_active) {
        return { changes: 0, active: true, licenseCount: 0 };
      }

      // Nullify vendor references on licenses to avoid orphaned references
      // Use the vendor name directly (already fetched above) instead of a
      // correlated subquery, which is both clearer and slightly faster.
      const dependentLicenses = _licenseDependentsStmt.all(vendor.name);
      const licenseCount = dependentLicenses.length;
      if (licenseCount > 0) {
        _deleteDetachLicensesStmt.run(vendor.name);
      }
      const result = _deleteStmt.run(id);
      return { changes: result.changes, active: false, licenseCount };
    });
    const result = deleteVendor();
    if (result.active) {
      req.flash('error', 'Deactivate the vendor before deleting');
      return res.redirect(`/vendors/${id}`);
    }
    if (result.changes === 0) {
      req.flash('error', 'Vendor not found');
    } else {
      req.audit('delete', 'vendor', id, `Deleted vendor${result.licenseCount > 0 ? ` (detached from ${result.licenseCount} license(s))` : ''}`);
      req.flash('success', result.licenseCount > 0 ? `Vendor deleted. ${result.licenseCount} license(s) detached from this vendor.` : 'Vendor deleted');
      invalidateDashboardCache();
    }
  } catch (err) {
    console.error('Vendor delete error:', err.message);
    req.flash('error', 'Error deleting vendor');
  }
  res.redirect('/vendors');
});

module.exports = router;
// Exposed for unit testing (mirrors the pattern in tickets.js / knowledge.js).
module.exports.validateVendorRating = _validateVendorRating;
