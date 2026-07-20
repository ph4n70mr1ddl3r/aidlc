const db = require('../models/database');
const { requireAuth, requireAdminOrManager } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { paginate, paginationBaseUrl, addSearch, buildFilters, safeId, safePositiveFloat, safePositiveInt, safeDate, trim, countQuery, selectQuery, safeQueryValue, safeFilters, isPrivileged, parseBooleanFlag } = require('../utils');
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

/**
 * Resolve total_seats / used_seats from a form submission.
 * On UPDATE, pass the existing row so an ABSENT field (partial submission)
 * preserves the stored value instead of resetting seats to 1/0 — mirrors the
 * spent/budget preservation in projects.js and the optional-field handling in
 * vendors.js / changes.js. On CREATE, pass null so absent fields default to
 * 1 total / 0 used.
 *
 * safeInt rejects arrays from HTTP parameter pollution (parseInt would coerce
 * ["3","9"] to 3), so a polluted payload falls back to the existing/default
 * count rather than silently storing a coerced value.
 * @returns {{ seats: number, used: number, error: string|null }}
 */
function _resolveSeats(totalSeatsRaw, usedSeatsRaw, existing) {
  const fallbackTotal = existing && existing.total_seats != null ? existing.total_seats : 1;
  const fallbackUsed = existing && existing.used_seats != null ? existing.used_seats : 0;
  // Seat counts are unsigned SQLite INTEGER columns; use safePositiveInt so
  // negative (HPP) values and out-of-range counts are rejected rather than
  // silently coerced/truncated.
  //
  // IMPORTANT: safePositiveInt returns the fallback for *any* non-parseable
  // input, so a present-but-garbage value ("abc", "12.5", an HPP array that
  // safeQueryValue collapses to a string, etc.) would silently collapse to the
  // default/existing count — fail-open. Mirror the fail-closed convention used
  // for cost/budget/spent: an ABSENT/empty field preserves the stored/default
  // value, but a PRESENT non-numeric value is rejected rather than coerced.
  const totalPresent = totalSeatsRaw !== undefined && totalSeatsRaw !== null && totalSeatsRaw !== '';
  const usedPresent = usedSeatsRaw !== undefined && usedSeatsRaw !== null && usedSeatsRaw !== '';
  const seats = totalPresent ? safePositiveInt(totalSeatsRaw, Infinity) : fallbackTotal;
  const used = usedPresent ? safePositiveInt(usedSeatsRaw, Infinity) : fallbackUsed;
  if (totalPresent && !Number.isFinite(seats)) {
    return { seats, used, error: 'Invalid total seats' };
  }
  if (usedPresent && !Number.isFinite(used)) {
    return { seats, used, error: 'Invalid used seats' };
  }
  if (!Number.isFinite(seats) || !Number.isFinite(used)) {
    return { seats, used, error: 'Invalid seat count' };
  }
  const finalSeats = Math.max(1, seats);
  const finalUsed = used;
  if (finalUsed < 0) {
    return { seats: finalSeats, used: finalUsed, error: 'Used seats cannot be negative' };
  }
  if (finalUsed > finalSeats) {
    return { seats: finalSeats, used: finalUsed, error: 'Used seats cannot exceed total seats' };
  }
  return { seats: finalSeats, used: finalUsed, error: null };
}

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
    UPDATE licenses SET software_name = ?, vendor = ?, license_key = ?,
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
    title: 'Software Licenses', licenses,
    filters: safeFilters(req.query, ['search', 'license_type', 'sort']),
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
  // Fail closed on HTTP parameter pollution: reject array payloads which
  // safeQueryValue would silently collapse to the first element.
  const _licenseCreateFields = ['software_name', 'vendor', 'license_key', 'license_type', 'total_seats', 'used_seats', 'purchase_date', 'expiry_date', 'cost', 'notes'];
  for (const f of _licenseCreateFields) {
    if (Array.isArray(req.body[f])) {
      req.flash('error', 'Invalid request parameters');
      return res.redirect('/licenses/new');
    }
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

  // Distinguish "cost not submitted" (default to 0) from "cost submitted with
  // an invalid value" (fail closed — reject rather than silently storing null,
  // which would wipe a legitimate stored cost). Mirrors projects.js budget/spent.
  let safeCost;
  if (cost === undefined || cost === null || cost === '') {
    safeCost = 0;
  } else {
    safeCost = safePositiveFloat(cost, Infinity);
    if (!Number.isFinite(safeCost)) {
      req.flash('error', 'Invalid cost amount');
      return res.redirect('/licenses/new');
    }
  }

  const { seats, used, error: seatError } = _resolveSeats(total_seats, used_seats, null);
  if (seatError) {
    req.flash('error', seatError);
    return res.redirect('/licenses/new');
  }

  // Validate date ordering. Reject a present, non-empty date that fails to
  // parse (fail-closed) instead of silently storing NULL — mirrors the
  // malformed-date handling on projects/assets/vendors/change-log.
  const sPurchase = safeDate(purchase_date);
  const sExpiry = safeDate(expiry_date);
  if (purchase_date && purchase_date !== '' && sPurchase === null) {
    req.flash('error', 'Invalid purchase date');
    return res.redirect('/licenses/new');
  }
  if (expiry_date && expiry_date !== '' && sExpiry === null) {
    req.flash('error', 'Invalid expiry date');
    return res.redirect('/licenses/new');
  }
  if (sPurchase && sExpiry && sExpiry < sPurchase) {
    req.flash('error', 'Expiry date must be on or after purchase date');
    return res.redirect('/licenses/new');
  }

  try {
      const result = _licenseInsertStmt.run(software_name.substring(0, MAX_MEDIUM_STR), (vendor || '').substring(0, MAX_MEDIUM_STR) || null, (license_key || '').substring(0, MAX_LONG_STR) || null, license_type || null,
       seats, used,
       sPurchase, sExpiry, safeCost, (notes || '').substring(0, MAX_NOTES) || null);

    req.audit('create', 'license', result.lastInsertRowid, `Created license for ${software_name}`);
    req.flash('success', `License for ${software_name} created`);
    invalidateDashboardCache();
    res.redirect('/licenses');
  } catch (err) {
    console.error('License create error:', err.message);
    req.flash('error', 'Error creating license. Please try again.');
    return res.redirect('/licenses/new');
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

  try {
    const license = _showLicenseStmt.get(id);
    if (!license) {
      return res.status(404).json({ error: 'License not found' });
    }
    req.audit('read', 'license', id, `Revealed license key for ${license.software_name}`);
    res.json({ key: license.license_key || '' });
  } catch (err) {
    console.error('License key reveal error:', err.message);
    res.status(500).json({ error: 'Error retrieving license key' });
  }
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

  // Fail closed on HTTP parameter pollution: reject array payloads for every
  // body field. safeQueryValue collapses an array to its first element rather
  // than rejecting it, which would silently accept a polluted value (e.g.
  // clear_key[]=1 wiping the stored key, or vendor[]=A overriding the intended
  // value). This mirrors the array-rejection guards used in vendors.js /
  // knowledge.js and the HPP defense elsewhere in the codebase.
  const _licenseUpdateFields = ['software_name', 'vendor', 'license_key', 'clear_key', 'license_type', 'total_seats', 'used_seats', 'purchase_date', 'expiry_date', 'cost', 'notes'];
  for (const f of _licenseUpdateFields) {
    if (Array.isArray(req.body[f])) {
      req.flash('error', 'Invalid request parameters');
      return res.redirect(`/licenses/${id}/edit`);
    }
  }

  const software_name = trim(safeQueryValue(req.body.software_name));
  const vendor = trim(safeQueryValue(req.body.vendor));
  const license_key = trim(safeQueryValue(req.body.license_key));
  const clearKey = parseBooleanFlag(safeQueryValue(req.body.clear_key));
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

  // Distinguish "cost not submitted" (preserve stored value inside the
  // transaction) from "cost submitted with an invalid value" (fail closed —
  // reject rather than silently wiping the stored cost). Mirrors projects.js
  // budget/spent. The existing value is read inside the transaction below.
  if (cost !== undefined && cost !== null && cost !== '') {
    const _costCheck = safePositiveFloat(cost, Infinity);
    if (!Number.isFinite(_costCheck)) {
      req.flash('error', 'Invalid cost amount');
      return res.redirect(`/licenses/${id}/edit`);
    }
  }

  // Validate date ordering. Reject a present, non-empty date that fails to
  // parse (fail-closed) instead of silently storing NULL — mirrors the
  // malformed-date handling on projects/assets/vendors/change-log.
  const sPurchase = safeDate(purchase_date);
  const sExpiry = safeDate(expiry_date);
  if (purchase_date && purchase_date !== '' && sPurchase === null) {
    req.flash('error', 'Invalid purchase date');
    return res.redirect(`/licenses/${id}/edit`);
  }
  if (expiry_date && expiry_date !== '' && sExpiry === null) {
    req.flash('error', 'Invalid expiry date');
    return res.redirect(`/licenses/${id}/edit`);
  }
  if (sPurchase && sExpiry && sExpiry < sPurchase) {
    req.flash('error', 'Expiry date must be on or after purchase date');
    return res.redirect(`/licenses/${id}/edit`);
  }

  try {
    // Resolve the new key. An explicit "clear key" checkbox wipes the stored
    // key; otherwise a blank field preserves the existing value (avoiding a
    // TOCTOU between a prior SELECT and the UPDATE). We no longer rely on a
    // magic '_CLEAR_' string value, which any user could accidentally submit
    // as their key and wipe it.
    // Verify license exists and update in a single transaction to avoid a TOCTOU
    // race where the license is deleted between the existence check and the UPDATE.
    const updateLicense = db.transaction(() => {
      const existing = _showLicenseStmt.get(id);
      if (!existing) {
        throw new Error('NOT_FOUND');
      }
      // Resolve seats against the freshly-read row so an absent field on a
      // partial submission preserves the stored count instead of resetting it
      // (mirrors projects.js spent/budget). Validated inside the transaction so
      // the used>seats check runs against the resolved values, not stale 1/0.
      const resolved = _resolveSeats(total_seats, used_seats, existing);
      if (resolved.error) {
        throw Object.assign(new Error('SEAT_VALIDATION'), { flash: resolved.error });
      }
      // Resolve the license key: an explicit clear_key checkbox wipes it;
      // a blank field preserves the existing value; a non-empty field replaces
      // it. (The old '_CLEAR_' magic-string sentinel was removed because any
      // user could submit it as a literal key value and wipe the stored key.)
      const resolvedKey = clearKey
        ? null
        : (license_key ? license_key.substring(0, MAX_LONG_STR) || null : existing.license_key);
      // Resolve cost against the freshly-read row: an absent field preserves the
      // stored value (avoids a TOCTOU between this SELECT and the UPDATE); an
      // invalid value was already rejected before the transaction.
      const resolvedCost = (cost === undefined || cost === null || cost === '')
        ? (existing.cost ?? 0)
        : safePositiveFloat(cost, Infinity);
      _licenseUpdateStmt.run(software_name.substring(0, MAX_MEDIUM_STR), (vendor || '').substring(0, MAX_MEDIUM_STR) || null, resolvedKey, license_type || null,
        resolved.seats, resolved.used,
        sPurchase, sExpiry, resolvedCost, (notes || '').substring(0, MAX_NOTES) || null, id);
    });
    updateLicense();

    req.audit('update', 'license', id, `Updated license for ${software_name}`);
    req.flash('success', 'License updated');
    invalidateDashboardCache();
    res.redirect(`/licenses/${id}`);
  } catch (err) {
    if (err.message === 'NOT_FOUND') {
      req.flash('error', 'License not found');
      return res.redirect('/licenses');
    }
    if (err.message === 'SEAT_VALIDATION' && err.flash) {
      req.flash('error', err.flash);
      return res.redirect(`/licenses/${id}/edit`);
    }
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
    // Verify license exists and delete in a single transaction to avoid a
    // TOCTOU race where the license is deleted between the earlier existence
    // check and the DELETE (mirrors the license update transaction pattern).
    const deleteLicense = db.transaction(() => {
      const existing = _showLicenseStmt.get(id);
      if (!existing) {
        return { changes: 0 };
      }
      return { changes: _deleteLicenseStmt.run(id).changes, name: existing.software_name };
    });
    const result = deleteLicense();
    if (result.changes === 0) {
      req.flash('error', 'License not found');
    } else {
      req.audit('delete', 'license', id, `Deleted license "${result.name}"`);
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
// Exposed for unit testing (mirrors the pattern in vendors.js / changes.js).
module.exports.resolveSeats = _resolveSeats;
