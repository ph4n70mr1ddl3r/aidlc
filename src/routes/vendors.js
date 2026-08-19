const db = require('../models/database');
const { requireAuth, requireAdminOrManager, canAccessResource } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { paginate, paginationBaseUrl, addSearch, buildFilters, safeId, isValidEmail, isValidUrl, safeDate, trim, sanitizePhone, isValidPhone, countQuery, selectQuery, safeQueryValue, safeFilters, rejectHppArrays, resolveOptionalField, authKeyGenerator, titleCase } = require('../utils');
const { VENDOR_CATEGORIES: VALID_CATEGORIES_VENDOR, MAX_MEDIUM_STR, MAX_SHORT_STR, MAX_ADDRESS, MAX_EMAIL, MAX_PHONE, MAX_NOTES, MAX_LONG_STR } = require('../constants');
const { invalidateDashboardCache } = require('./dashboard');

const rateLimit = require('express-rate-limit');

const vendorWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  keyGenerator: authKeyGenerator,
  message: 'Too many vendor operations. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});

const router = require('express').Router();
router.use(requireAuth, auditMiddleware);

/**
 * Parse and validate a vendor rating (1-5) from a form field value.
 * Returns { value, error } where value is the parsed integer or null for empty fields.
 * Rejects arrays (HPP), non-integers, and out-of-range values.
 */
const _MAX_RATING_INPUT = 10; // Reject absurdly long rating strings early

function _validateVendorRating(rawValue) {
  // Reject arrays from HTTP parameter pollution (e.g. ?rating[]=3&rating[]=5),
  // which parseInt() would silently coerce to its first element ("3,5" -> 3).
  // The raw request value is passed here so the array is visible.
  if (Array.isArray(rawValue)) {
    return { value: null, error: 'Rating must be a whole number between 1 and 5' };
  }
  // Reject absurdly long rating strings to prevent resource exhaustion
  if (typeof rawValue === 'string' && rawValue.length > _MAX_RATING_INPUT) {
    return { value: null, error: 'Rating must be a whole number between 1 and 5' };
  }
  // Normalise leading/trailing whitespace so " 3 " is treated as "3" rather
  // than rejected by the numeric pattern check below.  parseInt handles both,
  // but the regex guard runs first and would otherwise reject the input.
  let value = rawValue;
  if (typeof value === 'string') {
    value = value.trim();
  }
  if (value === undefined || value === '' || value === null) {
    return { value: null, error: null };
  }
  // Reject non-integer values. The string check guards form submissions ("3.5");
  // the number check guards JSON API clients that send a numeric literal
  // ({"rating": 3.5}) which would otherwise slip past the regex and be silently
  // truncated to 3 by parseInt below. Arrays are rejected by the guard above,
  // so they do not reach this point.
  if ((typeof value === 'number' && !Number.isInteger(value)) ||
      (typeof value === 'string' && !/^-?\d+$/.test(value))) {
    return { value: null, error: 'Rating must be a whole number between 1 and 5' };
  }
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1 || n > 5) {
    return { value: null, error: 'Rating must be a whole number between 1 and 5' };
  }
  return { value: n, error: null };
}

/**
 * Resolve a vendor RATING on update. Rating is a discrete 1-5 value (or null),
 * not free text: ABSENT fields preserve the existing rating, and empty
 * submitted values also preserve it — so editing any other field never wipes
 * a previously set rating. Only a present, non-empty, validated value replaces it.
 * @param {*} rawValue - The submitted value (e.g. req.body.rating); may be
 *   undefined (absent field), a string, an array (HPP), or any other type.
 * @param {number|null} validatedRating - The parsed rating from _validateVendorRating,
 *   or null when the field was empty/invalid-but-optional
 * @param {number|null} existingRating - The current rating from the DB
 * @returns {number|null}
 */
function _resolveVendorRatingOnUpdate(rawValue, validatedRating, existingRating) {
  if (rawValue === undefined) {
    return existingRating;
  }
  if (validatedRating === null) {
    return existingRating;
  }
  return validatedRating;
}

