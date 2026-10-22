const db = require('../models/database');
const { requireAuth, requireAdminOrManager } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { paginate, paginationBaseUrl, addSearch, buildFilters, safeId, safePositiveInt, resolveMoneyAmount, safeDate, trim, titleCase, countQuery, selectQuery, safeQueryValue, safeFilters, parseBooleanFlag, rejectHppArrays, resolveOptionalField, resolveEnumField, findBlankTextField, findNonStringField, authKeyGenerator, logError } = require('../utils');
const { LICENSE_TYPES: VALID_LICENSE_TYPES, MAX_MEDIUM_STR, MAX_LONG_STR, MAX_NOTES, MAX_MONEY_AMOUNT, MAX_SEAT_COUNT } = require('../constants');
const { invalidateDashboardCache } = require('./dashboard');
const rateLimit = require('express-rate-limit');

// Key rate-limiting by authenticated user id (per-account, shared utils helper)
// so one admin's requests cannot silence the whole team behind a NAT'd office IP
// — the key reveal limiter is the anti-exfiltration control for the module's most
// sensitive secret and must not be exhaustible by colleagues.

const licenseWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  keyGenerator: authKeyGenerator,
  message: 'Too many license operations. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});

const router = require('express').Router();
router.use(requireAuth, auditMiddleware);

/**
 * Resolve total_seats / used_seats from a form submission.
 * On UPDATE, pass the existing row so ABSENT fields preserve stored values;
 * on CREATE, pass null so absent fields default to 1 total / 0 used.
 * Rejects arrays (HPP defense) and non-numeric/garbage counts (fail closed —
 * a present value that does not parse is an error, never a silent coercion).
 * A submitted total below 1 is floored to 1 (a license must carry at least one
 * seat), so `total_seats=0` persists as a 1-seat license rather than being
 * rejected outright.
 * @returns {{ seats: number, used: number, error: string|null }}
 */
function _resolveSeats(totalSeatsRaw, usedSeatsRaw, existing) {
  const fallbackTotal = existing && existing.total_seats != null ? existing.total_seats : 1;
  const fallbackUsed = existing && existing.used_seats != null ? existing.used_seats : 0;
  // Seat counts are unsigned SQLite INTEGER columns; use safePositiveInt so
  // negative (HPP) values and out-of-range counts are rejected rather than
  // silently coerced/truncated.
  // IMPORTANT: safePositiveInt returns the fallback for *any* non-parseable
  // input, so a present-but-garbage value would silently collapse to the
  // default/existing count — fail-open. Mirror the fail-closed convention:
  // an ABSENT/empty field preserves the stored/default value, but a PRESENT
  // non-numeric value is rejected rather than coerced.
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
  // The seat counts carry the app-wide upper bound (MAX_SEAT_COUNT) the form's
  // number inputs declare. An HTML `max` attribute is a client-side hint
  // only, so without this check an API client could store a seat count the UI
  // refuses to accept (and the two surfaces disagreed about what a valid count
  // is).
  if (totalPresent && seats > MAX_SEAT_COUNT) {
    return { seats, used, error: `Total Seats must be at most ${MAX_SEAT_COUNT}` };
  }
  if (usedPresent && used > MAX_SEAT_COUNT) {
    return { seats, used, error: `Used Seats must be at most ${MAX_SEAT_COUNT}` };
  }
  const finalSeats = Math.max(1, seats);
  const finalUsed = used;
  if (finalUsed > finalSeats) {
    return { seats: finalSeats, used: finalUsed, error: 'Used seats cannot exceed total seats' };
  }
  return { seats: finalSeats, used: finalUsed, error: null };
}

// Rate limit license key reveal to prevent bulk exfiltration. Deliberately a
// TIGHTER cap than the write limiter above (20 vs 50 per 15 min): this is the
// anti-exfiltration control for the module's most sensitive secret, and every
// reveal is audited, so bulk enumeration must be the hardest operation here.
const licenseKeyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  keyGenerator: authKeyGenerator,
  message: 'Too many key reveal requests. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});

