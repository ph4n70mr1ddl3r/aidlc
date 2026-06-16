const db = require('../models/database');
const { requireAuth, requireAdminOrManager } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { paginate, paginationBaseUrl, addSearch, buildFilters, safeId, isValidEmail, isValidUrl, safeDate, trim, sanitizePhone, isValidPhone, countQuery } = require('../utils');
const { VENDOR_CATEGORIES: VALID_CATEGORIES_VENDOR } = require('../constants');
const { invalidateDashboardCache } = require('./dashboard');

const router = require('express').Router();
router.use(requireAuth, auditMiddleware);

/**
 * Parse a vendor rating from a form field value.
 * Returns an integer, or null for empty/invalid input.
 * Range validation is handled by validateVendorRating() before this is called.
 */
function parseVendorRating(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) {
    return null;
  }
  return n;
}

/**
 * Validate a vendor rating value and return an error message if invalid.
 * Returns null if the rating is valid (1-5) or empty (optional field).
 */
function validateVendorRating(value) {
  if (value === undefined || value === '' || value === null) {
    return null;
  }
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1 || n > 5) {
    return 'Rating must be between 1 and 5';
  }
  return null;
}

// Cached prepared statements for show/edit routes (static SQL).
const _showVendorStmt = db.prepare('SELECT * FROM vendors WHERE id = ?');
const _deactivateCheckStmt = db.prepare('SELECT is_active FROM vendors WHERE id = ?');
const _deactivateStmt = db.prepare('UPDATE vendors SET is_active = 0, updated_at = datetime(\'now\') WHERE id = ?');
const _reactivateStmt = db.prepare('UPDATE vendors SET is_active = 1, updated_at = datetime(\'now\') WHERE id = ?');
const _updateExistStmt = db.prepare('SELECT id, name, is_active FROM vendors WHERE id = ?');
const _updateStmt = db.prepare(`
    UPDATE vendors SET name = ?, contact_person = ?, email = ?, phone = ?, address = ?,
      website = ?, category = ?, contract_start = ?, contract_end = ?, notes = ?, rating = ?,
      is_active = ?, updated_at = datetime('now')
    WHERE id = ?
  `);
const _licenseSyncStmt = db.prepare('UPDATE licenses SET vendor = ?, updated_at = datetime(\'now\') WHERE vendor = ?');
const _licenseDependentsStmt = db.prepare('SELECT id, software_name FROM licenses WHERE vendor = (SELECT name FROM vendors WHERE id = ?)');
const _deleteDetachLicensesStmt = db.prepare('UPDATE licenses SET vendor = NULL, updated_at = datetime(\'now\') WHERE vendor = (SELECT name FROM vendors WHERE id = ?)');
const _deleteStmt = db.prepare('DELETE FROM vendors WHERE id = ?');