/**
 * Resolve an optional DATE field on update: preserve existing only when ABSENT
 * from the request (partial submission). An empty submitted value CLEARS it (null).
 * A present but unparseable value is an error (fail closed) so the stored date
 * is not silently wiped. Mirrors the absent-vs-empty distinction in changes.js,
 * projects.js, and licenses.js.
 * @param {*} rawValue
 * @param {string|null} existingValue
 * @returns {{ error: boolean, value: string|null }}
 */
function _resolveClearableDate(rawValue, existingValue) {
  // Reject arrays from HTTP parameter pollution for consistency with the
  // array guards in safeId / safeInt / safePositiveFloat and the explicit
  // checks in _resolveDateTimeField. A polluted array must surface as a
  // validation error rather than silently falling through to safeDate().
  if (Array.isArray(rawValue)) {
    return { error: true };
  }
  // Absent field (undefined) or explicit JSON null — preserve the existing value
  // so a null sent via the JSON body parser does not silently wipe a stored date.
  if (rawValue === undefined || rawValue === null) {
    return { error: false, value: existingValue };
  }
  // Empty string explicitly clears the field (null) — allows un-setting a date.
  if (rawValue === '') {
    return { error: false, value: null };
  }
  // Present but unparseable (e.g. "2026-13-01") → surface as an error so the
  // existing legitimate date is NOT silently wiped. Previously this fell through
  // to safeDate() which returned NULL and overwrote the stored value.
  const parsed = safeDate(rawValue);
  if (parsed === null) {
    return { error: true };
  }
  return { error: false, value: parsed };
}


// Cached prepared statements for show/edit routes (static SQL).
const _showVendorStmt = db.prepare('SELECT id, name, contact_person, email, phone, address, website, category, contract_start, contract_end, notes, rating, is_active, created_at, updated_at FROM vendors WHERE id = ?');
const _vendorStatusStmt = db.prepare('SELECT is_active FROM vendors WHERE id = ?');
const _deactivateStmt = db.prepare('UPDATE vendors SET is_active = 0, updated_at = datetime(\'now\') WHERE id = ?');
const _reactivateStmt = db.prepare('UPDATE vendors SET is_active = 1, updated_at = datetime(\'now\') WHERE id = ?');
const _updateStmt = db.prepare(`
    UPDATE vendors SET name = ?, contact_person = ?, email = ?, phone = ?, address = ?,
      website = ?, category = ?, contract_start = ?, contract_end = ?, notes = ?, rating = ?,
      is_active = ?, updated_at = datetime('now')
    WHERE id = ?
  `);
const _licenseSyncStmt = db.prepare('UPDATE licenses SET vendor = ?, updated_at = datetime(\'now\') WHERE LOWER(vendor) = LOWER(?)');
const _licenseDependentsCountStmt = db.prepare('SELECT COUNT(*) as cnt FROM licenses WHERE LOWER(vendor) = LOWER(?)');
const _deleteDetachLicensesStmt = db.prepare('UPDATE licenses SET vendor = NULL, updated_at = datetime(\'now\') WHERE LOWER(vendor) = LOWER(?)');
const _deleteStmt = db.prepare('DELETE FROM vendors WHERE id = ?');
const _vendorNameExistsStmt = db.prepare('SELECT 1 FROM vendors WHERE LOWER(name) = LOWER(?) AND id != ?');
const _vendorNameCreateExistsStmt = db.prepare('SELECT 1 FROM vendors WHERE LOWER(name) = LOWER(?)');

