const db = require('../models/database');
const { requireAuth, requireAdminOrManager } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { paginate, paginationBaseUrl, addSearch, buildFilters, safeId, safePositiveFloat, safeDate, trim, getActiveStaff, isActiveUser, isPrivileged, countQuery, selectQuery, safeQueryValue, safeFilters, safeSort, isValidAssetTag, rejectHppArrays } = require('../utils');
const { ASSET_CATEGORIES: VALID_CATEGORIES, ASSET_STATUSES: VALID_STATUSES, ASSET_CONDITIONS: VALID_CONDITIONS, MAX_MEDIUM_STR, MAX_SHORT_STR, MAX_NOTES, MAX_ASSET_TAG, ASSET_TAG_PREFIX } = require('../constants');
const { invalidateDashboardCache } = require('./dashboard');
const rateLimit = require('express-rate-limit');

// Rate limit asset write operations to prevent abuse
const assetWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50,
  message: 'Too many asset operations. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});

const router = require('express').Router();
router.use(requireAuth, auditMiddleware);

// Cached prepared statements for show/edit/delete routes (static SQL).
// List/index queries build dynamic WHERE clauses so can't be cached.
const _showStmt = db.prepare(`
    SELECT a.*, u.first_name || ' ' || u.last_name as assigned_name, u.email as assigned_email
    FROM assets a
    LEFT JOIN users u ON a.assigned_to = u.id
    WHERE a.id = ?
  `);
const _relatedTicketsStmt = db.prepare(`
    SELECT id, ticket_number, title, status, priority, created_at
    FROM tickets WHERE asset_id = ? ORDER BY created_at DESC LIMIT 10
  `);
const _editStmt = db.prepare('SELECT * FROM assets WHERE id = ?');
const _deleteDetachTicketsStmt = db.prepare('UPDATE tickets SET asset_id = NULL WHERE asset_id = ?');
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
  const { page, limit, offset } = paginate(req);

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

  const assets = selectQuery(db, `
    SELECT a.*, u.first_name || ' ' || u.last_name as assigned_name
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
  if (purchase_date && purchase_date !== '' && sPurchase === null) {
    req.flash('error', 'Invalid purchase date');
    return res.redirect('/assets/new');
  }
  if (warranty_expiry && warranty_expiry !== '' && sWarranty === null) {
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

  // Validate assignee is an active user
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
        safePositiveFloat(purchase_price),
        sWarranty, createAssignee, (location || '').substring(0, MAX_SHORT_STR) || null, (notes || '').substring(0, MAX_NOTES) || null
      );
      return { asset_tag, id: result.lastInsertRowid };
    });

    const { asset_tag, id } = createAsset();
    req.audit('create', 'asset', id, `Created asset ${asset_tag}`);
    req.flash('success', `Asset ${asset_tag} created successfully`);
    invalidateDashboardCache();
    res.redirect('/assets');
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
    res.redirect('/assets/new');
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

  const relatedTickets = _relatedTicketsStmt.all(id);

  if (asset.assigned_email && !isPrivileged(req.session.user)) {
    asset.assigned_email = null;
  }

  res.render('pages/assets/show', { title: asset.name, asset, relatedTickets });
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
  const staff = getActiveStaff(db);
  res.render('pages/assets/form', { title: 'Edit Asset', asset, staff, isEdit: true });
});

// Update asset
router.put('/:id', requireAdminOrManager, assetWriteLimiter, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid asset ID');
    return res.redirect('/assets');
  }

  const existingAsset = _editStmt.get(id);
  if (!existingAsset) {
    req.flash('error', 'Asset not found');
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
  const safeCondition = condition_rating || 'good';

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
  if (purchase_date && purchase_date !== '' && sPurchase === null) {
    req.flash('error', 'Invalid purchase date');
    return res.redirect(`/assets/${id}/edit`);
  }
  if (warranty_expiry && warranty_expiry !== '' && sWarranty === null) {
    req.flash('error', 'Invalid warranty expiry date');
    return res.redirect(`/assets/${id}/edit`);
  }
  if (sPurchase && sWarranty && sWarranty < sPurchase) {
    req.flash('error', 'Warranty expiry must be on or after purchase date');
    return res.redirect(`/assets/${id}/edit`);
  }

  // Validate assignee is an active user
  const updateAssignee = assigned_to ? safeId(assigned_to) : null;

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
      if (updateAssignee && !isActiveUser(db, updateAssignee)) {
        throw new Error('ASSIGNEE_NOT_AVAILABLE');
      }

      // Resolve status from the transaction-consistent re-fetch rather than the
      // outer fetch, closing a TOCTOU gap where a concurrent status change
      // between the outer fetch and this UPDATE could be silently overwritten
      // when the submitted status is invalid/absent (which triggers the
      // preserve-existing fallback).
      const safeStatus = VALID_STATUSES.includes(status) ? status : current.status;

      // Preserve the stored price/dates when the field is blank on a partial
      // edit, so editing an unrelated field can't wipe them. Invalid values
      // were already rejected above (fail closed). Read from the current
      // transaction-consistent row to avoid TOCTOU between the outer fetch
      // and this UPDATE.
      const resolvedPrice = (purchase_price === undefined || purchase_price === null || purchase_price === '')
        ? (current.purchase_price ?? 0)
        : safePositiveFloat(purchase_price, Infinity);
      const resolvedPurchase = (purchase_date === undefined || purchase_date === null || purchase_date === '')
        ? current.purchase_date
        : sPurchase;
      const resolvedWarranty = (warranty_expiry === undefined || warranty_expiry === null || warranty_expiry === '')
        ? current.warranty_expiry
        : sWarranty;

      const result = _updateStmt.run(
        asset_tag.substring(0, MAX_ASSET_TAG), name.substring(0, MAX_MEDIUM_STR), category,
        (manufacturer || '').substring(0, MAX_SHORT_STR) || null, (model || '').substring(0, MAX_SHORT_STR) || null,
        (serial_number || '').substring(0, MAX_SHORT_STR) || null, safeStatus, safeCondition,
        resolvedPurchase, resolvedPrice,
        resolvedWarranty, updateAssignee,
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
    res.redirect(`/assets/${id}`);
  } catch (err) {
    if (err.message === 'NOT_FOUND') {
      req.flash('error', 'Asset not found');
      return res.redirect('/assets');
    }
    if (err.message === 'ASSIGNEE_NOT_AVAILABLE') {
      req.flash('error', 'Selected assignee is not available');
      return res.redirect(`/assets/${id}/edit`);
    }
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      req.flash('error', 'An asset with this tag or serial number already exists');
    } else {
      console.error('Asset update error:', err.message);
      req.flash('error', 'Error updating asset. Please check your input and try again.');
    }
    res.redirect(`/assets/${id}/edit`);
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
  res.redirect('/assets');
});

module.exports = router;
