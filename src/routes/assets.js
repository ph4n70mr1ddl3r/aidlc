const db = require('../models/database');
const { requireAuth, requireAdminOrManager, canAccessResource } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { paginate, paginationBaseUrl, addSearch, buildFilters, safeId, isPresentInvalidId, safePositiveFloat, safeDate, trim, getActiveStaff, isActiveUser, isPrivileged, ensureAssigneeInList, countQuery, selectQuery, safeQueryValue, safeFilters, safeSort, isValidAssetTag, rejectHppArrays, authKeyGenerator } = require('../utils');
const { ASSET_CATEGORIES: VALID_CATEGORIES, ASSET_STATUSES: VALID_STATUSES, ASSET_CONDITIONS: VALID_CONDITIONS, MAX_MEDIUM_STR, MAX_SHORT_STR, MAX_NOTES, MAX_ASSET_TAG, ASSET_TAG_PREFIX } = require('../constants');
const { invalidateDashboardCache } = require('./dashboard');
const rateLimit = require('express-rate-limit');

// Rate limit asset write operations to prevent abuse. Keyed per account so a
// single user behind a NAT'd office IP cannot consume the shared write budget.
const assetWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50,
  keyGenerator: authKeyGenerator,
  message: 'Too many asset operations. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});

const router = require('express').Router();
router.use(requireAuth, auditMiddleware);

// Cached prepared statements for show/edit/delete routes (static SQL).
// List/index queries build dynamic WHERE clauses so can't be cached.
const _showStmt = db.prepare(`
    SELECT a.id, a.asset_tag, a.name, a.category, a.manufacturer, a.model, a.serial_number,
      a.status, a.condition_rating, a.purchase_date, a.purchase_price, a.warranty_expiry,
      a.assigned_to, a.location, a.notes, a.created_at, a.updated_at,
      u.first_name || ' ' || u.last_name as assigned_name, u.email as assigned_email
    FROM assets a
    LEFT JOIN users u ON a.assigned_to = u.id
    WHERE a.id = ?
  `);
const _relatedTicketsStmt = db.prepare(`
    SELECT id, ticket_number, title, status, priority, created_at
    FROM tickets WHERE asset_id = ? ORDER BY created_at DESC LIMIT 10
  `);