// Cached prepared statements for vendor create route
const _vendorInsertStmt = db.prepare(`
    INSERT INTO vendors (name, contact_person, email, phone, address, website, category, contract_start, contract_end, notes, rating)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

// List vendors (paginated)
router.get('/', (req, res) => {
  const { page: requestedPage, limit } = paginate(req);

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
  // Clamp the requested page to the actual page count so a page beyond the
  // last one (e.g. ?page=999) renders the final page instead of an empty list
  // with a broken "Showing N–M" range (M < N) in the pagination partial.
  const page = Math.min(requestedPage, totalPages);
  const offset = (page - 1) * limit;

  const vendors = selectQuery(db, `
    SELECT v.id, v.name, v.contact_person, v.email, v.category, v.contract_end, v.rating, v.is_active
    FROM vendors v WHERE ${whereClause} ORDER BY v.name ASC LIMIT ? OFFSET ?
  `, [...params, limit, offset]);

  res.render('pages/vendors/index', {
    title: 'Vendors', vendors,
    filters: safeFilters(req.query, ['search', 'category', 'is_active']),
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
  // Fail closed on HTTP parameter pollution arrays for all text body fields.
  const hppErrors = rejectHppArrays(req, ['name', 'contact_person', 'email', 'phone', 'address', 'website', 'category', 'notes', 'contract_start', 'contract_end', 'rating']);
  if (hppErrors.length > 0) {
    req.flash('error', 'Invalid request parameters');
    return res.redirect('/vendors/new');
  }

  const name = trim(safeQueryValue(req.body.name));
  const contact_person = trim(safeQueryValue(req.body.contact_person));
  const email = trim(safeQueryValue(req.body.email)).toLowerCase();
  const rawPhone = safeQueryValue(req.body.phone);
  // Reject overly long phone input before expensive sanitization
  if (typeof rawPhone === 'string' && rawPhone.length > MAX_PHONE) {
    req.flash('error', `Phone number must be at most ${MAX_PHONE} characters`);
    return res.redirect('/vendors/new');
  }
  const phone = sanitizePhone(rawPhone);
  // Fail closed on a present-but-malformed phone: a value that sanitizes to
  // nothing (e.g. "abc", or a non-string JSON value) must be rejected rather
  // than silently stored as NULL — the fail-closed convention applied to every
  // other present-but-invalid field. Absent/empty values are allowed (no phone).
  if (rawPhone !== undefined && rawPhone !== null && rawPhone !== '' && !phone) {
    req.flash('error', 'Please enter a valid phone number');
    return res.redirect('/vendors/new');
  }
  const address = trim(safeQueryValue(req.body.address));
  const website = trim(safeQueryValue(req.body.website));
  const category = trim(safeQueryValue(req.body.category));
  const contract_start = safeQueryValue(req.body.contract_start);
  const contract_end = safeQueryValue(req.body.contract_end);
  const notes = trim(safeQueryValue(req.body.notes));
  // Fail closed on present-but-non-string optional text fields (e.g. JSON
  // numbers/objects): trim() coerces them to '', which would silently store
  // NULL — the same fail-closed convention the update route enforces via
  // resolveOptionalField's error sentinel.
  for (const field of ['contact_person', 'email', 'address', 'website', 'category', 'notes']) {
    const v = req.body[field];
    if (v !== undefined && v !== null && v !== '' && typeof v !== 'string') {
      req.flash('error', 'Invalid request parameters');
      return res.redirect('/vendors/new');
    }
  }

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
  // A present, non-empty contract date that fails to parse must be rejected
  // (fail closed) rather than silently stored as NULL — the same malformed-date
  // default-to-NULL pattern fixed for the assets/projects update paths. An empty
  // contract date is still allowed (falls back to NULL). Use explicit absence
  // checks (not truthiness) so a falsy non-string JSON value (0/false) is also
  // rejected, matching the update route's _resolveClearableDate semantics.
  if (contract_start !== undefined && contract_start !== null && contract_start !== '' && sContractStart === null) {
    req.flash('error', 'Invalid contract start date');
    return res.redirect('/vendors/new');
  }
  if (contract_end !== undefined && contract_end !== null && contract_end !== '' && sContractEnd === null) {
    req.flash('error', 'Invalid contract end date');
    return res.redirect('/vendors/new');
  }
  if (sContractStart && sContractEnd && sContractEnd < sContractStart) {
    req.flash('error', 'Contract end must be on or after contract start');
    return res.redirect('/vendors/new');
  }

  // Validate rating range upfront instead of silently defaulting to null
  const { value: safeRating, error: ratingErr } = _validateVendorRating(req.body.rating);
  if (ratingErr) {
    req.flash('error', ratingErr);
    return res.redirect('/vendors/new');
  }

  try {
    // Check for duplicate name (case-insensitive) AND insert inside a single
    // transaction. vendors.name has no UNIQUE constraint (uniqueness is enforced
    // case-insensitively in app code via LOWER()), so a check performed outside
    // a transaction would be vulnerable to a TOCTOU race: two concurrent
    // requests with the same name could both pass the check and insert,
    // producing duplicate vendors and corrupting LOWER() license lookups.
    // Mirrors the update route's transactional check.
    const createVendor = db.transaction(() => {
      const safeName = name.substring(0, MAX_MEDIUM_STR);
      if (_vendorNameCreateExistsStmt.get(safeName)) {
        throw new Error('NAME_EXISTS');
      }
      return _vendorInsertStmt.run(
        safeName,
        (contact_person || '').substring(0, MAX_SHORT_STR) || null,
        (email || '').substring(0, MAX_EMAIL) || null,
        phone ? phone.substring(0, MAX_PHONE) : null,
        (address || '').substring(0, MAX_ADDRESS) || null,
        (website || '').substring(0, MAX_LONG_STR) || null,
        safeCategory,
        sContractStart,
        sContractEnd,
        (notes || '').substring(0, MAX_NOTES) || null,
        safeRating
      );
    });

    const result = createVendor();

    req.audit('create', 'vendor', result.lastInsertRowid, `Created vendor ${name}`);
    req.flash('success', `Vendor ${name} created`);
    invalidateDashboardCache();
    return res.redirect('/vendors');
  } catch (err) {
    if (err.message === 'NAME_EXISTS') {
      req.flash('error', 'A vendor with this name already exists');
      return res.redirect('/vendors/new');
    } else {
      console.error('Vendor create error:', err.message);
      req.flash('error', 'Error creating vendor. Please try again.');
    }
    return res.redirect('/vendors/new');
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
  if (!canAccessResource(req, vendor)) {
    req.audit('access_denied', 'vendor', id, `Unauthorized view attempt on vendor ${vendor.name}`);
    req.flash('error', 'You do not have permission to view this vendor');
    return res.redirect('/vendors');
  }
  req.audit('read', 'vendor', id, `Viewed vendor: ${vendor.name}`);
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

  // Fail closed on HTTP parameter pollution arrays for all body fields.
  const hppErrors = rejectHppArrays(req, ['name', 'contact_person', 'email', 'phone', 'address', 'website', 'category', 'notes', 'contract_start', 'contract_end', 'rating']);
  if (hppErrors.length > 0) {
    req.flash('error', 'Invalid request parameters');
    return res.redirect(`/vendors/${id}/edit`);
  }

  const name = trim(safeQueryValue(req.body.name));
  const contact_person = trim(safeQueryValue(req.body.contact_person));
  const email = trim(safeQueryValue(req.body.email)).toLowerCase();
  const rawPhone = safeQueryValue(req.body.phone);
  // Reject overly long phone input before expensive sanitization
  if (typeof rawPhone === 'string' && rawPhone.length > MAX_PHONE) {
    req.flash('error', `Phone number must be at most ${MAX_PHONE} characters`);
    return res.redirect(`/vendors/${id}/edit`);
  }
  const phone = sanitizePhone(rawPhone);
  // Fail closed on a present-but-malformed phone: a value that sanitizes to
  // nothing (e.g. "abc", or a non-string JSON value) must be rejected rather
  // than silently clearing the stored phone via resolveOptionalField — the
  // fail-closed convention applied to every other present-but-invalid field.
  // Absent/empty values are allowed (no phone).
  if (rawPhone !== undefined && rawPhone !== null && rawPhone !== '' && !phone) {
    req.flash('error', 'Please enter a valid phone number');
    return res.redirect(`/vendors/${id}/edit`);
  }
  const address = trim(safeQueryValue(req.body.address));
  const website = trim(safeQueryValue(req.body.website));
  const category = trim(safeQueryValue(req.body.category));
  const contract_start = safeQueryValue(req.body.contract_start);
  const contract_end = safeQueryValue(req.body.contract_end);
  const notes = trim(safeQueryValue(req.body.notes));
  const rawRating = safeQueryValue(req.body.rating);

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

  if (phone && !isValidPhone(phone)) {
    req.flash('error', 'Please enter a valid phone number');
    return res.redirect(`/vendors/${id}/edit`);
  }
  if (category && !VALID_CATEGORIES_VENDOR.includes(category)) {
    req.flash('error', 'Invalid category');
    return res.redirect(`/vendors/${id}/edit`);
  }

  const sContractStart = safeDate(contract_start);
  const sContractEnd = safeDate(contract_end);
  // A present, non-empty contract date that fails to parse must be rejected
  // (fail closed) rather than silently stored as NULL — the same malformed-date
  // default-to-NULL pattern checked in the create route and across all other
  // sibling update routes (assets, projects, licenses). An empty contract date
  // is still allowed to fall back to the stored value.
  if (contract_start !== undefined && contract_start !== null && contract_start !== '' && sContractStart === null) {
    req.flash('error', 'Invalid contract start date');
    return res.redirect(`/vendors/${id}/edit`);
  }
  if (contract_end !== undefined && contract_end !== null && contract_end !== '' && sContractEnd === null) {
    req.flash('error', 'Invalid contract end date');
    return res.redirect(`/vendors/${id}/edit`);
  }

  // Validate rating range upfront instead of silently defaulting to null
  const { value: safeRating, error: ratingErr } = _validateVendorRating(req.body.rating);
  if (ratingErr) {
    req.flash('error', ratingErr);
    return res.redirect(`/vendors/${id}/edit`);
  }

  try {
    const updateVendor = db.transaction(() => {
      // Verify vendor exists and fetch current state inside the transaction
      // to avoid a TOCTOU race with concurrent activate/deactivate requests.
      const existing = _showVendorStmt.get(id);
      if (!existing) {
        throw new Error('NOT_FOUND');
      }

      // For each optional field: if the field was present in the request body
      // (even empty), use the submitted value (empty -> null to allow clearing).
      // If the field was absent (partial submission), preserve the existing value.
      // Uses resolveOptionalField (shared from utils.js) to eliminate 8-way
      // duplication of the raw-undefined check pattern.
      const safeContactPerson = resolveOptionalField(req.body.contact_person, contact_person || null, MAX_SHORT_STR, existing.contact_person);
      if (safeContactPerson && safeContactPerson.error) {
        throw new Error('INVALID_CONTACT_PERSON');
      }
      const safeEmail = resolveOptionalField(req.body.email, email || null, MAX_EMAIL, existing.email);
      if (safeEmail && safeEmail.error) {
        throw new Error('INVALID_EMAIL');
      }
      const safePhone = resolveOptionalField(req.body.phone, phone || null, MAX_PHONE, existing.phone);
      if (safePhone && safePhone.error) {
        throw new Error('INVALID_PHONE');
      }
      const safeAddress = resolveOptionalField(req.body.address, address || null, MAX_ADDRESS, existing.address);
      if (safeAddress && safeAddress.error) {
        throw new Error('INVALID_ADDRESS');
      }
      const safeWebsite = resolveOptionalField(req.body.website, website || null, MAX_LONG_STR, existing.website);
      if (safeWebsite && safeWebsite.error) {
        throw new Error('INVALID_WEBSITE');
      }
      const safeCategory = resolveOptionalField(req.body.category, category || null, null, existing.category);
      if (safeCategory && safeCategory.error) {
        throw new Error('INVALID_CATEGORY');
      }
      const safeNotes = resolveOptionalField(req.body.notes, notes || null, MAX_NOTES, existing.notes);
      if (safeNotes && safeNotes.error) {
        throw new Error('INVALID_NOTES');
      }
      // Rating is a discrete 1-5 value, not free text. An empty submitted
      // value (the form's number input sends '' when blank) must preserve the
      // existing rating rather than clear it, so editing any other field on the
      // vendor does not wipe a previously set rating.
      const safeRatingVal = _resolveVendorRatingOnUpdate(rawRating, safeRating, existing.rating);

      // Prevent renaming to a name already used by another vendor (case-insensitive),
      // which would make LOWER() license lookups ambiguous and could corrupt data.
      // Must check BEFORE the UPDATE so the transaction does not throw after
      // already applying the write (even though SQLite rollback would undo it,
      // checking first is semantically correct and avoids wasted work).
      const safeName = name.substring(0, MAX_MEDIUM_STR);
      if (existing.name !== safeName && _vendorNameExistsStmt.get(safeName, id)) {
        throw new Error('NAME_EXISTS');
      }

      // Resolve contract dates: preserve existing only when the field is ABSENT
      // from the request (partial submission). An empty submitted value clears
      // the date (null), consistent with the create route and every other
      // optional field. Previously an empty value fell back to existing, making
      // it impossible to clear a contract date via the edit form.
      const resolvedStartDate = _resolveClearableDate(contract_start, existing.contract_start);
      if (resolvedStartDate.error) {
        throw new Error('INVALID_CONTRACT_START');
      }
      const resolvedEndDate = _resolveClearableDate(contract_end, existing.contract_end);
      if (resolvedEndDate.error) {
        throw new Error('INVALID_CONTRACT_END');
      }
      // Validate the date range against the RESOLVED values, not just the
      // submitted ones. On a partial submission that changes only
      // contract_start, the unchanged stored contract_end is compared too, so a
      // start moved beyond the stored end is rejected instead of persisted.
      // Mirrors the resolved-value range checks in changes.js, projects.js,
      // and licenses.js.
      if (resolvedStartDate.value && resolvedEndDate.value && resolvedEndDate.value < resolvedStartDate.value) {
        throw new Error('CONTRACT_END_BEFORE_START');
      }

      // Preserve existing is_active — use dedicated activate/deactivate routes
      // to change vendor status, ensuring any future cleanup logic runs consistently.
      _updateStmt.run(safeName, safeContactPerson, safeEmail, safePhone, safeAddress,
        safeWebsite, safeCategory,
        resolvedStartDate.value,
        resolvedEndDate.value,
        safeNotes,
        safeRatingVal,
        existing.is_active ? 1 : 0, id);

      // Sync name change to license references (licenses.vendor is a text field
      // matching the vendor's name — not a foreign key).
      if (existing.name !== safeName) {
        _licenseSyncStmt.run(safeName, existing.name);
      }
    });
    updateVendor();

    req.audit('update', 'vendor', id, `Updated vendor ${name}`);
    req.flash('success', 'Vendor updated');
    invalidateDashboardCache();
    return res.redirect(`/vendors/${id}`);
  } catch (err) {
    if (err.message === 'NOT_FOUND') {
      req.flash('error', 'Vendor not found');
      return res.redirect('/vendors');
    }
    if (err.message === 'NAME_EXISTS') {
      req.flash('error', 'Another vendor with this name already exists');
      return res.redirect(`/vendors/${id}/edit`);
    }
    if (err.message === 'CONTRACT_END_BEFORE_START') {
      req.flash('error', 'Contract end must be on or after contract start');
      return res.redirect(`/vendors/${id}/edit`);
    }
    // Handle contract date errors with the same message format as the create route
    // (sentence case, including "date") for consistency.
    if (err.message === 'INVALID_CONTRACT_START') {
      req.flash('error', 'Invalid contract start date');
      return res.redirect(`/vendors/${id}/edit`);
    }
    if (err.message === 'INVALID_CONTRACT_END') {
      req.flash('error', 'Invalid contract end date');
      return res.redirect(`/vendors/${id}/edit`);
    }
    if (err.message.startsWith('INVALID_')) {
      const fieldName = err.message.replace('INVALID_', '');
      req.flash('error', `Invalid ${titleCase(fieldName)}`);
      return res.redirect(`/vendors/${id}/edit`);
    }
    console.error('Vendor update error:', err.message);
    req.flash('error', 'Error updating vendor. Please try again.');
    return res.redirect(`/vendors/${id}/edit`);
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
    // Check vendor state and deactivate in a single transaction to avoid a
    // TOCTOU race with concurrent activate/deactivate requests.
    const deactivateVendor = db.transaction(() => {
      const existing = _vendorStatusStmt.get(id);
      if (!existing) {
        return { notFound: true };
      }
      if (!existing.is_active) {
        return { alreadyInactive: true };
      }
      _deactivateStmt.run(id);
      return { ok: true };
    });
    const result = deactivateVendor();

    if (result.notFound) {
      req.flash('error', 'Vendor not found');
      return res.redirect('/vendors');
    }
    if (result.alreadyInactive) {
      req.flash('info', 'Vendor is already inactive');
      return res.redirect(`/vendors/${id}`);
    }
    req.audit('deactivate', 'vendor', id, 'Deactivated vendor');
    req.flash('success', 'Vendor deactivated');
    invalidateDashboardCache();
  } catch (err) {
    console.error('Vendor deactivate error:', err.message);
    req.flash('error', 'Error deactivating vendor.');
  }
  return res.redirect(`/vendors/${id}`);
});

// Reactivate vendor
router.put('/:id/reactivate', requireAdminOrManager, vendorWriteLimiter, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid vendor ID');
    return res.redirect('/vendors');
  }

  try {
    // Check vendor state and reactivate in a single transaction to avoid a
    // TOCTOU race with concurrent activate/deactivate requests.
    const reactivateVendor = db.transaction(() => {
      const existing = _vendorStatusStmt.get(id);
      if (!existing) {
        return { notFound: true };
      }
      if (existing.is_active) {
        return { alreadyActive: true };
      }
      _reactivateStmt.run(id);
      return { ok: true };
    });
    const result = reactivateVendor();

    if (result.notFound) {
      req.flash('error', 'Vendor not found');
      return res.redirect('/vendors');
    }
    if (result.alreadyActive) {
      req.flash('info', 'Vendor is already active');
      return res.redirect(`/vendors/${id}`);
    }
    req.audit('reactivate', 'vendor', id, 'Reactivated vendor');
    req.flash('success', 'Vendor reactivated');
    invalidateDashboardCache();
  } catch (err) {
    console.error('Vendor reactivate error:', err.message);
    req.flash('error', 'Error reactivating vendor.');
  }
  return res.redirect(`/vendors/${id}`);
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
      const licenseCount = _licenseDependentsCountStmt.get(vendor.name).cnt;
      if (licenseCount > 0) {
        _deleteDetachLicensesStmt.run(vendor.name);
      }
      const result = _deleteStmt.run(id);
      return { changes: result.changes, active: false, licenseCount, name: vendor.name };
    });
    const result = deleteVendor();
    if (result.active) {
      req.flash('error', 'Deactivate the vendor before deleting');
      return res.redirect(`/vendors/${id}`);
    }
    if (result.changes === 0) {
      req.flash('error', 'Vendor not found');
    } else {
      req.audit('delete', 'vendor', id, `Deleted vendor "${result.name}"${result.licenseCount > 0 ? ` (detached from ${result.licenseCount} license(s))` : ''}`);
      req.flash('success', result.licenseCount > 0 ? `Vendor deleted. ${result.licenseCount} license(s) detached from this vendor.` : 'Vendor deleted');
      invalidateDashboardCache();
    }
  } catch (err) {
    console.error('Vendor delete error:', err.message);
    req.flash('error', 'Error deleting vendor.');
  }
  return res.redirect('/vendors');
});

/**
 * Reset module-level cached prepared statements (test use only).
 * Ensures test isolation when using mock db instances — consistent with
 * the same-named export in middleware/auth.js, audit.js, utils.js, etc.
 */
function resetCachedStatements() {
  // All cached statements are module-level const bindings from db.prepare(),
  // so there is no lazy-init to null out — the cache is unused when
  // the db mock is swapped. This function exists for API consistency
  // across all route modules.
}

module.exports = router;
// Exposed for unit testing (mirrors the pattern in tickets.js / knowledge.js).
module.exports.validateVendorRating = _validateVendorRating;
module.exports.resolveVendorRatingOnUpdate = _resolveVendorRatingOnUpdate;
module.exports.resolveClearableDate = _resolveClearableDate;
module.exports.resetCachedStatements = resetCachedStatements;