// Cached prepared statements for show/edit routes (static SQL).
//
// Two variants, deliberately separated by the sensitive column:
// - `_licenseShowStmt` NEVER selects license_key. It is used by the GET show
//   route and the GET edit route, so the plaintext secret is never loaded
//   into a render context. `has_license_key` carries the only thing those
//   views need: whether a key IS stored (the reveal button's condition).
// - `_showLicenseStmt` selects the plaintext and is used ONLY by the update
//   route's transaction, which genuinely needs the stored key to preserve it
//   when the submitted field is absent. It never reaches a template.
//
// The show route previously rendered '****' + key.slice(-4) — a partial
// preview that shipped the last four characters of the secret in the HTML
// body, outside the audited and rate-limited POST /licenses/:id/key reveal
// path. That also contradicted the documented app-wide rule that "no
// partial-key preview is ever rendered server-side or client-side" (the
// client-side mask in public/js/app.js emits '****' only).
const _licenseShowStmt = db.prepare("SELECT id, software_name, vendor, license_type, total_seats, used_seats, purchase_date, expiry_date, cost, notes, created_at, updated_at, (license_key IS NOT NULL AND license_key <> '') AS has_license_key FROM licenses WHERE id = ?");
const _showLicenseStmt = db.prepare('SELECT id, software_name, vendor, license_key, license_type, total_seats, used_seats, purchase_date, expiry_date, cost, notes, created_at, updated_at FROM licenses WHERE id = ?');
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