// Cached prepared statements for vendor create route
const _vendorInsertStmt = db.prepare(`
    INSERT INTO vendors (name, contact_person, email, phone, address, website, category, contract_start, contract_end, notes, rating)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

// List vendors (paginated)
router.get('/', (req, res) => {
  const { page, limit, offset } = paginate(req);

  const filters = buildFilters({
    'v.category': { value: VALID_CATEGORIES_VENDOR.includes(req.query.category) ? req.query.category : '' },
    'v.is_active': { value: req.query.is_active === '1' ? 1 : req.query.is_active === '0' ? 0 : '' }
  }, ['v.category', 'v.is_active']);

  const where = [...filters.where];
  const params = [...filters.params];
  addSearch(where, params, req.query.search, ['v.name', 'v.contact_person', 'v.email']);

  const whereClause = where.length ? where.join(' AND ') : '1=1';

  const total = countQuery(db, 'vendors', 'v', whereClause, params);
  const totalPages = Math.ceil(total / limit) || 1;

  const vendors = db.prepare(`
    SELECT * FROM vendors v WHERE ${whereClause} ORDER BY v.name ASC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

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
router.post('/', requireAdminOrManager, (req, res) => {
  const name = trim(req.body.name);
  const contact_person = trim(req.body.contact_person);
  const email = trim(req.body.email).toLowerCase();
  const phone = sanitizePhone(req.body.phone);
  const address = trim(req.body.address);
  const website = trim(req.body.website);
  const { category, contract_start, contract_end } = req.body;
  const notes = trim(req.body.notes);
  const { rating } = req.body;

  if (!name) {
    req.flash('error', 'Vendor name is required');
    return res.redirect('/vendors/new');
  }
  if (name.length > 200) {
    req.flash('error', 'Vendor name must be at most 200 characters');
    return res.redirect('/vendors/new');
  }
  if (contact_person && contact_person.length > 100) {
    req.flash('error', 'Contact person must be at most 100 characters');
    return res.redirect('/vendors/new');
  }
  if (address && address.length > 500) {
    req.flash('error', 'Address must be at most 500 characters');
    return res.redirect('/vendors/new');
  }
  if (notes && notes.length > 2000) {
    req.flash('error', 'Notes must be at most 2,000 characters');
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

  // Validate rating range upfront instead of silently defaulting to 1
  const ratingErr = validateVendorRating(rating);
  if (ratingErr) {
    req.flash('error', ratingErr);
    return res.redirect('/vendors/new');
  }

  try {
    const result = _vendorInsertStmt.run(name.substring(0, 200), (contact_person || '').substring(0, 100) || null, (email || '').substring(0, 200) || null, phone ? phone.substring(0, 50) : null, (address || '').substring(0, 500) || null,
      (website || '').substring(0, 500) || null, safeCategory, sContractStart, sContractEnd,
      (notes || '').substring(0, 2000) || null, rating !== undefined && rating !== '' ? parseVendorRating(rating) : null);

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
router.put('/:id', requireAdminOrManager, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid vendor ID');
    return res.redirect('/vendors');
  }

  const name = trim(req.body.name);
  const contact_person = trim(req.body.contact_person);
  const email = trim(req.body.email).toLowerCase();
  const phone = sanitizePhone(req.body.phone);
  const address = trim(req.body.address);
  const website = trim(req.body.website);
  const { category, contract_start, contract_end } = req.body;
  const notes = trim(req.body.notes);
  const { rating } = req.body;

  if (!name) {
    req.flash('error', 'Vendor name is required');
    return res.redirect(`/vendors/${id}/edit`);
  }
  if (name.length > 200) {
    req.flash('error', 'Vendor name must be at most 200 characters');
    return res.redirect(`/vendors/${id}/edit`);
  }
  if (contact_person && contact_person.length > 100) {
    req.flash('error', 'Contact person must be at most 100 characters');
    return res.redirect(`/vendors/${id}/edit`);
  }
  if (address && address.length > 500) {
    req.flash('error', 'Address must be at most 500 characters');
    return res.redirect(`/vendors/${id}/edit`);
  }
  if (notes && notes.length > 2000) {
    req.flash('error', 'Notes must be at most 2,000 characters');
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

  // Validate rating range upfront instead of silently defaulting to 1
  const ratingErr = validateVendorRating(rating);
  if (ratingErr) {
    req.flash('error', ratingErr);
    return res.redirect(`/vendors/${id}/edit`);
  }

  try {
    // Verify vendor exists before updating
    const existing = _updateExistStmt.get(id);
    if (!existing) {
      req.flash('error', 'Vendor not found');
      return res.redirect('/vendors');
    }

    const updateVendor = db.transaction(() => {
      // Preserve existing is_active — use dedicated activate/deactivate routes
      // to change vendor status, ensuring any future cleanup logic runs consistently.
      _updateStmt.run(name.substring(0, 200), (contact_person || '').substring(0, 100) || null, (email || '').substring(0, 200) || null, phone ? phone.substring(0, 50) : null, (address || '').substring(0, 500) || null,
        (website || '').substring(0, 500) || null, safeCategory,
        sContractStart, sContractEnd, (notes || '').substring(0, 2000) || null,
        rating !== undefined && rating !== '' ? parseVendorRating(rating) : null,
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
    console.error('Vendor update error:', err.message);
    req.flash('error', 'Error updating vendor. Please try again.');
    res.redirect(`/vendors/${id}/edit`);
  }
});

// Deactivate vendor (dedicated route — mirrors staff pattern)
router.put('/:id/deactivate', requireAdminOrManager, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid vendor ID');
    return res.redirect('/vendors');
  }

  try {
    const existing = _deactivateCheckStmt.get(id);
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
router.put('/:id/reactivate', requireAdminOrManager, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid vendor ID');
    return res.redirect('/vendors');
  }

  try {
    const existing = _deactivateCheckStmt.get(id);
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
router.delete('/:id', requireAdminOrManager, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid vendor ID');
    return res.redirect('/vendors');
  }

  try {
    // Check for dependent licenses and delete everything in a single transaction
    // to avoid race conditions between the SELECT and DELETE.
    let licenseCount = 0;
    const deleteVendor = db.transaction(() => {
      // Prevent deleting active vendors — force deactivation first so the user
      // consciously acknowledges the action (mirrors the staff deactivation pattern).
      const vendor = _showVendorStmt.get(id);
      if (!vendor) {
        return { changes: 0, active: false };
      }
      if (vendor.is_active) {
        return { changes: 0, active: true };
      }

      // Nullify vendor references on licenses to avoid orphaned references
      const dependentLicenses = _licenseDependentsStmt.all(id);
      licenseCount = dependentLicenses.length;
      if (licenseCount > 0) {
        _deleteDetachLicensesStmt.run(id);
      }
      const result = _deleteStmt.run(id);
      return { changes: result.changes, active: false };
    });
    const result = deleteVendor();
    if (result.active) {
      req.flash('error', 'Deactivate the vendor before deleting');
      return res.redirect(`/vendors/${id}`);
    }
    if (result.changes === 0) {
      req.flash('error', 'Vendor not found');
    } else {
      req.audit('delete', 'vendor', id, `Deleted vendor${licenseCount > 0 ? ` (detached from ${licenseCount} license(s))` : ''}`);
      req.flash('success', licenseCount > 0 ? `Vendor deleted. ${licenseCount} license(s) detached from this vendor.` : 'Vendor deleted');
      invalidateDashboardCache();
    }
  } catch (err) {
    console.error('Vendor delete error:', err.message);
    req.flash('error', 'Error deleting vendor');
  }
  res.redirect('/vendors');
});

module.exports = router;
