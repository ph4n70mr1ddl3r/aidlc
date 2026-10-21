const db = require('../models/database');
const { requireAuth, requireAdminOrManager, canAccessResource } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { paginate, paginationBaseUrl, addSearch, buildFilters, safeId, isPresentInvalidId, safePositiveFloat, safeDate, trim, getActiveStaff, isActiveUser, isPrivileged, ensureAssigneeInList, countQuery, selectQuery, safeQueryValue, safeFilters, safeSort, isValidAssetTag, rejectHppArrays, resolveOptionalField, resolveEnumField, findBlankTextField, findNonStringField, titleCase, authKeyGenerator, logError, capList } = require('../utils');
const { ASSET_CATEGORIES: VALID_CATEGORIES, ASSET_STATUSES: VALID_STATUSES, ASSET_CONDITIONS: VALID_CONDITIONS, MAX_MEDIUM_STR, MAX_SHORT_STR, MAX_NOTES, MAX_ASSET_TAG, ASSET_TAG_PREFIX, ASSIGNED_ITEMS_CAP } = require('../constants');
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
// The related-ticket queries fetch ONE ROW BEYOND the cap (the "+ 1"): the
// extra row is the truncation probe, so the route can tell "the list holds
// exactly cap rows and is complete" apart from "rows were dropped". The
// "(N+)" marker in the view is driven by that exact flag — the old
// `length >= cap` heuristic claimed a truncation that did not exist.
const _relatedTicketsStmt = db.prepare(`
    SELECT id, ticket_number, title, status, priority, assigned_to, created_at
    FROM tickets WHERE asset_id = ?
    ORDER BY created_at DESC, id DESC LIMIT ${ASSIGNED_ITEMS_CAP + 1}
  `);