// List licenses (paginated) — admin/manager only, matching the show route:
// the list renders the same business-sensitive cost and seat data the show
// route is gated on, so leaving it open to all staff would render that gate
// meaningless. `notes` is intentionally not selected — the index template
// never renders it (mirrors the dashboard's minimal-column convention).
router.get('/', requireAdminOrManager, (req, res) => {
  req.audit('read', 'license', null, 'Viewed licenses list');
  // Fail closed on HTTP parameter pollution: reject array payloads on query
  // params. Mirrors the explicit HPP guard on GET /audit and the array-rejection
  // convention used by every write route in the app.
  const hppErrors = rejectHppArrays(req, ['search', 'license_type']);
  if (hppErrors.length > 0) {
    req.flash('error', 'Invalid request parameters');
    return res.redirect('/licenses');
  }
  const { page: requestedPage, limit } = paginate(req);

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
  // Clamp the requested page to the actual page count so a page beyond the
  // last one (e.g. ?page=999) renders the final page instead of an empty list
  // with a broken "Showing N–M" range (M < N) in the pagination partial.
  const page = Math.min(requestedPage, totalPages);
  const offset = (page - 1) * limit;

  const licenses = selectQuery(db, `
    SELECT l.id, l.software_name, l.vendor, l.license_type, l.total_seats, l.used_seats,
      l.purchase_date, l.expiry_date, l.cost, l.created_at, l.updated_at
    FROM licenses l WHERE ${whereClause} ORDER BY l.software_name ASC, l.id ASC LIMIT ? OFFSET ?
  `, [...params, limit, offset]);

  res.render('pages/licenses/index', {
    title: 'Software Licenses', licenses,
    filters: safeFilters(req.query, ['search', 'license_type']),
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
  // Fail closed on HTTP parameter pollution: reject array payloads.
  const hppErrors = rejectHppArrays(req, ['software_name', 'vendor', 'license_key', 'license_type', 'total_seats', 'used_seats', 'purchase_date', 'expiry_date', 'cost', 'notes']);
  if (hppErrors.length > 0) {
    req.flash('error', 'Invalid request parameters');
    return res.redirect('/licenses/new');
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
  // Fail closed on present-but-non-string optional text fields (e.g. JSON
  // numbers/objects — a numeric license key is a realistic submission): trim()
  // coerces them to '', which would silently store NULL, losing the value with
  // a success flash. The same fail-closed convention the update route enforces
  // via resolveOptionalField's error sentinel. Mirrors the vendors.js create
  // guard. license_type is included for the same reason: it is validate-when-
  // present (the enum check below rejects only a present NON-EMPTY value), and
  // a non-string collapses to '' and would otherwise be stored as NULL with no
  // feedback instead of being rejected.
  // The REQUIRED software_name is guarded too: without it a JSON number in
  // `software_name` collapsed to '' and was reported as a MISSING field
  // ("Software name is required"), while the matching update route reported
  // the identical submission as "Invalid Software Name" — a type error
  // masquerading as an absent one.
  for (const field of ['software_name', 'vendor', 'license_key', 'license_type', 'notes']) {
    const v = req.body[field];
    if (v !== undefined && v !== null && v !== '' && typeof v !== 'string') {
      req.flash('error', 'Invalid request parameters');
      return res.redirect('/licenses/new');
    }
  }
  if (!software_name) {
    req.flash('error', 'Software name is required');
    return res.redirect('/licenses/new');
  }

  // A present-but-whitespace-only value is neither an ABSENT field ("not
  // submitted") nor an intentional empty string ("clear the column") — it is
  // an INVALID value. The matching UPDATE route rejects the identical value
  // through resolveOptionalField's blank-value guard ("Invalid Vendor",
  // "Invalid License Key", "Invalid Notes"), so the create route must not
  // accept it and store NULL with a success flash. For the licence key that
  // was the worst case: the operator was told the licence (and its key) was
  // created while the secret was silently dropped, and the reveal control
  // never appeared because `has_license_key` stayed false.
  const blankField = findBlankTextField(req.body, ['vendor', 'license_key', 'notes']);
  if (blankField) {
    req.flash('error', `Invalid ${titleCase(blankField)}`);
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

  // Enum resolution — a present-but-blank licence type (a whitespace-only
  // value) is an invalid value, not an omitted one: it used to trim to '' and
  // silently store NULL while the route flashed a success.
  const createLicenseTypeEnum = resolveEnumField(req.body.license_type, VALID_LICENSE_TYPES);
  if (createLicenseTypeEnum.state === 'blank' || createLicenseTypeEnum.state === 'invalid') {
    req.flash('error', 'Invalid License Type');
    return res.redirect('/licenses/new');
  }

  // Distinguish "cost not submitted" (default to 0) from "cost submitted with
  // an invalid value" (fail closed — reject rather than silently storing null,
  // which would wipe a legitimate stored cost). Mirrors projects.js budget/spent.
  //
  // The amount is also bounded by MAX_MONEY_AMOUNT — the limit the form's
  // number input declares. The attribute is a client-side hint only, so
  // without the server-side check an API client could store a cost the UI
  // refuses to accept (and the two surfaces disagreed about what a valid
  // amount is).
  const costCheck = resolveMoneyAmount(cost, 0);
  if (costCheck.error === 'invalid') {
    req.flash('error', 'Invalid Cost Amount');
    return res.redirect('/licenses/new');
  }
  if (costCheck.error === 'too_large') {
    req.flash('error', `Cost must be at most ${MAX_MONEY_AMOUNT}`);
    return res.redirect('/licenses/new');
  }
  const safeCost = costCheck.value;

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
  if (purchase_date !== undefined && purchase_date !== null && purchase_date !== '' && sPurchase === null) {
    req.flash('error', 'Invalid Purchase Date');
    return res.redirect('/licenses/new');
  }
  if (expiry_date !== undefined && expiry_date !== null && expiry_date !== '' && sExpiry === null) {
    req.flash('error', 'Invalid Expiry Date');
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
    req.flash('success', `License for ${software_name} created.`);
    invalidateDashboardCache();
    return res.redirect('/licenses');
  } catch (err) {
    logError('License create error:', err);
    req.flash('error', 'Error creating license. Please try again.');
    return res.redirect('/licenses/new');
  }
});

// Show license (admin/manager only — license cost and seat data is business-sensitive)
router.get('/:id', requireAdminOrManager, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid license ID');
    return res.redirect('/licenses');
  }

  const license = _licenseShowStmt.get(id);
  if (!license) {
    req.flash('error', 'License not found');
    return res.redirect('/licenses');
  }
  // Defense-in-depth: the show route renders the masked key only. The
  // plaintext secret is not selected by the statement above, so it never
  // reaches the render context — the full key is reachable exclusively
  // through the audited, rate-limited POST /licenses/:id/key reveal endpoint.
  req.audit('read', 'license', id, `Viewed license: ${license.software_name}`);
  res.render('pages/licenses/show', { title: license.software_name, license });
});

// AJAX endpoint for license key reveal (admin/manager only)
// POST (not GET) so the endpoint benefits from CSRF protection — GET requests
// are not checked by doubleCsrfProtection and could leak keys via cross-site
// request forgery.
router.post('/:id/key', requireAdminOrManager, licenseKeyLimiter, (req, res) => {
  // Fail closed on HTTP parameter pollution: reject array payloads. This
  // endpoint reads only req.params.id, but an array-valued license_key body
  // field is still rejected defensively so a crafted HPP payload cannot probe
  // the handler (pinned by tests/hpp.test.js).
  const hppErrors = rejectHppArrays(req, ['license_key']);
  if (hppErrors.length > 0) {
    return res.status(400).json({ error: 'Invalid request parameters' });
  }

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
    // res.json() safely serializes the key (escapes quotes, control chars, etc.).
    // No manual HTML escaping is needed — the response is JSON, not HTML.
    res.json({ key: license.license_key || '' });
  } catch (err) {
    logError('License key reveal error:', err);
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

  const license = _licenseShowStmt.get(id);
  if (!license) {
    req.flash('error', 'License not found');
    return res.redirect('/licenses');
  }
  // Defense-in-depth: never hand the plaintext license_key to the edit
  // template. The form never pre-fills the key (the input carries no `value`
  // attribute) and only needs to know whether a key IS stored, so the secret
  // is replaced with a boolean. The sibling list route omits license_key from
  // its SELECT entirely and the dashboard does the same — the edit form now
  // follows the same rule instead of loading the secret into a render
  // context. The full key remains reachable only through the audited,
  // rate-limited POST /licenses/:id/key reveal endpoint.
  const safeLicense = { ...license, license_key: undefined, has_license_key: Boolean(license.has_license_key) };
  res.render('pages/licenses/form', { title: 'Edit License', license: safeLicense, isEdit: true });
});

// Update license
router.put('/:id', requireAdminOrManager, licenseWriteLimiter, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid license ID');
    return res.redirect('/licenses');
  }

  // Fail closed on HTTP parameter pollution: reject array payloads for every
  // body field.
  const hppErrors = rejectHppArrays(req, ['software_name', 'vendor', 'license_key', 'clear_key', 'license_type', 'total_seats', 'used_seats', 'purchase_date', 'expiry_date', 'cost', 'notes']);
  if (hppErrors.length > 0) {
    req.flash('error', 'Invalid request parameters');
    return res.redirect(`/licenses/${id}/edit`);
  }

  // Fail closed on a present-but-wrong-typed body field (e.g. a JSON number in
  // a name field, or a numeric licence key): a wrong TYPE is neither an absent
  // field nor an invalid VALUE, and the app-wide wording for it is "Invalid
  // request parameters" — the same sentence the CREATE route reports for the
  // identical submission. The field-specific wording ("Invalid License Key",
  // "Invalid Vendor", …) is reserved for the case it describes: a
  // whitespace-only VALUE.
  const wrongTypeField = findNonStringField(req.body, [
    'software_name', 'vendor', 'license_key', 'license_type', 'notes'
  ]);
  if (wrongTypeField) {
    req.flash('error', 'Invalid request parameters');
    return res.redirect(`/licenses/${id}/edit`);
  }

  const software_name = trim(safeQueryValue(req.body.software_name));
  // Raw body value (NOT trimmed) so an ABSENT software name can be told apart
  // from an explicit empty one — the same raw-vs-processed convention the
  // optional fields below use.
  const rawSoftwareName = req.body.software_name;
  // Raw body values (NOT trimmed) are needed to distinguish an ABSENT optional
  // field (partial submission — preserve stored value) from an explicit empty
  // string (clear the field). trim() collapses undefined to '', so the raw
  // values are captured here for the transaction resolution below. Mirrors the
  // raw-vs-processed split in vendors.js (resolveOptionalField).
  const rawVendor = req.body.vendor;
  const rawLicenseType = req.body.license_type;
  const rawNotes = req.body.notes;
  const vendor = trim(safeQueryValue(req.body.vendor));
  const license_key = trim(safeQueryValue(req.body.license_key));
  // A present-but-whitespace-only key is neither an absent field (preserve) nor
  // an explicit clear (the clear_key checkbox) — it trims to an empty string,
  // so the resolution below silently KEPT THE OLD SECRET while the route
  // flashed "License updated." and the operator's typed value was discarded
  // without any feedback. Reject it like every other present-but-blank value.
  // A present-but-wrong-typed key is rejected by the findNonStringField guard
  // above (the app-wide type-error wording) — a numeric licence key is a
  // realistic submission and used to be silently discarded with a success
  // flash, because trim() coerced it to '' and the resolution below treats an
  // empty string as "blank → preserve existing".
  if (typeof req.body.license_key === 'string' && req.body.license_key !== '' && req.body.license_key.trim() === '') {
    req.flash('error', 'Invalid License Key');
    return res.redirect(`/licenses/${id}/edit`);
  }
  const clearKey = parseBooleanFlag(safeQueryValue(req.body.clear_key));
  const license_type = trim(safeQueryValue(req.body.license_type));
  const total_seats = safeQueryValue(req.body.total_seats);
  const used_seats = safeQueryValue(req.body.used_seats);
  const purchase_date = safeQueryValue(req.body.purchase_date);
  const expiry_date = safeQueryValue(req.body.expiry_date);
  const cost = safeQueryValue(req.body.cost);
  const notes = trim(safeQueryValue(req.body.notes));

  // Absent-vs-present marker for the software name. An ABSENT name in a
  // partial API submission preserves the stored value (resolved inside the
  // transaction from the re-read row) — the same contract every optional field
  // on this route already follows. The name was the sole exception: a partial
  // PUT that only changed the seats was rejected outright with "Software name
  // is required" even though the stored name was perfectly valid. A PRESENT
  // but empty name is still rejected — the column is NOT NULL.
  const softwareNameAbsent = rawSoftwareName === undefined || rawSoftwareName === null;
  if (!softwareNameAbsent && !software_name) {
    req.flash('error', 'Software name is required');
    return res.redirect(`/licenses/${id}/edit`);
  }
  if (!softwareNameAbsent && software_name.length > MAX_MEDIUM_STR) {
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
  // The edit form offers the new-key input and the "clear key" checkbox side
  // by side, so ticking both is a natural action. Previously the clear flag
  // won unconditionally and the freshly typed key was discarded with a
  // success flash — the typed secret was silently lost. The combination is
  // contradictory, so fail closed and tell the operator which half to drop.
  if (clearKey && license_key) {
    req.flash('error', 'Cannot set and clear the license key at the same time');
    return res.redirect(`/licenses/${id}/edit`);
  }
  if (notes && notes.length > MAX_NOTES) {
    req.flash('error', `Notes must be at most ${MAX_NOTES} characters`);
    return res.redirect(`/licenses/${id}/edit`);
  }
  // Enum resolution — the presence test runs against the RAW submitted value
  // so a present-but-blank licence type is rejected rather than silently
  // ignored. `license_type` is a nullable column whose stored default carries
  // no meaning, so an explicit empty string CLEARS it to NULL (the same
  // behaviour the vendors.js category field follows); a whitespace-only value
  // is rejected.
  const licenseTypeEnum = resolveEnumField(req.body.license_type, VALID_LICENSE_TYPES);
  if (licenseTypeEnum.state === 'blank' || licenseTypeEnum.state === 'invalid') {
    req.flash('error', 'Invalid License Type');
    return res.redirect(`/licenses/${id}/edit`);
  }

  // Distinguish "cost not submitted" (preserve stored value inside the
  // transaction) from "cost submitted with an invalid value" (fail closed —
  // reject rather than silently wiping the stored cost). Mirrors projects.js
  // budget/spent. The existing value is read inside the transaction below.
  //
  // The amount is also bounded by MAX_MONEY_AMOUNT — the limit the form's
  // number input declares. The attribute is a client-side hint only, so
  // without the server-side check an API client could store a cost the UI
  // refuses to accept.
  const costCheck = resolveMoneyAmount(cost, null);
  if (costCheck.error === 'invalid') {
    req.flash('error', 'Invalid Cost Amount');
    return res.redirect(`/licenses/${id}/edit`);
  }
  if (costCheck.error === 'too_large') {
    req.flash('error', `Cost must be at most ${MAX_MONEY_AMOUNT}`);
    return res.redirect(`/licenses/${id}/edit`);
  }

  // Validate date ordering. Reject a present, non-empty date that fails to
  // parse (fail-closed) instead of silently storing NULL — mirrors the
  // malformed-date handling on projects/assets/vendors/change-log.
  const sPurchase = safeDate(purchase_date);
  const sExpiry = safeDate(expiry_date);
  if (purchase_date !== undefined && purchase_date !== null && purchase_date !== '' && sPurchase === null) {
    req.flash('error', 'Invalid Purchase Date');
    return res.redirect(`/licenses/${id}/edit`);
  }
  if (expiry_date !== undefined && expiry_date !== null && expiry_date !== '' && sExpiry === null) {
    req.flash('error', 'Invalid Expiry Date');
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
    // resolvedSoftwareName is hoisted out of the transaction so the audit entry
    // names the EFFECTIVE (resolved) software even when the request omitted it.
    let resolvedSoftwareName = software_name;
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
        : (license_key ? license_key.substring(0, MAX_LONG_STR) : existing.license_key);
      // Resolve cost against the freshly-read row: an absent field preserves the
      // stored value (avoids a TOCTOU between this SELECT and the UPDATE); an
      // invalid value was already rejected before the transaction.
      const resolvedCost = (cost === undefined || cost === null || cost === '')
        ? (existing.cost ?? null)
        : costCheck.value;
      // Preserve the stored optional fields when they are ABSENT from the
      // request (partial submission) instead of wiping them to NULL — the same
      // class the assets/projects/vendors update paths already handle. An empty
      // submitted value still CLEARS the field (null), consistent with the
      // create route semantics. Present-but-invalid values were rejected above.
      const resolvedVendor = resolveOptionalField(rawVendor, vendor || null, MAX_MEDIUM_STR, existing.vendor);
      if (resolvedVendor && resolvedVendor.error) {
        throw new Error('INVALID_VENDOR');
      }
      // The licence type is a nullable enum whose stored default carries no
      // meaning: an explicit empty string clears it to NULL, an absent field
      // preserves it, and a valid value replaces it.
      //
      // No error sentinel is needed for it: resolveOptionalField's three
      // error classes are all rejected before the transaction — an array by
      // the HPP guard, a non-string by the findNonStringField guard, and a
      // whitespace-only value by the resolveEnumField check above (which
      // rejects the 'blank' state). The sentinel was unreachable.
      const resolvedLicenseType = resolveOptionalField(rawLicenseType, license_type || null, null, existing.license_type);
      const resolvedNotes = resolveOptionalField(rawNotes, notes || null, MAX_NOTES, existing.notes);
      if (resolvedNotes && resolvedNotes.error) {
        throw new Error('INVALID_NOTES');
      }
      const resolvedPurchase = (purchase_date === undefined || purchase_date === null)
        ? existing.purchase_date
        : sPurchase;
      const resolvedExpiry = (expiry_date === undefined || expiry_date === null)
        ? existing.expiry_date
        : sExpiry;
      // Validate the date range against the RESOLVED values, not just the
      // submitted ones. A partial edit that moves purchase_date forward while
      // leaving expiry_date blank would otherwise pass the submitted-only check
      // above (submitted sExpiry is null) yet persist an expiry that precedes
      // the preserved purchase date. Mirrors the resolved-value range checks in
      // assets.js, vendors.js, changes.js, and projects.js.
      if (resolvedPurchase && resolvedExpiry && resolvedExpiry < resolvedPurchase) {
        throw Object.assign(new Error('DATE_RANGE_INVALID'), { flash: 'Expiry date must be on or after purchase date' });
      }
      // The software name follows the same absent-vs-present rule as the
      // optional fields on this route: an absent field preserves the CURRENT
      // stored name (read inside the transaction, so a concurrent edit cannot
      // be clobbered), a present field replaces it. A present-but-empty name
      // was rejected above.
      const effectiveSoftwareName = softwareNameAbsent
        ? existing.software_name
        : software_name.substring(0, MAX_MEDIUM_STR);
      resolvedSoftwareName = effectiveSoftwareName;
      const updateResult = _licenseUpdateStmt.run(effectiveSoftwareName, resolvedVendor, resolvedKey, resolvedLicenseType,
        resolved.seats, resolved.used,
        resolvedPurchase, resolvedExpiry, resolvedCost, resolvedNotes, id);
      if (updateResult.changes === 0) {
        throw new Error('NOT_FOUND');
      }
    });
    updateLicense();

    req.audit('update', 'license', id, `Updated license for ${resolvedSoftwareName}`);
    req.flash('success', 'License updated.');
    invalidateDashboardCache();
    return res.redirect(`/licenses/${id}`);
  } catch (err) {
    if (err.message === 'NOT_FOUND') {
      req.flash('error', 'License not found');
      return res.redirect('/licenses');
    }
    if (err.message === 'SEAT_VALIDATION' && err.flash) {
      req.flash('error', err.flash);
      return res.redirect(`/licenses/${id}/edit`);
    }
    if (err.message === 'DATE_RANGE_INVALID' && err.flash) {
      req.flash('error', err.flash);
      return res.redirect(`/licenses/${id}/edit`);
    }
    // Map the resolveOptionalField sentinels (INVALID_VENDOR / INVALID_LICENSE_TYPE
    // / INVALID_NOTES) to a specific validation message instead of falling
    // through to the generic server-error flash — a rejected value is a client
    // error that retrying can never fix (mirrors the INVALID_ mapping in
    // vendors.js). Previously these sentinels were thrown but never handled.
    if (err.message.startsWith('INVALID_')) {
      req.flash('error', `Invalid ${titleCase(err.message.replace('INVALID_', ''))}`);
      return res.redirect(`/licenses/${id}/edit`);
    }
    logError('License update error:', err);
    req.flash('error', 'Error updating license. Please try again.');
    return res.redirect(`/licenses/${id}/edit`);
  }
});

// Delete license
router.delete('/:id', requireAdminOrManager, licenseWriteLimiter, (req, res) => {
  // Fail closed on HTTP parameter pollution: reject array payloads. Mirrors the
  // array-rejection guards on every other write route in the app.
  const hppErrors = rejectHppArrays(req, ['id']);
  if (hppErrors.length > 0) {
    req.flash('error', 'Invalid request parameters');
    return res.redirect('/licenses');
  }

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
      const existing = _licenseShowStmt.get(id);
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
      req.flash('success', 'License deleted.');
      invalidateDashboardCache();
    }
  } catch (err) {
    logError('License delete error:', err);
    req.flash('error', 'Error deleting license.');
  }
  return res.redirect('/licenses');
});

module.exports = router;
// Exposed for unit testing (mirrors the pattern in vendors.js / changes.js).
module.exports.resolveSeats = _resolveSeats;
module.exports.resetCachedStatements = () => {};