const _editStmt = db.prepare('SELECT id, asset_tag, name, category, manufacturer, model, serial_number, status, condition_rating, purchase_date, purchase_price, warranty_expiry, assigned_to, location, notes FROM assets WHERE id = ?');
const _deleteDetachTicketsStmt = db.prepare('UPDATE tickets SET asset_id = NULL, updated_at = datetime(\'now\') WHERE asset_id = ?');
const _deleteStmt = db.prepare('DELETE FROM assets WHERE id = ?');
const _insertStmt = db.prepare(`
    INSERT INTO assets (asset_tag, name, category, manufacturer, model, serial_number,
      status, condition_rating, purchase_date, purchase_price, warranty_expiry,
      assigned_to, location, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
const _updateStmt = db.prepare(`
    UPDATE assets SET asset_tag = ?, name = ?, category = ?, manufacturer = ?,
      model = ?, serial_number = ?, status = ?, condition_rating = ?,
      purchase_date = ?, purchase_price = ?, warranty_expiry = ?,
      assigned_to = ?, location = ?, notes = ?, updated_at = datetime('now')
    WHERE id = ?
  `);

// Asset counter for atomic tag generation (prevents race conditions)
const _assetCounterGetStmt = db.prepare(`
    INSERT INTO asset_counter (counter_key, next_seq)
    VALUES ('asset_tag', 1)
    ON CONFLICT(counter_key) DO UPDATE SET next_seq = next_seq + 1
    RETURNING next_seq
  `);
// Read-only preview of next tag (does NOT increment the counter)
const _assetCounterPreviewStmt = db.prepare(`
    SELECT COALESCE(MAX(next_seq), 0) + 1 as next_seq FROM asset_counter WHERE counter_key = 'asset_tag'
  `);

const SORT_MAP = Object.freeze({
  name_asc: 'a.name ASC',
  name_desc: 'a.name DESC',
  newest: 'a.created_at DESC',
  oldest: 'a.created_at ASC',
  status: "CASE a.status WHEN 'in_use' THEN 1 WHEN 'in_storage' THEN 2 WHEN 'in_repair' THEN 3 WHEN 'reserved' THEN 4 WHEN 'disposed' THEN 5 END, a.name ASC",
  default: 'a.name ASC'
});

// List assets (paginated)
router.get('/', (req, res) => {
  const { page: requestedPage, limit } = paginate(req);

  const qCategory = safeQueryValue(req.query.category);
  const qStatus = safeQueryValue(req.query.status);
  const qAssignedTo = safeQueryValue(req.query.assigned_to);
  const filters = buildFilters({
    'a.category': { value: VALID_CATEGORIES.includes(qCategory) ? qCategory : '' },
    'a.status': { value: VALID_STATUSES.includes(qStatus) ? qStatus : '' },
    'a.assigned_to': { value: qAssignedTo ? safeId(qAssignedTo) || '' : '' }
  }, ['a.category', 'a.status', 'a.assigned_to']);

  const where = [...filters.where];
  const params = [...filters.params];
  addSearch(where, params, safeQueryValue(req.query.search), ['a.name', 'a.asset_tag', 'a.serial_number', 'a.manufacturer']);

  const whereClause = where.length ? where.join(' AND ') : '1=1';
  const orderBy = safeSort(safeQueryValue(req.query.sort), SORT_MAP, 'default');

  const total = countQuery(db, 'assets', 'a', whereClause, params);
  const totalPages = Math.ceil(total / limit) || 1;
  // Clamp the requested page to the actual page count so a page beyond the
  // last one (e.g. ?page=999) renders the final page instead of an empty list
  // with a broken "Showing N–M" range (M < N) in the pagination partial.
  const page = Math.min(requestedPage, totalPages);
  const offset = (page - 1) * limit;

  const assets = selectQuery(db, `
    SELECT a.id, a.asset_tag, a.name, a.manufacturer, a.category, a.status, a.condition_rating,
      a.location, a.assigned_to, a.created_at,
      u.first_name || ' ' || u.last_name as assigned_name
    FROM assets a
    LEFT JOIN users u ON a.assigned_to = u.id
    WHERE ${whereClause}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `, [...params, limit, offset]);

  const staff = getActiveStaff(db);

  res.render('pages/assets/index', {
    title: 'Assets', assets, staff,
    filters: safeFilters(req.query, ['search', 'status', 'category', 'assigned_to']),
    page, limit, totalPages, total,
    baseUrl: paginationBaseUrl(req)
  });
});

// New asset form
router.get('/new', requireAdminOrManager, (req, res) => {
  const staff = getActiveStaff(db);
  let previewTag = ASSET_TAG_PREFIX + '001';
  try {
    const previewRow = _assetCounterPreviewStmt.get();
    previewTag = ASSET_TAG_PREFIX + String(previewRow.next_seq).padStart(3, '0');
  } catch (err) {
    console.error('Asset counter preview error:', err.message);
  }
  res.render('pages/assets/form', { title: 'New Asset', asset: { asset_tag: previewTag }, staff, isEdit: false });
});

// Create asset
router.post('/', requireAdminOrManager, assetWriteLimiter, (req, res) => {
  // Fail closed on HTTP parameter pollution: reject array payloads.
  const hppErrors = rejectHppArrays(req, ['name', 'category', 'manufacturer', 'model', 'serial_number', 'status', 'condition_rating', 'purchase_date', 'purchase_price', 'warranty_expiry', 'assigned_to', 'location', 'notes']);
  if (hppErrors.length > 0) {
    req.flash('error', 'Invalid request parameters');
    return res.redirect('/assets/new');
  }

  const name = trim(safeQueryValue(req.body.name));
  const category = trim(safeQueryValue(req.body.category));
  const manufacturer = trim(safeQueryValue(req.body.manufacturer));
  const model = trim(safeQueryValue(req.body.model));
  const serial_number = trim(safeQueryValue(req.body.serial_number));
  const status = trim(safeQueryValue(req.body.status));
  const condition_rating = trim(safeQueryValue(req.body.condition_rating));
  const purchase_date = safeQueryValue(req.body.purchase_date);
  const purchase_price = safeQueryValue(req.body.purchase_price);
  const warranty_expiry = safeQueryValue(req.body.warranty_expiry);
  const assigned_to = safeQueryValue(req.body.assigned_to);
  const location = trim(safeQueryValue(req.body.location));
  const notes = trim(safeQueryValue(req.body.notes));

  if (!name || !category) {
    req.flash('error', 'Name and category are required');
    return res.redirect('/assets/new');
  }
  if (name.length > MAX_MEDIUM_STR) {
    req.flash('error', `Asset name must be at most ${MAX_MEDIUM_STR} characters`);
    return res.redirect('/assets/new');
  }
  if (manufacturer && manufacturer.length > MAX_SHORT_STR) {
    req.flash('error', `Manufacturer must be at most ${MAX_SHORT_STR} characters`);
    return res.redirect('/assets/new');
  }
  if (model && model.length > MAX_SHORT_STR) {
    req.flash('error', `Model must be at most ${MAX_SHORT_STR} characters`);
    return res.redirect('/assets/new');
  }
  if (serial_number && serial_number.length > MAX_SHORT_STR) {
    req.flash('error', `Serial number must be at most ${MAX_SHORT_STR} characters`);
    return res.redirect('/assets/new');
  }
  if (location && location.length > MAX_SHORT_STR) {
    req.flash('error', `Location must be at most ${MAX_SHORT_STR} characters`);
    return res.redirect('/assets/new');
  }
  if (notes && notes.length > MAX_NOTES) {
    req.flash('error', `Notes must be at most ${MAX_NOTES} characters`);
    return res.redirect('/assets/new');
  }

  if (!VALID_CATEGORIES.includes(category)) {
    req.flash('error', 'Invalid category');
    return res.redirect('/assets/new');
  }
  const safeStatus = status || 'in_storage';
  if (!VALID_STATUSES.includes(safeStatus)) {
    req.flash('error', 'Invalid status');
    return res.redirect('/assets/new');
  }
  if (condition_rating && !VALID_CONDITIONS.includes(condition_rating)) {
    req.flash('error', 'Invalid condition rating');
    return res.redirect('/assets/new');
  }
  const safeCondition = condition_rating || 'good';

  // Validate date ordering — warranty cannot expire before purchase, otherwise
  // logically impossible records can be stored. Mirrors the end≥start / expiry≥
  // purchase checks in projects, vendors, licenses, and changes (the only other
  // entities that carry two user-supplied dates).
  const sPurchase = safeDate(purchase_date);
  const sWarranty = safeDate(warranty_expiry);
  // A present, non-empty date that fails to parse must be rejected (fail
  // closed) rather than silently stored as NULL — the exact malformed-date
  // default-to-NULL bug fixed for the assets UPDATE path (11th pass) and for
  // projects.js (8th pass). An empty date is still allowed (falls back to NULL).
  if (purchase_date !== undefined && purchase_date !== null && purchase_date !== '' && sPurchase === null) {
    req.flash('error', 'Invalid purchase date');
    return res.redirect('/assets/new');
  }
  if (warranty_expiry !== undefined && warranty_expiry !== null && warranty_expiry !== '' && sWarranty === null) {
    req.flash('error', 'Invalid warranty expiry date');
    return res.redirect('/assets/new');
  }
  if (sPurchase && sWarranty && sWarranty < sPurchase) {
    req.flash('error', 'Warranty expiry must be on or after purchase date');
    return res.redirect('/assets/new');
  }

  // Fail closed on malformed purchase price (LOW). A present, non-empty price
  // that fails to parse must be rejected rather than silently stored as NULL,
  // which would drop a legitimate price on a typo'd submission. An empty/omitted
  // price is allowed (falls back to NULL, consistent with the update path).
  // Mirrors the assets UPDATE path (11th pass) and licenses create (9th pass).
  if (purchase_price !== undefined && purchase_price !== null && purchase_price !== '' &&
      !Number.isFinite(safePositiveFloat(purchase_price, Infinity))) {
    req.flash('error', 'Invalid purchase price');
    return res.redirect('/assets/new');
  }

  const safePurchasePrice = purchase_price === undefined || purchase_price === null || purchase_price === ''
    ? 0
    : safePositiveFloat(purchase_price, Infinity);

  // Validate assignee is an active user
  // Fail closed on a present-but-malformed id ("abc", "3.5", an HPP array)
  // instead of silently coercing it to NULL via safeId, which would store the
  // asset unassigned with no user feedback. Absent/empty values legitimately
  // mean "unassigned".
  if (isPresentInvalidId(assigned_to)) {
    req.flash('error', 'Invalid assignee');
    return res.redirect('/assets/new');
  }
  const createAssignee = assigned_to ? safeId(assigned_to) : null;

  try {
    // Generate asset tag atomically and validate assignee inside a single
    // transaction to avoid a TOCTOU race where the assignee is deactivated
    // between the check and the INSERT (mirrors the ticket/change patterns).
    const createAsset = db.transaction(() => {
      if (createAssignee && !isActiveUser(db, createAssignee)) {
        throw new Error('ASSIGNEE_NOT_AVAILABLE');
      }

      const counterRow = _assetCounterGetStmt.get();
      const asset_tag = ASSET_TAG_PREFIX + String(counterRow.next_seq).padStart(3, '0');

      const result = _insertStmt.run(
        asset_tag, name.substring(0, MAX_MEDIUM_STR), category, (manufacturer || '').substring(0, MAX_SHORT_STR) || null,
        (model || '').substring(0, MAX_SHORT_STR) || null, (serial_number || '').substring(0, MAX_SHORT_STR) || null,
        safeStatus, safeCondition, sPurchase,
        safePurchasePrice,
        sWarranty, createAssignee, (location || '').substring(0, MAX_SHORT_STR) || null, (notes || '').substring(0, MAX_NOTES) || null
      );
      return { asset_tag, id: result.lastInsertRowid };
    });

    const { asset_tag, id } = createAsset();
    req.audit('create', 'asset', id, `Created asset ${asset_tag}`);
    req.flash('success', `Asset ${asset_tag} created successfully`);
    invalidateDashboardCache();
    return res.redirect('/assets');
  } catch (err) {
    if (err.message === 'ASSIGNEE_NOT_AVAILABLE') {
      req.flash('error', 'Selected assignee is not available');
      return res.redirect('/assets/new');
    }
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      req.flash('error', 'An asset with this tag or serial number already exists');
    } else {
      console.error('Asset create error:', err.message);
      req.flash('error', 'Error creating asset. Please check your input and try again.');
    }
    return res.redirect('/assets/new');
  }
});

// Show asset
router.get('/:id', (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid asset ID');
    return res.redirect('/assets');
  }

  const asset = _showStmt.get(id);

  if (!asset) {
    req.flash('error', 'Asset not found');
    return res.redirect('/assets');
  }

  if (!canAccessResource(req, asset)) {
    req.audit('access_denied', 'asset', id, `Unauthorized view attempt on asset ${asset.asset_tag}`);
    req.flash('error', 'You do not have permission to view this asset');
    return res.redirect('/assets');
  }

  req.audit('read', 'asset', id, `Viewed asset: ${asset.name}`);

  const relatedTickets = _relatedTicketsStmt.all(id);

  // Redact assigned_email for non-privileged viewers — staff should not be able
  // to harvest other users' emails from asset detail pages. Shallow-copy before
  // deleting the property so the DB query result object is not mutated in place
  // (a mutated row could leak PII across requests if better-sqlite3 ever caches
  // result objects). Mirrors the safeTicket shallow-copy pattern in tickets.js.
  const safeAsset = { ...asset };
  if (!isPrivileged(req.session.user)) {
    safeAsset.assigned_email = null;
  }

  res.render('pages/assets/show', { title: asset.name, asset: safeAsset, relatedTickets });
});

// Edit asset form
router.get('/:id/edit', requireAdminOrManager, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid asset ID');
    return res.redirect('/assets');
  }

  const asset = _editStmt.get(id);
  if (!asset) {
    req.flash('error', 'Asset not found');
    return res.redirect('/assets');
  }
  // Ensure the current assignee appears in the dropdown even when they have
  // since been deactivated (is_active = 0). Without this, an edit form would
  // silently render "Unassigned" for an inactive assignee and re-saving would
  // wipe the assignment (data loss). The update route preserves the current
  // assignee when the submitted value is unchanged, so the dropdown value is
  // saveable.
  const staff = ensureAssigneeInList(getActiveStaff(db), asset.assigned_to, db);
  res.render('pages/assets/form', { title: 'Edit Asset', asset, staff, isEdit: true });
});

// Update asset
router.put('/:id', requireAdminOrManager, assetWriteLimiter, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid asset ID');
    return res.redirect('/assets');
  }

  // Fail closed on HTTP parameter pollution: reject array payloads.
  const hppErrors = rejectHppArrays(req, ['asset_tag', 'name', 'category', 'manufacturer', 'model', 'serial_number', 'status', 'condition_rating', 'purchase_date', 'purchase_price', 'warranty_expiry', 'assigned_to', 'location', 'notes']);
  if (hppErrors.length > 0) {
    req.flash('error', 'Invalid request parameters');
    return res.redirect(`/assets/${id}/edit`);
  }

  const asset_tag = trim(safeQueryValue(req.body.asset_tag));
  const name = trim(safeQueryValue(req.body.name));
  const category = trim(safeQueryValue(req.body.category));
  const manufacturer = trim(safeQueryValue(req.body.manufacturer));
  const model = trim(safeQueryValue(req.body.model));
  const serial_number = trim(safeQueryValue(req.body.serial_number));
  const status = trim(safeQueryValue(req.body.status));
  const condition_rating = trim(safeQueryValue(req.body.condition_rating));
  const purchase_date = safeQueryValue(req.body.purchase_date);
  const purchase_price = safeQueryValue(req.body.purchase_price);
  const warranty_expiry = safeQueryValue(req.body.warranty_expiry);
  const assigned_to = safeQueryValue(req.body.assigned_to);
  const location = trim(safeQueryValue(req.body.location));
  const notes = trim(safeQueryValue(req.body.notes));

  if (!asset_tag || !name || !category) {
    req.flash('error', 'Asset tag, name, and category are required');
    return res.redirect(`/assets/${id}/edit`);
  }
  if (!isValidAssetTag(asset_tag) || asset_tag.length > MAX_ASSET_TAG) {
    req.flash('error', 'Asset tag must match format AST-XXX (e.g. AST-001)');
    return res.redirect(`/assets/${id}/edit`);
  }
  if (name.length > MAX_MEDIUM_STR) {
    req.flash('error', `Asset name must be at most ${MAX_MEDIUM_STR} characters`);
    return res.redirect(`/assets/${id}/edit`);
  }
  if (manufacturer && manufacturer.length > MAX_SHORT_STR) {
    req.flash('error', `Manufacturer must be at most ${MAX_SHORT_STR} characters`);
    return res.redirect(`/assets/${id}/edit`);
  }
  if (model && model.length > MAX_SHORT_STR) {
    req.flash('error', `Model must be at most ${MAX_SHORT_STR} characters`);
    return res.redirect(`/assets/${id}/edit`);
  }
  if (serial_number && serial_number.length > MAX_SHORT_STR) {
    req.flash('error', `Serial number must be at most ${MAX_SHORT_STR} characters`);
    return res.redirect(`/assets/${id}/edit`);
  }
  if (location && location.length > MAX_SHORT_STR) {
    req.flash('error', `Location must be at most ${MAX_SHORT_STR} characters`);
    return res.redirect(`/assets/${id}/edit`);
  }
  if (notes && notes.length > MAX_NOTES) {
    req.flash('error', `Notes must be at most ${MAX_NOTES} characters`);
    return res.redirect(`/assets/${id}/edit`);
  }
  if (!VALID_CATEGORIES.includes(category)) {
    req.flash('error', 'Invalid category');
    return res.redirect(`/assets/${id}/edit`);
  }
  if (condition_rating && !VALID_CONDITIONS.includes(condition_rating)) {
    req.flash('error', 'Invalid condition rating');
    return res.redirect(`/assets/${id}/edit`);
  }
  // A present-but-invalid status is rejected; an absent/empty field means
  // "keep what's stored" (resolved inside the transaction). Mirrors the
  // projects.js update convention — previously an invalid status was silently
  // swallowed here and reported as a successful update.
  if (status && !VALID_STATUSES.includes(status)) {
    req.flash('error', 'Invalid status');
    return res.redirect(`/assets/${id}/edit`);
  }

  // Fail closed on malformed purchase price (MEDIUM). A present, non-empty
  // price that fails to parse must be rejected rather than silently stored as
  // NULL, which would wipe a legitimate stored price on a partial edit. An
  // empty/omitted price preserves the existing stored value (read inside the
  // transaction, TOCTOU-safe, mirroring licenses.js / projects.js).
  if (purchase_price !== undefined && purchase_price !== null && purchase_price !== '' &&
      !Number.isFinite(safePositiveFloat(purchase_price, Infinity))) {
    req.flash('error', 'Invalid purchase price');
    return res.redirect(`/assets/${id}/edit`);
  }

  // Validate date ordering — warranty cannot expire before purchase (mirrors
  // the create route and the projects/vendors/licenses/changes checks).
  const sPurchase = safeDate(purchase_date);
  const sWarranty = safeDate(warranty_expiry);
  // A present, non-empty date that fails to parse must be rejected (fail
  // closed) rather than silently overwriting the stored date with NULL — the
  // exact malformed-date default-to-NULL bug fixed for projects.js. An empty
  // date is still allowed to fall back to the existing stored value.
  if (purchase_date !== undefined && purchase_date !== null && purchase_date !== '' && sPurchase === null) {
    req.flash('error', 'Invalid purchase date');
    return res.redirect(`/assets/${id}/edit`);
  }
  if (warranty_expiry !== undefined && warranty_expiry !== null && warranty_expiry !== '' && sWarranty === null) {
    req.flash('error', 'Invalid warranty expiry date');
    return res.redirect(`/assets/${id}/edit`);
  }
  if (sPurchase && sWarranty && sWarranty < sPurchase) {
    req.flash('error', 'Warranty expiry must be on or after purchase date');
    return res.redirect(`/assets/${id}/edit`);
  }

  // Validate assignee is an active user
  // Fail closed on a present-but-malformed id ("abc", "3.5", an HPP array)
  // instead of silently coercing it to NULL via safeId, which would wipe an
  // existing assignment with no user feedback (mirrors the create route).
  if (isPresentInvalidId(assigned_to)) {
    req.flash('error', 'Invalid assignee');
    return res.redirect(`/assets/${id}/edit`);
  }

  try {
    // Verify asset exists, re-read current state inside the transaction, validate
    // assignee, and update in a single transaction to avoid TOCTOU races: the
    // asset could be deleted, prices/dates modified, or the assignee deactivated
    // between the outer checks and the UPDATE.
    const updateAsset = db.transaction(() => {
      const current = _editStmt.get(id);
      if (!current) {
        throw new Error('NOT_FOUND');
      }
      // Resolve the assignee against the transaction-consistent re-fetch using
      // the same absent-vs-empty convention as dates/prices on this route: an
      // ABSENT field (partial API submission) preserves the stored assignment,
      // while an explicit empty string ("Unassigned" in the edit form) clears it
      // (null). Previously an absent field silently wiped the stored assignee —
      // the only other optional fields (dates, price, condition) all preserved
      // on absence, so a partial PUT could drop an assignment by omission.
      const resolvedAssignee = (assigned_to === undefined || assigned_to === null)
        ? (current.assigned_to ?? null)
        : (assigned_to === '' ? null : safeId(assigned_to));
      if (resolvedAssignee && !isActiveUser(db, resolvedAssignee) && Number(resolvedAssignee) !== Number(current.assigned_to)) {
        throw new Error('ASSIGNEE_NOT_AVAILABLE');
      }

      // Resolve status from the transaction-consistent re-fetch rather than the
      // outer fetch, closing a TOCTOU gap where a concurrent status change
      // between the outer fetch and this UPDATE could be silently overwritten
      // when the submitted status is absent (which triggers the
      // preserve-existing fallback). A present-but-invalid status was already
      // rejected above, so this branch only handles absent/empty submissions.
      const safeStatus = VALID_STATUSES.includes(status) ? status : current.status;

      // Resolve price and dates against the freshly-read transaction-consistent
      // row to avoid a TOCTOU between the outer fetch and this UPDATE.
      // - Price (money): an ABSENT *or* EMPTY field preserves the stored value —
      //   a blank money field is not a "clear to NULL" signal (a NULL price is
      //   indistinguishable from "free" and would mislead reports), so only an
      //   explicit numeric value replaces it. Mirrors licenses.js cost handling.
      // - Dates: an ABSENT field (partial API submission) preserves the stored
      //   value, but an EMPTY submitted value ('' — the form's <input type="date">
      //   sends '' when the user clears it) CLEARS it (null). This matches the
      //   absent-vs-empty convention used by vendors.js, licenses.js, and
      //   changes.js; previously an empty date was treated as "preserve", which
      //   made it impossible to clear a purchase/warranty date via the edit form.
      const resolvedPrice = (purchase_price === undefined || purchase_price === null || purchase_price === '')
        ? (current.purchase_price ?? null)
        : safePositiveFloat(purchase_price, Infinity);
      const resolvedPurchase = (purchase_date === undefined || purchase_date === null)
        ? current.purchase_date
        : sPurchase;
      const resolvedWarranty = (warranty_expiry === undefined || warranty_expiry === null)
        ? current.warranty_expiry
        : sWarranty;
      // Validate the warranty range against the RESOLVED values, not just the
      // submitted ones. A partial edit that moves purchase_date forward while
      // leaving warranty_expiry blank would otherwise pass the submitted-only
      // check above yet persist a warranty that expires before purchase. Mirrors
      // the resolved-value range checks in vendors.js / changes.js / projects.js /
      // licenses.js.
      if (resolvedPurchase && resolvedWarranty && resolvedWarranty < resolvedPurchase) {
        throw new Error('WARRANTY_BEFORE_PURCHASE');
      }
      // Preserve the stored condition rating when the field is blank on a
      // partial edit, so editing an unrelated field cannot silently reset a
      // stored 'poor'/'fair' rating back to the 'good' default. Invalid present
      // values were already rejected above (fail closed).
      const resolvedCondition = (condition_rating === undefined || condition_rating === null || condition_rating === '')
        ? current.condition_rating
        : condition_rating;

      const result = _updateStmt.run(
        asset_tag.substring(0, MAX_ASSET_TAG), name.substring(0, MAX_MEDIUM_STR), category,
        (manufacturer || '').substring(0, MAX_SHORT_STR) || null, (model || '').substring(0, MAX_SHORT_STR) || null,
        (serial_number || '').substring(0, MAX_SHORT_STR) || null, safeStatus, resolvedCondition,
        resolvedPurchase, resolvedPrice,
        resolvedWarranty, resolvedAssignee,
        (location || '').substring(0, MAX_SHORT_STR) || null, (notes || '').substring(0, MAX_NOTES) || null, id
      );
      if (result.changes === 0) {
        throw new Error('NOT_FOUND');
      }
    });
    updateAsset();

    req.audit('update', 'asset', id, `Updated asset ${asset_tag}`);
    req.flash('success', 'Asset updated successfully');
    invalidateDashboardCache();
    return res.redirect(`/assets/${id}`);
  } catch (err) {
    if (err.message === 'NOT_FOUND') {
      req.flash('error', 'Asset not found');
      return res.redirect('/assets');
    }
    if (err.message === 'ASSIGNEE_NOT_AVAILABLE') {
      req.flash('error', 'Selected assignee is not available');
      return res.redirect(`/assets/${id}/edit`);
    }
    if (err.message === 'WARRANTY_BEFORE_PURCHASE') {
      req.flash('error', 'Warranty expiry must be on or after purchase date');
      return res.redirect(`/assets/${id}/edit`);
    }
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      req.flash('error', 'An asset with this tag or serial number already exists');
      return res.redirect(`/assets/${id}/edit`);
    } else {
      console.error('Asset update error:', err.message);
      req.flash('error', 'Error updating asset. Please check your input and try again.');
      return res.redirect(`/assets/${id}/edit`);
    }
  }
});

// Delete asset
router.delete('/:id', requireAdminOrManager, assetWriteLimiter, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid asset ID');
    return res.redirect('/assets');
  }

  try {
    const deleteAsset = db.transaction(() => {
      const existing = _editStmt.get(id);
      if (!existing) {
        return { changes: 0, name: null };
      }
      _deleteDetachTicketsStmt.run(id);
      return { changes: _deleteStmt.run(id).changes, name: existing.name };
    });
    const result = deleteAsset();
    if (result.changes === 0) {
      req.flash('error', 'Asset not found');
    } else {
      req.audit('delete', 'asset', id, `Deleted asset "${result.name}"`);
      req.flash('success', 'Asset deleted');
      invalidateDashboardCache();
    }
  } catch (err) {
    console.error('Asset delete error:', err.message);
    req.flash('error', 'Error deleting asset');
  }
  return res.redirect('/assets');
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
module.exports.resetCachedStatements = resetCachedStatements;