// Non-privileged variant: the access predicate is applied IN SQL so the
// LIMIT caps the rows the viewer may actually see. Applying the cap first and
// filtering afterwards (the previous shape) let an authorised viewer be shown
// "No tickets linked to this asset" whenever their own ticket fell outside the
// newest-N window, while a privileged viewer saw the newest N.
const _relatedTicketsOwnedStmt = db.prepare(`
    SELECT id, ticket_number, title, status, priority, assigned_to, created_at
    FROM tickets WHERE asset_id = ? AND assigned_to = ?
    ORDER BY created_at DESC, id DESC LIMIT ${ASSIGNED_ITEMS_CAP + 1}
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
// Maximum number of tag attempts inside a single create transaction. The
// counter advances on every attempt, so a bounded loop walks past a small
// number of already-taken tags without ever spinning forever.
const MAX_TAG_ATTEMPTS = 10;
// Read-only preview of next tag (does NOT increment the counter)
const _assetCounterPreviewStmt = db.prepare(`
    SELECT COALESCE(MAX(next_seq), 0) + 1 as next_seq FROM asset_counter WHERE counter_key = 'asset_tag'
  `);

const SORT_MAP = Object.freeze({
  name_asc: 'a.name ASC, a.id ASC',
  name_desc: 'a.name DESC, a.id DESC',
  newest: 'a.created_at DESC, a.id DESC',
  oldest: 'a.created_at ASC, a.id ASC',
  status: "CASE a.status WHEN 'in_use' THEN 1 WHEN 'in_storage' THEN 2 WHEN 'in_repair' THEN 3 WHEN 'reserved' THEN 4 WHEN 'disposed' THEN 5 END, a.name ASC, a.id ASC",
  default: 'a.name ASC, a.id ASC'
});

// List assets (paginated)
router.get('/', (req, res) => {
  req.audit('read', 'asset', null, 'Viewed assets list');
  // Fail closed on HTTP parameter pollution: reject array payloads on query
  // params. Mirrors the explicit HPP guard on GET /audit and the array-rejection
  // convention used by every write route in the app.
  const hppErrors = rejectHppArrays(req, ['search', 'sort', 'status', 'category', 'assigned_to']);
  if (hppErrors.length > 0) {
    req.flash('error', 'Invalid request parameters');
    return res.redirect('/assets');
  }
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
  // Search only over the columns the list itself renders. `a.serial_number`
  // is deliberately NOT searchable: it is shown exclusively on the detail
  // page, which a staff user can only open for an asset assigned to them
  // (canAccessResource), so matching against it turned the search box into a
  // content oracle — a viewer denied GET /assets/:id could confirm that a
  // serial number they guessed belonged to an inventory asset. Same defect
  // class the change-log list closed in an earlier pass.
  // `a.location` IS searchable: the list renders it in its own column, so
  // leaving it out made a rendered column impossible to find. The same
  // applies to `a.condition_rating` — the list renders a Condition badge and
  // offers no condition filter, so before this the column could not be used
  // to find a row at all.
  //
  // The Name cell renders the manufacturer and the name TOGETHER ("Dell
  // OptiPlex 7090"), so the search matches their CONCATENATION: searching
  // the two columns separately left the text the user could see unfindable
  // ("Dell OptiPlex" matched nothing, while "Dell" and "OptiPlex" each did).
  //
  // The "Assigned To" cell renders the assignee's name as ONE string
  // ("<first> <last>"), so it is matched the same way — the name the user
  // reads off the page can be typed back in to find the row. The same rule
  // the project/knowledge/change lists already follow for their name cells.
  addSearch(where, params, safeQueryValue(req.query.search), [
    'a.asset_tag',
    'a.location',
    'a.condition_rating',
    { concat: ['a.manufacturer', 'a.name'] },
    { concat: ['u.first_name', 'u.last_name'] }
  ]);

  const whereClause = where.length ? where.join(' AND ') : '1=1';
  const orderBy = safeSort(safeQueryValue(req.query.sort), SORT_MAP, 'default');

  // The count query needs the same JOIN as the list query: the search now
  // covers the assignee's name, which lives in the joined users table.
  const total = countQuery(db, 'assets', 'a', whereClause, params, 'LEFT JOIN users u ON a.assigned_to = u.id');
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
    filters: safeFilters(req.query, ['search', 'status', 'category', 'assigned_to', 'sort']),
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
    logError('Asset counter preview error:', err);
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
  const purchase_date = safeQueryValue(req.body.purchase_date);
  const purchase_price = safeQueryValue(req.body.purchase_price);
  const warranty_expiry = safeQueryValue(req.body.warranty_expiry);
  const assigned_to = safeQueryValue(req.body.assigned_to);
  const location = trim(safeQueryValue(req.body.location));
  const notes = trim(safeQueryValue(req.body.notes));
  // Fail closed on present-but-non-string optional text fields (e.g. JSON
  // numbers/objects): trim() coerces them to '', which would silently store
  // NULL — the same fail-closed convention the update route enforces via
  // resolveOptionalField's error sentinel. Mirrors the vendors.js create guard.
  // status/condition_rating are included: without a guard a non-string collapses
  // to '' and silently falls back to the 'in_storage'/'good' defaults with a
  // success flash (the update route already guards both).
  // `name` and `category` are included too: they are the required columns,
  // and without a guard a JSON number reached the "Name and category are
  // required" check — a type error reported as a missing field, while the
  // update route reports the same submission as "Invalid request parameters".
  for (const field of ['name', 'category', 'manufacturer', 'model', 'serial_number', 'location', 'notes', 'status', 'condition_rating']) {
    const v = req.body[field];
    if (v !== undefined && v !== null && v !== '' && typeof v !== 'string') {
      req.flash('error', 'Invalid request parameters');
      return res.redirect('/assets/new');
    }
  }
  if (!name || !category) {
    req.flash('error', 'Name and category are required');
    return res.redirect('/assets/new');
  }

  // A present-but-whitespace-only value is neither an ABSENT field ("not
  // submitted") nor an intentional empty string ("clear the column") — it is
  // an INVALID value. The matching UPDATE route rejects the identical value
  // through resolveOptionalField's blank-value guard ("Invalid Manufacturer"),
  // so the create route must not accept it, store NULL and flash success:
  // the same column, two verdicts. The app-wide rule the README documents
  // ("a whitespace-only value ... is rejected like any other invalid value")
  // applies to the create verb exactly as it does to the update verb.
  const blankField = findBlankTextField(req.body, ['manufacturer', 'model', 'serial_number', 'location', 'notes']);
  if (blankField) {
    req.flash('error', `Invalid ${titleCase(blankField)}`);
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
    req.flash('error', 'Invalid Category');
    return res.redirect('/assets/new');
  }
  // Enum resolution: a present-but-blank status (an empty string or a
  // whitespace-only one) is an INVALID value, not an omitted one — it used to
  // trim to '' and silently fall back to the 'in_storage' default with a
  // success flash, so a garbage submission was accepted as a valid asset.
  // An ABSENT status still defaults to 'in_storage'.
  // The `status` column is NOT NULL, so an empty value has no valid meaning —
  // the same rule the update route applies to the same field. The create
  // route used to accept it and silently defaulted, so create and update
  // reported the same condition differently.
  const statusEnum = resolveEnumField(req.body.status, VALID_STATUSES);
  if (statusEnum.state === 'blank' || statusEnum.state === 'invalid' || statusEnum.state === 'empty') {
    req.flash('error', 'Invalid Status');
    return res.redirect('/assets/new');
  }
  const safeStatus = statusEnum.state === 'valid' ? statusEnum.value : 'in_storage';
  const conditionEnum = resolveEnumField(req.body.condition_rating, VALID_CONDITIONS);
  if (conditionEnum.state === 'blank' || conditionEnum.state === 'invalid') {
    req.flash('error', 'Invalid Condition Rating');
    return res.redirect('/assets/new');
  }
  const safeCondition = conditionEnum.state === 'valid' ? conditionEnum.value : 'good';

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
    req.flash('error', 'Invalid Purchase Date');
    return res.redirect('/assets/new');
  }
  if (warranty_expiry !== undefined && warranty_expiry !== null && warranty_expiry !== '' && sWarranty === null) {
    req.flash('error', 'Invalid Warranty Expiry Date');
    return res.redirect('/assets/new');
  }
  if (sPurchase && sWarranty && sWarranty < sPurchase) {
    req.flash('error', 'Warranty expiry must be on or after purchase date');
    return res.redirect('/assets/new');
  }

  // Fail closed on malformed purchase price (LOW). A present, non-empty price
  // that fails to parse must be rejected rather than silently stored as NULL,
  // which would drop a legitimate price on a typo'd submission. An empty/omitted
  // price is allowed (defaults to 0 — a blank form field means "not recorded";
  // the update path instead PRESERVES the stored value on absence). Mirrors
  // licenses create cost handling.
  // Mirrors the assets UPDATE path (11th pass) and licenses create (9th pass).
  // Note: the schema declares purchase_price as a nullable REAL; this create
  // path is stricter by convention, writing 0 rather than NULL.
  if (purchase_price !== undefined && purchase_price !== null && purchase_price !== '' &&
      !Number.isFinite(safePositiveFloat(purchase_price, Infinity))) {
    req.flash('error', 'Invalid Purchase Price');
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
    req.flash('error', 'Invalid Assignee');
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

      // Generate the tag from the counter and INSERT it. A tag collision is
      // possible because asset_tag is admin-editable on the update route: an
      // admin can rename an asset to the exact tag the counter will hand out
      // next. The counter increment lives in the same transaction as the
      // INSERT, so a failed INSERT rolled the increment back too — the next
      // attempt regenerated the SAME colliding tag and the create route was
      // wedged for good (every retry failed identically until an admin
      // renamed the conflicting asset by hand).
      //
      // Fix: retry inside the transaction. Each attempt consumes another
      // counter value, so the loop walks past the taken tag(s) and commits
      // the accumulated increments; only the successfully inserted tag is
      // persisted. A serial_number collision is a DIFFERENT unique constraint
      // and must NOT be retried — it is rethrown so the catch block below
      // can report it accurately.
      let lastTagError = null;
      for (let attempt = 0; attempt < MAX_TAG_ATTEMPTS; attempt++) {
        const counterRow = _assetCounterGetStmt.get();
        const asset_tag = ASSET_TAG_PREFIX + String(counterRow.next_seq).padStart(3, '0');
        try {
          const result = _insertStmt.run(
            asset_tag, name.substring(0, MAX_MEDIUM_STR), category, (manufacturer || '').substring(0, MAX_SHORT_STR) || null,
            (model || '').substring(0, MAX_SHORT_STR) || null, (serial_number || '').substring(0, MAX_SHORT_STR) || null,
            safeStatus, safeCondition, sPurchase,
            safePurchasePrice,
            sWarranty, createAssignee, (location || '').substring(0, MAX_SHORT_STR) || null, (notes || '').substring(0, MAX_NOTES) || null
          );
          return { asset_tag, id: result.lastInsertRowid };
        } catch (insertErr) {
          // Only a UNIQUE violation on asset_tag is retryable — a serial_number
          // collision (or any other error) must surface to the catch block.
          if (insertErr.code !== 'SQLITE_CONSTRAINT_UNIQUE' || !/asset_tag/.test(insertErr.message)) {
            throw insertErr;
          }
          lastTagError = insertErr;
        }
      }
      // Every attempt hit an already-taken tag — surface the last collision so
      // the catch block reports the tag conflict rather than a generic error.
      throw lastTagError;
    });

    const { asset_tag, id } = createAsset();
    req.audit('create', 'asset', id, `Created asset ${asset_tag}`);
    req.flash('success', `Asset ${asset_tag} created successfully.`);
    invalidateDashboardCache();
    return res.redirect('/assets');
  } catch (err) {
    if (err.message === 'ASSIGNEE_NOT_AVAILABLE') {
      req.flash('error', 'Selected assignee is not available');
      return res.redirect('/assets/new');
    }
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      // Two unique constraints live on assets: the asset_tag column and the
      // partial serial_number index. Branch on the constraint message so a
      // duplicate serial no longer reports the misleading "tag" message.
      req.flash('error', /serial_number/.test(err.message)
        ? 'An asset with this serial number already exists'
        : 'An asset with this tag already exists');
    } else {
      logError('Asset create error:', err);
      req.flash('error', 'Error creating asset. Please try again.');
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
    // Use the same non-enumerating wording as the 'not found' branch above: a
    // distinct "you do not have permission" message reveals that the asset ID
    // exists even though the viewer was refused the record. Mirrors the
    // changes/knowledge show routes, which answer both branches identically.
    req.flash('error', 'Asset not found');
    return res.redirect('/assets');
  }

  req.audit('read', 'asset', id, `Viewed asset: ${asset.name}`);

  // Related-ticket metadata (number/title/status/priority/assignee) is scoped
  // to the viewer's ticket access — without the gate a non-privileged assignee
  // of the asset could harvest metadata for linked tickets they cannot open
  // (the ticket show route's canAccessResource would deny them), an IDOR
  // asymmetry the link itself was meant to prevent. The template still applies
  // its own per-row canView check for the link vs. text rendering, which now
  // matches the route-level scoping.
  //
  // The access predicate is applied IN SQL for non-privileged viewers so the
  // LIMIT caps the *accessible* rows rather than the newest rows overall.
  // The JS canAccessResource filter is retained as defence-in-depth.
  const viewerPrivileged = isPrivileged(req.session.user);
  const relatedTicketsCap = capList(
    viewerPrivileged
      ? _relatedTicketsStmt.all(id)
      : _relatedTicketsOwnedStmt.all(id, req.session.user.id),
    ASSIGNED_ITEMS_CAP
  );
  const relatedTickets = relatedTicketsCap.rows.filter(t => canAccessResource(req, t));

  // Redact assigned_email for non-privileged viewers — staff should not be able
  // to harvest other users' emails from asset detail pages. Shallow-copy before
  // deleting the property so the DB query result object is not mutated in place
  // (a mutated row could leak PII across requests if better-sqlite3 ever caches
  // result objects). Mirrors the safeTicket shallow-copy pattern in tickets.js.
  const safeAsset = { ...asset };
  if (!isPrivileged(req.session.user)) {
    safeAsset.assigned_email = null;
  }

  res.render('pages/assets/show', {
    title: asset.name,
    asset: safeAsset,
    relatedTickets,
    // The exact truncation flag for the related-ticket list (computed from the
    // one-row-beyond-the-cap probe the query fetches).
    relatedTicketsTruncated: relatedTicketsCap.truncated
  });
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

  // Fail closed on a present-but-wrong-typed body field (e.g. a JSON number in
  // a name field): a wrong TYPE is neither an absent field nor an invalid
  // VALUE, and the app-wide wording for it is "Invalid request parameters" —
  // the same sentence the CREATE route reports for the identical submission.
  // The field-specific wording ("Invalid Manufacturer", "Invalid Notes", …) is
  // reserved for the case it describes: a whitespace-only VALUE. Without this
  // guard the same column produced two different messages depending on the
  // verb (the create route said "Invalid request parameters", the update route
  // said "Invalid Manufacturer").
  const wrongTypeField = findNonStringField(req.body, [
    'asset_tag', 'name', 'category', 'manufacturer', 'model', 'serial_number',
    'status', 'condition_rating', 'location', 'notes'
  ]);
  if (wrongTypeField) {
    req.flash('error', 'Invalid request parameters');
    return res.redirect(`/assets/${id}/edit`);
  }

  const asset_tag = trim(safeQueryValue(req.body.asset_tag));
  const name = trim(safeQueryValue(req.body.name));
  const category = trim(safeQueryValue(req.body.category));
  // Raw body values (NOT trimmed) are needed to distinguish an ABSENT optional
  // text field (partial submission — preserve stored value) from an explicit
  // empty string (clear the field). trim() collapses undefined to '', so the raw
  // values are captured here for the resolveOptionalField resolution inside the
  // transaction below. Mirrors the raw-vs-processed split in vendors.js and
  // licenses.js.
  const rawAssetTag = req.body.asset_tag;
  const rawName = req.body.name;
  const rawCategory = req.body.category;
  const rawManufacturer = req.body.manufacturer;
  const rawModel = req.body.model;
  const rawSerialNumber = req.body.serial_number;
  const rawLocation = req.body.location;
  const rawNotes = req.body.notes;
  const manufacturer = trim(safeQueryValue(req.body.manufacturer));
  const model = trim(safeQueryValue(req.body.model));
  const serial_number = trim(safeQueryValue(req.body.serial_number));
  const purchase_date = safeQueryValue(req.body.purchase_date);
  const purchase_price = safeQueryValue(req.body.purchase_price);
  const warranty_expiry = safeQueryValue(req.body.warranty_expiry);
  const assigned_to = safeQueryValue(req.body.assigned_to);
  const location = trim(safeQueryValue(req.body.location));
  const notes = trim(safeQueryValue(req.body.notes));

  // Absent-vs-present markers for the three required columns. An ABSENT field
  // in a partial API submission preserves the stored value (resolved inside the
  // transaction from the re-read row) — the same contract every other field
  // on this route already follows and the one the route's own comments state
  // ("an absent field means 'keep what's stored'"). The tag, name and category
  // were the sole exception: a partial PUT that only changed the status was
  // rejected outright with "Asset tag, name, and category are required" even
  // though the stored values were perfectly valid. A PRESENT but empty value
  // is still rejected — all three columns are NOT NULL and an empty value has
  // no valid meaning.
  const assetTagAbsent = rawAssetTag === undefined || rawAssetTag === null;
  const nameAbsent = rawName === undefined || rawName === null;
  const categoryAbsent = rawCategory === undefined || rawCategory === null;
  // Fail closed on present-but-non-string values (e.g. a JSON number): trim()
  // coerces them to '', which would silently become a "required" error rather
  // than the specific invalid-value error the sibling guards report. Absent and
  // empty submissions are allowed (absent ⇒ preserve). A wrong-typed value is
  // rejected by the findNonStringField guard above.
  if ((!assetTagAbsent && !asset_tag) || (!nameAbsent && !name) || (!categoryAbsent && !category)) {
    req.flash('error', 'Asset tag, name, and category are required');
    return res.redirect(`/assets/${id}/edit`);
  }
  // The two failures are reported separately: an over-long tag ("AST-" plus
  // 47 digits) DOES match the AST-XXX format, so telling the user it "must
  // match format AST-XXX" misdescribed the actual problem and left the user
  // re-formatting a tag that was already well-formed.
  if (!assetTagAbsent && asset_tag.length > MAX_ASSET_TAG) {
    req.flash('error', `Asset tag must be at most ${MAX_ASSET_TAG} characters`);
    return res.redirect(`/assets/${id}/edit`);
  }
  if (!assetTagAbsent && !isValidAssetTag(asset_tag)) {
    req.flash('error', 'Asset tag must match format AST-XXX (e.g. AST-001)');
    return res.redirect(`/assets/${id}/edit`);
  }
  if (!nameAbsent && name.length > MAX_MEDIUM_STR) {
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
  // A present-but-non-string condition/status value is rejected by the
  // findNonStringField guard above (the app-wide type-error wording), so the
  // enum checks below only ever see a string: a value outside the allowlist
  // is an invalid VALUE and keeps its field-specific message. Absent/empty
  // submissions are allowed (preserve stored value).
  if (!categoryAbsent && !VALID_CATEGORIES.includes(category)) {
    req.flash('error', 'Invalid Category');
    return res.redirect(`/assets/${id}/edit`);
  }
  // Enum resolution — the presence test runs against the RAW submitted value
  // so a present-but-blank enum is rejected instead of being silently
  // ignored:
  //   - 'blank'   (whitespace-only) → always rejected;
  //   - 'invalid' (not a member)    → always rejected;
  //   - 'empty'   (an empty string) → rejected for the NOT NULL `status`
  //                column (an empty value has no valid meaning, the same rule
  //                the required tag/name/category columns follow) and treated
  //                as "not submitted" for the nullable `condition_rating`
  //                column, whose stored rating is preserved;
  //   - 'absent'                    → the stored value is preserved.
  const statusEnum = resolveEnumField(req.body.status, VALID_STATUSES);
  if (statusEnum.state === 'blank' || statusEnum.state === 'invalid' || statusEnum.state === 'empty') {
    req.flash('error', 'Invalid Status');
    return res.redirect(`/assets/${id}/edit`);
  }
  const conditionEnum = resolveEnumField(req.body.condition_rating, VALID_CONDITIONS);
  if (conditionEnum.state === 'blank' || conditionEnum.state === 'invalid') {
    req.flash('error', 'Invalid Condition Rating');
    return res.redirect(`/assets/${id}/edit`);
  }

  // Fail closed on malformed purchase price (MEDIUM). A present, non-empty
  // price that fails to parse must be rejected rather than silently stored as
  // NULL, which would wipe a legitimate stored price on a partial edit. An
  // empty/omitted price preserves the existing stored value (read inside the
  // transaction, TOCTOU-safe, mirroring licenses.js / projects.js).
  if (purchase_price !== undefined && purchase_price !== null && purchase_price !== '' &&
      !Number.isFinite(safePositiveFloat(purchase_price, Infinity))) {
    req.flash('error', 'Invalid Purchase Price');
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
    req.flash('error', 'Invalid Purchase Date');
    return res.redirect(`/assets/${id}/edit`);
  }
  if (warranty_expiry !== undefined && warranty_expiry !== null && warranty_expiry !== '' && sWarranty === null) {
    req.flash('error', 'Invalid Warranty Expiry Date');
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
    req.flash('error', 'Invalid Assignee');
    return res.redirect(`/assets/${id}/edit`);
  }

  try {
    // Verify asset exists, re-read current state inside the transaction, validate
    // assignee, and update in a single transaction to avoid TOCTOU races: the
    // asset could be deleted, prices/dates modified, or the assignee deactivated
    // between the outer checks and the UPDATE.
    // effectiveTag is hoisted out of the transaction so the audit entry names
    // the EFFECTIVE (resolved) tag even when the request omitted it.
    let effectiveTag = asset_tag;
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
      // preserve-existing fallback). A present-but-invalid or present-but-blank
      // status was already rejected above, so this branch only handles an
      // absent submission.
      const safeStatus = statusEnum.state === 'valid' ? statusEnum.value : current.status;

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
      // Preserve the stored condition rating when the field is absent on a
      // partial edit, so editing an unrelated field cannot silently reset a
      // stored 'poor'/'fair' rating back to the 'good' default. Invalid and
      // whitespace-only present values were already rejected above (fail
      // closed); an explicit empty value is treated as "not submitted" so the
      // stored rating survives.
      const resolvedCondition = conditionEnum.state === 'valid' ? conditionEnum.value : current.condition_rating;

      // Absent-vs-empty convention for the optional text fields: an ABSENT field
      // (partial API submission) preserves the stored value, while an explicit
      // empty string (the edit form's cleared input) CLEARS it (null). A present
      // non-string value is rejected via resolveOptionalField's error sentinel.
      // Previously these fields were unconditionally overwritten, so a partial
      // PUT that omitted them silently wiped the stored values — the exact bug
      // class already fixed for assignee/status/price/dates/condition above.
      // Mirrors the update convention in changes.js / licenses.js / vendors.js.
      const resolvedManufacturer = resolveOptionalField(rawManufacturer, manufacturer || null, MAX_SHORT_STR, current.manufacturer);
      if (resolvedManufacturer && resolvedManufacturer.error) {
        throw new Error('INVALID_MANUFACTURER');
      }
      const resolvedModel = resolveOptionalField(rawModel, model || null, MAX_SHORT_STR, current.model);
      if (resolvedModel && resolvedModel.error) {
        throw new Error('INVALID_MODEL');
      }
      const resolvedSerialNumber = resolveOptionalField(rawSerialNumber, serial_number || null, MAX_SHORT_STR, current.serial_number);
      if (resolvedSerialNumber && resolvedSerialNumber.error) {
        throw new Error('INVALID_SERIAL_NUMBER');
      }
      const resolvedLocation = resolveOptionalField(rawLocation, location || null, MAX_SHORT_STR, current.location);
      if (resolvedLocation && resolvedLocation.error) {
        throw new Error('INVALID_LOCATION');
      }
      const resolvedNotes = resolveOptionalField(rawNotes, notes || null, MAX_NOTES, current.notes);
      if (resolvedNotes && resolvedNotes.error) {
        throw new Error('INVALID_NOTES');
      }

      // The required columns follow the same absent-vs-present rule as every
      // other field on this route: an absent field preserves the CURRENT stored
      // value (read inside the transaction, so a concurrent edit cannot be
      // clobbered), a present field replaces it. A present-but-empty value was
      // already rejected above.
      const effectiveAssetTag = assetTagAbsent ? current.asset_tag : asset_tag.substring(0, MAX_ASSET_TAG);
      const effectiveName = nameAbsent ? current.name : name.substring(0, MAX_MEDIUM_STR);
      const effectiveCategory = categoryAbsent ? current.category : category;
      effectiveTag = effectiveAssetTag;

      const result = _updateStmt.run(
        effectiveAssetTag, effectiveName, effectiveCategory,
        resolvedManufacturer, resolvedModel, resolvedSerialNumber, safeStatus, resolvedCondition,
        resolvedPurchase, resolvedPrice,
        resolvedWarranty, resolvedAssignee,
        resolvedLocation, resolvedNotes, id
      );
      if (result.changes === 0) {
        throw new Error('NOT_FOUND');
      }
    });
    updateAsset();

    req.audit('update', 'asset', id, `Updated asset ${effectiveTag}`);
    req.flash('success', 'Asset updated successfully.');
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
    // Map the resolveOptionalField sentinels (INVALID_MANUFACTURER, etc.) to a
    // specific validation message instead of the generic server-error flash —
    // a rejected value is a client error, not a transient failure (mirrors the
    // INVALID_ mapping in vendors.js).
    if (err.message.startsWith('INVALID_')) {
      req.flash('error', `Invalid ${titleCase(err.message.replace('INVALID_', ''))}`);
      return res.redirect(`/assets/${id}/edit`);
    }
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      // Branch on the constraint message the same way create does — a
      // duplicate serial_number (partial unique index) must report the
      // serial message, not the tag one.
      req.flash('error', /serial_number/.test(err.message)
        ? 'An asset with this serial number already exists'
        : 'An asset with this tag already exists');
      return res.redirect(`/assets/${id}/edit`);
    } else {
      logError('Asset update error:', err);
      req.flash('error', 'Error updating asset. Please try again.');
      return res.redirect(`/assets/${id}/edit`);
    }
  }
});

// Delete asset
router.delete('/:id', requireAdminOrManager, assetWriteLimiter, (req, res) => {
  // Fail closed on HTTP parameter pollution: reject array payloads. Mirrors the
  // array-rejection guards on every other write route in the app.
  const hppErrors = rejectHppArrays(req, ['id']);
  if (hppErrors.length > 0) {
    req.flash('error', 'Invalid request parameters');
    return res.redirect('/assets');
  }

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
      req.flash('success', 'Asset deleted.');
      invalidateDashboardCache();
    }
  } catch (err) {
    logError('Asset delete error:', err);
    req.flash('error', 'Error deleting asset.');
  }
  return res.redirect('/assets');
});

module.exports = router;
module.exports.resetCachedStatements = () => {};
