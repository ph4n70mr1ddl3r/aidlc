const db = require('../models/database');
const { requireAuth, requireAdminOrManager, canAccessResource } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { paginate, paginationBaseUrl, safeSort, addSearch, buildFilters, safeId, isPresentInvalidId, safeDate, safeInt, isValidEmail, trim, sanitizePhone, isValidPhone, getActiveStaff, isActiveUser, isPrivileged, parseBooleanFlag, ensureAssigneeInList, countQuery, selectQuery, safeQueryValue, safeFilters, rejectHppArrays, resolveOptionalField, titleCase, authKeyGenerator } = require('../utils');
const { TICKET_CATEGORIES: VALID_CATEGORIES, TICKET_PRIORITIES: VALID_PRIORITIES, TICKET_STATUSES: VALID_STATUSES, MAX_SHORT_STR, MAX_MEDIUM_STR, MAX_DESC, MAX_EMAIL, MAX_PHONE } = require('../constants');
const { invalidateDashboardCache } = require('./dashboard');

const rateLimit = require('express-rate-limit');

// Rate limit ticket write operations to prevent abuse. Keyed per account so a
// single user behind a NAT'd office IP cannot consume the shared write budget.
const ticketWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  keyGenerator: authKeyGenerator,
  message: 'Too many ticket operations. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});

// Key comment rate-limiting by user id (per-account) so a single user can't
// be silenced by another's IP. The IP fallback exists for defense in depth.
// Delegates to the shared utils.authKeyGenerator (user key + normalized-IP
// fallback via rateLimit.ipKeyGenerator for IPv6 subnet prefixing).
const commentKeyGenerator = authKeyGenerator;

const commentRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: commentKeyGenerator,
  message: 'Too many comments. Please slow down.',
  standardHeaders: true,
  legacyHeaders: false
});

const router = require('express').Router();
router.use(requireAuth, auditMiddleware);

// Cached prepared statements for frequently-executed queries.
// Cap the Related-Asset dropdown to bound memory/render cost on large
// inventories — every other list/sidebar query in the app is capped (e.g.
// staff _assignedAssetsStmt LIMIT 50, reports warrantyExpiring LIMIT 500).
// The edit route below ensures the currently-linked asset is still
// represented as "selected" when it falls outside this cap, so re-saving
// can never silently unlink an asset.
const _ASSET_DROPDOWN_LIMIT = 1000;
const _assetListStmt = db.prepare(`SELECT id, asset_tag, name FROM assets ORDER BY name LIMIT ${_ASSET_DROPDOWN_LIMIT}`);
// Fetch a single asset's dropdown columns — used by the edit route to guarantee
// the linked asset appears in the <select> even past the LIMIT above.
const _assetByIdStmt = db.prepare('SELECT id, asset_tag, name FROM assets WHERE id = ?');

// Cached prepared statements for show/edit routes (static SQL).
const _showTicketStmt = db.prepare(`
    SELECT t.id, t.ticket_number, t.title, t.description, t.category, t.priority, t.status,
      t.requester_name, t.requester_email, t.requester_department, t.requester_phone,
      t.assigned_to, t.asset_id, t.due_date, t.resolved_at,
      t.resolution_notes, t.satisfaction_rating, t.created_at, t.updated_at,
      u.first_name || ' ' || u.last_name as assigned_name,
      a.name as asset_name, a.asset_tag
    FROM tickets t
    LEFT JOIN users u ON t.assigned_to = u.id
    LEFT JOIN assets a ON t.asset_id = a.id
    WHERE t.id = ?
  `);
const _showCommentsStmt = db.prepare(`
    SELECT tc.id, tc.ticket_id, tc.user_id, tc.comment, tc.is_internal, tc.created_at,
      u.first_name || ' ' || u.last_name as author_name, u.role as author_role
    FROM ticket_comments tc
    LEFT JOIN users u ON tc.user_id = u.id
    WHERE tc.ticket_id = ?
    ORDER BY tc.created_at DESC
    LIMIT 500
  `);
const _editTicketStmt = db.prepare('SELECT id, ticket_number, title, description, category, priority, status, requester_name, requester_email, requester_department, requester_phone, assigned_to, asset_id, due_date, resolved_at, resolution_notes, satisfaction_rating, created_at, updated_at FROM tickets WHERE id = ?');
const _ticketAssigneeStmt = db.prepare('SELECT assigned_to FROM tickets WHERE id = ?');
const _satisfactionCheckStmt = db.prepare('SELECT status FROM tickets WHERE id = ?');
const _satisfactionUpdateStmt = db.prepare(
  'UPDATE tickets SET satisfaction_rating = ?, updated_at = datetime(\'now\') WHERE id = ?'
);
const _assetExistsStmt = db.prepare('SELECT 1 FROM assets WHERE id = ?');
const _deleteTicketStmt = db.prepare('DELETE FROM tickets WHERE id = ?');

// Cached statement for ticket update route.
// Loads the requester PII columns and due_date so the update transaction can
// preserve them on partial submissions and for non-privileged editors whose
// edit form redacts requester PII (mirrors the show route).
const _updateCheckStmt = db.prepare(
  'SELECT status, category, priority, assigned_to, asset_id, due_date, description, resolution_notes, requester_name, requester_email, requester_department, requester_phone FROM tickets WHERE id = ?'
);
const _updateTicketStmt = db.prepare(`
    UPDATE tickets SET title = ?, description = ?, category = ?, priority = ?,
      status = ?, assigned_to = ?, asset_id = ?, due_date = ?, resolution_notes = ?,
      requester_name = ?, requester_email = ?, requester_department = ?, requester_phone = ?,
      resolved_at = CASE WHEN ? THEN datetime('now') WHEN ? THEN NULL ELSE resolved_at END,
      updated_at = datetime('now')
    WHERE id = ?
  `);

// Cached statements for status update route
const _statusResolveStmt = db.prepare(`
    UPDATE tickets SET status = ?, resolved_at = COALESCE(resolved_at, datetime('now')), updated_at = datetime('now')
    WHERE id = ?
  `);
const _statusUnresolveStmt = db.prepare(`
    UPDATE tickets SET status = ?, resolved_at = NULL, updated_at = datetime('now')
    WHERE id = ?
  `);

// Cached statements for comment route
const _commentInsertStmt = db.prepare(`
    INSERT INTO ticket_comments (ticket_id, user_id, comment, is_internal)
    VALUES (?, ?, ?, ?)
  `);
const _commentTouchStmt = db.prepare('UPDATE tickets SET updated_at = datetime(\'now\') WHERE id = ?');
const _commentExistsStmt = db.prepare('SELECT id, assigned_to FROM tickets WHERE id = ?');

// Cached statements for ticket create route (used inside transaction)
const _ticketCounterStmt = db.prepare(`
    INSERT INTO ticket_counter (counter_date, next_seq)
    VALUES (?, 1)
    ON CONFLICT(counter_date) DO UPDATE SET next_seq = next_seq + 1
    RETURNING next_seq
  `);
const _ticketInsertStmt = db.prepare(`
    INSERT INTO tickets (ticket_number, title, description, category, priority,
      requester_name, requester_email, requester_department, requester_phone,
      assigned_to, asset_id, due_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

const SORT_MAP = Object.freeze({
  newest: 't.created_at DESC',
  oldest: 't.created_at ASC',
  priority: "CASE t.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 END, t.created_at ASC",
  default: 't.created_at DESC'
});

/**
 * Guarantee the ticket's linked asset appears in the Related-Asset dropdown
 * even when it falls outside the _ASSET_DROPDOWN_LIMIT cap, preventing silent
 * data loss on re-save. Returns a new array (does not mutate the input).
 * Pure/exported for testing.
 * @param {Array} assets - the capped list from _assetListStmt
 * @param {Object|null} linkedAsset - the linked asset row from _assetByIdStmt
 * @returns {Array}
 */
function ensureLinkedAssetInList(assets, linkedAsset) {
  if (linkedAsset && !assets.some(a => Number(a.id) === Number(linkedAsset.id))) {
    return [linkedAsset, ...assets];
  }
  return assets;
}

// List tickets (paginated)
router.get('/', (req, res) => {
  const { page: requestedPage, limit } = paginate(req);

  const qStatus = safeQueryValue(req.query.status);
  const qPriority = safeQueryValue(req.query.priority);
  const qCategory = safeQueryValue(req.query.category);
  const qAssignedTo = safeQueryValue(req.query.assigned_to);
  const filters = buildFilters({
    't.status': { value: VALID_STATUSES.includes(qStatus) ? qStatus : '' },
    't.priority': { value: VALID_PRIORITIES.includes(qPriority) ? qPriority : '' },
    't.category': { value: VALID_CATEGORIES.includes(qCategory) ? qCategory : '' },
    't.assigned_to': { value: qAssignedTo ? safeId(qAssignedTo) || '' : '' }
  }, ['t.status', 't.priority', 't.category', 't.assigned_to']);

  const where = [...filters.where];
  const params = [...filters.params];
  addSearch(where, params, safeQueryValue(req.query.search), ['t.title', 't.description', 't.ticket_number']);

  const whereClause = where.length ? where.join(' AND ') : '1=1';
  const orderBy = safeSort(safeQueryValue(req.query.sort), SORT_MAP, 'default');

  const total = countQuery(db, 'tickets', 't', whereClause, params);
  const totalPages = Math.ceil(total / limit) || 1;
  // Clamp the requested page to the actual page count so a page beyond the
  // last one (e.g. ?page=999) renders the final page instead of an empty list
  // with a broken "Showing N–M" range (M < N) in the pagination partial.
  const page = Math.min(requestedPage, totalPages);
  const offset = (page - 1) * limit;

  const tickets = selectQuery(db, `
    SELECT t.id, t.ticket_number, t.title, t.requester_name, t.category, t.priority, t.status, t.assigned_to, t.created_at, u.first_name || ' ' || u.last_name as assigned_name
    FROM tickets t
    LEFT JOIN users u ON t.assigned_to = u.id
    WHERE ${whereClause}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `, [...params, limit, offset]);

  const staff = getActiveStaff(db);

  res.render('pages/tickets/index', {
    title: 'Tickets', tickets, staff,
    filters: safeFilters(req.query, ['search', 'status', 'priority', 'category', 'assigned_to', 'sort']),
    page, limit, totalPages, total,
    baseUrl: paginationBaseUrl(req)
  });
});

// New ticket form
router.get('/new', (req, res) => {
  const staff = getActiveStaff(db);
  const assets = _assetListStmt.all();
  // Pre-fill requester info from logged-in user
  const prefill = {
    requester_name: `${req.session.user.first_name} ${req.session.user.last_name}`,
    requester_email: req.session.user.email,
    requester_department: req.session.user.department || ''
  };
  res.render('pages/tickets/form', { title: 'New Ticket', ticket: prefill, staff, assets, isEdit: false });
});

// Create ticket
router.post('/', ticketWriteLimiter, (req, res) => {
  // Fail closed on HTTP parameter pollution: reject array payloads.
  const hppErrors = rejectHppArrays(req, ['title', 'description', 'category', 'priority', 'assigned_to', 'asset_id', 'due_date', 'requester_name', 'requester_email', 'requester_department', 'requester_phone']);
  if (hppErrors.length > 0) {
    req.flash('error', 'Invalid request parameters');
    return res.redirect('/tickets/new');
  }

  const title = trim(safeQueryValue(req.body.title));
  const description = trim(safeQueryValue(req.body.description));
  // Fail closed on present-but-non-string optional text fields (e.g. JSON
  // numbers/objects): trim() coerces them to '', which would silently store
  // NULL — the same fail-closed convention the update route enforces via
  // resolveOptionalField's error sentinel. Mirrors the vendors.js create guard.
  for (const field of ['description', 'requester_department']) {
    const v = req.body[field];
    if (v !== undefined && v !== null && v !== '' && typeof v !== 'string') {
      req.flash('error', 'Invalid request parameters');
      return res.redirect('/tickets/new');
    }
  }
  const category = trim(safeQueryValue(req.body.category));
  const priority = trim(safeQueryValue(req.body.priority));
  const requester_name = trim(safeQueryValue(req.body.requester_name));
  const requester_email = trim(safeQueryValue(req.body.requester_email)).toLowerCase();
  const requester_department = trim(safeQueryValue(req.body.requester_department));
  const rawRequesterPhone = safeQueryValue(req.body.requester_phone);
  // Reject overly long phone input before expensive sanitization
  if (typeof rawRequesterPhone === 'string' && rawRequesterPhone.length > MAX_PHONE) {
    req.flash('error', `Phone number must be at most ${MAX_PHONE} characters`);
    return res.redirect('/tickets/new');
  }
  const requester_phone = sanitizePhone(rawRequesterPhone);
  // Fail closed on a present-but-malformed phone: a value that sanitizes to
  // nothing (e.g. "abc", or a non-string JSON value) must be rejected rather
  // than silently stored as NULL — the fail-closed convention applied to every
  // other present-but-invalid field. Absent/empty values are allowed (no phone).
  if (rawRequesterPhone !== undefined && rawRequesterPhone !== null && rawRequesterPhone !== '' && !requester_phone) {
    req.flash('error', 'Please enter a valid phone number');
    return res.redirect('/tickets/new');
  }
  const assigned_to = safeQueryValue(req.body.assigned_to);
  const asset_id = safeQueryValue(req.body.asset_id);
  const due_date = safeQueryValue(req.body.due_date);

  if (!title || !category || !requester_name || !requester_email) {
    req.flash('error', 'Title, category, requester name, and requester email are required');
    return res.redirect('/tickets/new');
  }
  if (title.length > MAX_MEDIUM_STR) {
    req.flash('error', `Title must be at most ${MAX_MEDIUM_STR} characters`);
    return res.redirect('/tickets/new');
  }
  if (description && description.length > MAX_DESC) {
    req.flash('error', `Description must be at most ${MAX_DESC} characters`);
    return res.redirect('/tickets/new');
  }

  if (!isValidEmail(requester_email)) {
    req.flash('error', 'Please enter a valid requester email address');
    return res.redirect('/tickets/new');
  }

  if (requester_phone && !isValidPhone(requester_phone)) {
    req.flash('error', 'Please enter a valid phone number');
    return res.redirect('/tickets/new');
  }

  if (requester_name.length > MAX_SHORT_STR) {
    req.flash('error', `Requester name must be at most ${MAX_SHORT_STR} characters`);
    return res.redirect('/tickets/new');
  }
  if (requester_email.length > MAX_EMAIL) {
    req.flash('error', `Requester email must be at most ${MAX_EMAIL} characters`);
    return res.redirect('/tickets/new');
  }
  if (requester_department && requester_department.length > MAX_SHORT_STR) {
    req.flash('error', `Requester department must be at most ${MAX_SHORT_STR} characters`);
    return res.redirect('/tickets/new');
  }

  if (!VALID_CATEGORIES.includes(category)) {
    req.flash('error', 'Invalid category');
    return res.redirect('/tickets/new');
  }
  if (!priority || !VALID_PRIORITIES.includes(priority)) {
    req.flash('error', 'Invalid priority');
    return res.redirect('/tickets/new');
  }

  // Reject a present, non-empty due date that fails to parse (fail-closed)
  // instead of silently storing NULL — mirrors projects/assets/vendors/change-log.
  const safeDueDate = safeDate(due_date);
  if (due_date !== undefined && due_date !== null && due_date !== '' && safeDueDate === null) {
    req.flash('error', 'Invalid due date');
    return res.redirect('/tickets/new');
  }

  // Validate assignee is an active user
  // Fail closed on present-but-malformed assignee/asset ids ("abc", "3.5", an
  // HPP array) instead of silently coercing them to NULL via safeId. Absent/
  // empty values legitimately mean "unassigned"/"no asset".
  if (isPresentInvalidId(assigned_to)) {
    req.flash('error', 'Invalid assignee');
    return res.redirect('/tickets/new');
  }
  if (isPresentInvalidId(asset_id)) {
    req.flash('error', 'Invalid asset');
    return res.redirect('/tickets/new');
  }
  const safeAssignee = assigned_to ? safeId(assigned_to) : null;
  const safeAssetId = asset_id ? safeId(asset_id) : null;

  // Generate ticket number atomically using dedicated counter table.
  // Use UTC date for consistency with DB datetime('now') which stores UTC.
  // Asset existence and assignee active checks are inside the transaction
  // to avoid TOCTOU races between the checks and the INSERT.
  const createTicket = db.transaction(() => {
    // Validate assignee is still active inside the transaction so a concurrent
    // deactivation between the check and the INSERT is not possible.
    if (safeAssignee && !isActiveUser(db, safeAssignee)) {
      throw new Error('ASSIGNEE_NOT_AVAILABLE');
    }
    // Validate linked asset still exists inside the transaction
    if (safeAssetId && !_assetExistsStmt.get(safeAssetId)) {
      throw new Error('ASSET_NOT_FOUND');
    }

    const now = new Date();
    const todayStr = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
    const row = _ticketCounterStmt.get(todayStr);
    const seq = row.next_seq;
    const ticket_number = `TK-${todayStr}-${String(seq).padStart(3, '0')}`;

    const result = _ticketInsertStmt.run(ticket_number, title.substring(0, MAX_MEDIUM_STR), (description || '').substring(0, MAX_DESC) || null, category, priority,
      requester_name.substring(0, MAX_SHORT_STR), requester_email.substring(0, MAX_EMAIL), (requester_department || '').substring(0, MAX_SHORT_STR) || null, requester_phone ? requester_phone.substring(0, MAX_PHONE) : null,
      safeAssignee, safeAssetId, safeDueDate);
    return { ticket_number, id: result.lastInsertRowid };
  });

  try {
    const { ticket_number, id } = createTicket();

    req.audit('create', 'ticket', id, `Created ticket ${ticket_number}`);
    req.flash('success', `Ticket ${ticket_number} created successfully`);
    invalidateDashboardCache();
    return res.redirect('/tickets');
  } catch (err) {
    if (err.message === 'ASSIGNEE_NOT_AVAILABLE') {
      req.flash('error', 'Selected assignee is not available');
      return res.redirect('/tickets/new');
    }
    if (err.message === 'ASSET_NOT_FOUND') {
      req.flash('error', 'Selected asset does not exist');
      return res.redirect('/tickets/new');
    }
    console.error('Ticket create error:', err.message);
    req.flash('error', 'Error creating ticket. Please try again.');
    return res.redirect('/tickets/new');
  }
});

// Show ticket
router.get('/:id', (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid ticket ID');
    return res.redirect('/tickets');
  }

  const ticket = _showTicketStmt.get(id);

  if (!ticket) {
    req.flash('error', 'Ticket not found');
    return res.redirect('/tickets');
  }

  if (!canAccessResource(req, ticket)) {
    req.audit('access_denied', 'ticket', id, `Unauthorized view attempt on ticket ${ticket.ticket_number}`);
    req.flash('error', 'You do not have permission to view this ticket');
    return res.redirect('/tickets');
  }

  req.audit('read', 'ticket', id, `Viewed ticket: ${ticket.ticket_number}`);

  const rawComments = _showCommentsStmt.all(id);
  // Filter internal comments server-side — non-privileged users must not
  // receive internal comments even if the template rendering fails.
  // Always create a new array before reversing to avoid mutating the DB
  // query result in place (a mutated row could leak PII across requests if
  // better-sqlite3 ever caches result objects). Mirrors the shallow-copy
  // pattern used for safeTicket above.
  const comments = isPrivileged(req.session.user)
    ? [...rawComments].reverse()
    : rawComments.filter(c => !c.is_internal).reverse();

  // Redact end-user (requester) PII for non-privileged viewers. Requester
  // email/phone/department belong to non-staff end users and must not be
  // exposed to every authenticated staff member who opens a ticket URL.
  // Shallow-copy before deleting properties so the query result object is not
  // mutated in place (better-sqlite3 returns fresh objects today, but this
  // guards against future caching changes that could leak PII across requests).
  const safeTicket = { ...ticket };
  if (!isPrivileged(req.session.user)) {
    delete safeTicket.requester_email;
    delete safeTicket.requester_phone;
    delete safeTicket.requester_department;
  }

  res.render('pages/tickets/show', { title: `Ticket ${ticket.ticket_number}`, ticket: safeTicket, comments });
});

// Edit ticket form
router.get('/:id/edit', (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid ticket ID');
    return res.redirect('/tickets');
  }

  const ticket = _editTicketStmt.get(id);
  if (!ticket) {
    req.flash('error', 'Ticket not found');
    return res.redirect('/tickets');
  }

  if (!canAccessResource(req, ticket)) {
    req.audit('access_denied', 'ticket', id, 'Unauthorized edit attempt on ticket');
    req.flash('error', 'You can only edit tickets assigned to you');
    return res.redirect(`/tickets/${id}`);
  }

  // Redact end-user (requester) PII for non-privileged viewers on the edit
  // form, matching the show route. Non-privileged staff who can edit an
  // assigned ticket must not be able to read requester email/phone/department
  // from the edit form (the update route preserves the stored values when
  // these fields are absent). Shallow-copy before deleting properties so the
  // DB query result object is not mutated in place — a mutated row could leak
  // PII across requests if better-sqlite3 ever caches result objects.
  const safeTicket = { ...ticket };
  if (!isPrivileged(req.session.user)) {
    delete safeTicket.requester_email;
    delete safeTicket.requester_phone;
    delete safeTicket.requester_department;
  }

  const staff = getActiveStaff(db);
  let assets = _assetListStmt.all();
  // Ensure the currently-linked asset appears in the dropdown even when it
  // falls outside the _ASSET_DROPDOWN_LIMIT cap (large inventory). Without
  // this, a linked asset beyond the cap would not render as "selected", and
  // re-saving the form would silently unlink it (data loss).
  if (ticket.asset_id) {
    assets = ensureLinkedAssetInList(assets, _assetByIdStmt.get(ticket.asset_id));
  }
  // Ensure the current assignee appears in the dropdown even when they have
  // since been deactivated (is_active = 0). Without this, an edit form would
  // silently render "Unassigned" for an inactive assignee and re-saving would
  // wipe the assignment (data loss). The update route preserves the current
  // assignee when the submitted value is unchanged, so the dropdown value is
  // saveable.
  const assigneeOptions = ensureAssigneeInList(staff, ticket.assigned_to, db);
  res.render('pages/tickets/form', { title: 'Edit Ticket', ticket: safeTicket, staff: assigneeOptions, assets, isEdit: true });
});

// Update ticket
router.put('/:id', ticketWriteLimiter, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid ticket ID');
    return res.redirect('/tickets');
  }

  // Fail closed on HTTP parameter pollution: reject array payloads.
  const hppErrors = rejectHppArrays(req, ['title', 'description', 'category', 'priority', 'status', 'assigned_to', 'asset_id', 'due_date', 'resolution_notes', 'requester_name', 'requester_email', 'requester_department', 'requester_phone']);
  if (hppErrors.length > 0) {
    req.flash('error', 'Invalid request parameters');
    return res.redirect(`/tickets/${id}/edit`);
  }

  const title = trim(safeQueryValue(req.body.title));
  // Raw body values (NOT trimmed) are needed to distinguish an ABSENT optional
  // text field (partial submission — preserve stored value) from an explicit
  // empty string (clear the field). Mirrors the raw-vs-processed split used by
  // assets.js / vendors.js / licenses.js updates.
  const rawDescription = req.body.description;
  const rawResolutionNotes = req.body.resolution_notes;
  const description = trim(safeQueryValue(req.body.description));
  const category = trim(safeQueryValue(req.body.category));
  const priority = trim(safeQueryValue(req.body.priority));
  const status = trim(safeQueryValue(req.body.status));
  const assigned_to = safeQueryValue(req.body.assigned_to);
  const asset_id = safeQueryValue(req.body.asset_id);
  const due_date = safeQueryValue(req.body.due_date);
  const resolution_notes = trim(safeQueryValue(req.body.resolution_notes));
  const requester_name = trim(safeQueryValue(req.body.requester_name));
  const requester_email = trim(safeQueryValue(req.body.requester_email)).toLowerCase();
  const requester_department = trim(safeQueryValue(req.body.requester_department));
  // Requester PII (email/phone/department) is only editable by privileged users
  // (admin/manager). The edit form omits these fields entirely for non-
  // privileged editors (matching the show route's redaction), so their
  // submissions lack them and the stored values are preserved inside the
  // transaction rather than failing validation or wiping the data. On create
  // the fields are rendered for everyone, prefilled with the submitter's own
  // PII. requester_name stays editable for everyone.
  const canEditRequesterPII = isPrivileged(req.session.user);
  const rawRequesterPhone = safeQueryValue(req.body.requester_phone);
  const rawRequesterDepartment = safeQueryValue(req.body.requester_department);
  let requester_phone = null;
  if (canEditRequesterPII) {
    // Reject overly long phone input before expensive sanitization
    if (typeof rawRequesterPhone === 'string' && rawRequesterPhone.length > MAX_PHONE) {
      req.flash('error', `Phone number must be at most ${MAX_PHONE} characters`);
      return res.redirect(`/tickets/${id}/edit`);
    }
    requester_phone = sanitizePhone(rawRequesterPhone);
    // Fail closed on a present-but-malformed phone: a value that sanitizes to
    // nothing (e.g. "abc", or a non-string JSON value) must be rejected rather
    // than silently stored as NULL — the fail-closed convention applied to every
    // other present-but-invalid field. Absent/empty values are allowed (no phone).
    if (rawRequesterPhone !== undefined && rawRequesterPhone !== null && rawRequesterPhone !== '' && !requester_phone) {
      req.flash('error', 'Please enter a valid phone number');
      return res.redirect(`/tickets/${id}/edit`);
    }
  }

  if (!title) {
    req.flash('error', 'Title is required');
    return res.redirect(`/tickets/${id}/edit`);
  }
  if (title.length > MAX_MEDIUM_STR) {
    req.flash('error', `Title must be at most ${MAX_MEDIUM_STR} characters`);
    return res.redirect(`/tickets/${id}/edit`);
  }
  if (description && description.length > MAX_DESC) {
    req.flash('error', `Description must be at most ${MAX_DESC} characters`);
    return res.redirect(`/tickets/${id}/edit`);
  }

  // Validate enum fields — validate-when-present, the convention used by the
  // assets/projects/task update routes: a present value must be a member of
  // the allowlist; an ABSENT field (partial API submission) preserves the
  // stored value, resolved inside the transaction below. Previously all three
  // were required on every PUT, so a partial submission that only renamed a
  // ticket failed with "Invalid status/category/priority" — inconsistent with
  // every other optional field on this route (assignee, asset, due date, PII,
  // description, resolution notes), all of which preserve on absence.
  if (category && !VALID_CATEGORIES.includes(category)) {
    req.flash('error', 'Invalid category');
    return res.redirect(`/tickets/${id}/edit`);
  }
  if (priority && !VALID_PRIORITIES.includes(priority)) {
    req.flash('error', 'Invalid priority');
    return res.redirect(`/tickets/${id}/edit`);
  }
  if (status && !VALID_STATUSES.includes(status)) {
    req.flash('error', 'Invalid status');
    return res.redirect(`/tickets/${id}/edit`);
  }

  // Reject a present, non-empty due date that fails to parse (fail-closed)
  // instead of silently overwriting a stored date with NULL when any other
  // field is edited — mirrors projects/assets/vendors/change-log.
  const safeDueDate = safeDate(due_date);
  if (due_date !== undefined && due_date !== null && due_date !== '' && safeDueDate === null) {
    req.flash('error', 'Invalid due date');
    return res.redirect(`/tickets/${id}/edit`);
  }

  if (resolution_notes && resolution_notes.length > MAX_DESC) {
    req.flash('error', `Resolution notes must be at most ${MAX_DESC} characters`);
    return res.redirect(`/tickets/${id}/edit`);
  }

  // Validate requester fields. requester_name is rendered for every editor and
  // must be present; requester email/phone/department are requester PII that
  // only privileged users can see or modify (see canEditRequesterPII above).
  if (!requester_name) {
    req.flash('error', 'Requester name is required');
    return res.redirect(`/tickets/${id}/edit`);
  }
  if (requester_name.length > MAX_SHORT_STR) {
    req.flash('error', `Requester name must be at most ${MAX_SHORT_STR} characters`);
    return res.redirect(`/tickets/${id}/edit`);
  }
  if (canEditRequesterPII) {
    if (!requester_email) {
      req.flash('error', 'Requester email is required');
      return res.redirect(`/tickets/${id}/edit`);
    }
    if (requester_email.length > MAX_EMAIL) {
      req.flash('error', `Requester email must be at most ${MAX_EMAIL} characters`);
      return res.redirect(`/tickets/${id}/edit`);
    }
    if (!isValidEmail(requester_email)) {
      req.flash('error', 'Please enter a valid requester email address');
      return res.redirect(`/tickets/${id}/edit`);
    }
    if (requester_department && requester_department.length > MAX_SHORT_STR) {
      req.flash('error', `Requester department must be at most ${MAX_SHORT_STR} characters`);
      return res.redirect(`/tickets/${id}/edit`);
    }

    if (requester_phone && !isValidPhone(requester_phone)) {
      req.flash('error', 'Please enter a valid phone number');
      return res.redirect(`/tickets/${id}/edit`);
    }
  }

  // Validate assignee is an active user
  // Fail closed on present-but-malformed assignee/asset ids ("abc", "3.5", an
  // HPP array) instead of silently coercing them to NULL via safeId, which
  // would wipe an existing assignment/link with no user feedback. Absent/empty
  // values legitimately mean "unassigned"/"no asset".
  if (isPresentInvalidId(assigned_to)) {
    req.flash('error', 'Invalid assignee');
    return res.redirect(`/tickets/${id}/edit`);
  }
  if (isPresentInvalidId(asset_id)) {
    req.flash('error', 'Invalid asset');
    return res.redirect(`/tickets/${id}/edit`);
  }

  try {
    // Verify ticket still exists, validate assignee/asset, check access, and
    // update in a single transaction to avoid TOCTOU races: the ticket could be
    // deleted, the assignee deactivated, or the asset deleted between the
    // separate checks and the UPDATE.
    // auditStatus captures the EFFECTIVE (resolved) status from inside the
    // transaction so the post-commit audit entry reports the persisted value
    // even when the submission omitted the field (partial update).
    let auditStatus = status;
    const updateTicket = db.transaction(() => {
      const ticket = _updateCheckStmt.get(id);
      if (!ticket) {
        throw new Error('NOT_FOUND');
      }
      if (!canAccessResource(req, ticket)) {
        throw new Error('ACCESS_DENIED');
      }
      // Resolve the assignee/linked asset against the transaction-consistent row
      // using the same absent-vs-empty convention as due_date and requester PII
      // on this route: an ABSENT field (partial API submission) preserves the
      // stored value, while an explicit empty string ("Unassigned"/"No asset" in
      // the form) clears it (null). Previously an absent field silently wiped the
      // stored assignment/link — only due_date/requester PII preserved on absence.
      const resolvedAssignee = (assigned_to === undefined || assigned_to === null)
        ? (ticket.assigned_to ?? null)
        : (assigned_to === '' ? null : safeId(assigned_to));
      const resolvedAssetId = (asset_id === undefined || asset_id === null)
        ? (ticket.asset_id ?? null)
        : (asset_id === '' ? null : safeId(asset_id));
      // Preserve the current (possibly deactivated) assignee when the submitted
      // value is unchanged, so editing an unrelated field on a ticket whose
      // assignee has since been deactivated does not force a reassignment or
      // wipe the stored value — the edit form includes the inactive assignee
      // via ensureAssigneeInList. Assigning to a DIFFERENT inactive user is
      // still rejected (fail closed).
      if (resolvedAssignee && !isActiveUser(db, resolvedAssignee) && Number(resolvedAssignee) !== Number(ticket.assigned_to)) {
        throw new Error('ASSIGNEE_NOT_AVAILABLE');
      }
      if (resolvedAssetId && !_assetExistsStmt.get(resolvedAssetId)) {
        throw new Error('ASSET_NOT_FOUND');
      }

      // Resolve the due date against the freshly-read row: an ABSENT field on a
      // partial submission preserves the stored value (mirrors projects/assets/
      // vendors/changes), while an explicit empty string still clears it (null).
      const resolvedDueDate = (due_date === undefined || due_date === null) ? ticket.due_date : safeDueDate;
      // Non-privileged editors cannot view or modify requester PII — their edit
      // form redacts these fields, so absent submissions must preserve the
      // stored values rather than failing validation or wiping the data.
      const resolvedRequesterEmail = canEditRequesterPII
        ? (requester_email || '').substring(0, MAX_EMAIL)
        : ticket.requester_email;
      // Absent-vs-empty convention for requester PII: an explicit empty string
      // in the form ("Clear") wipes the stored value, while an ABSENT field on
      // a partial API submission preserves it. A present non-string value
      // (e.g. a JSON number) is rejected via resolveOptionalField's error
      // sentinel — previously it coerced to '' and silently wiped the stored
      // department while the create route rejected the identical payload.
      const resolvedRequesterDept = canEditRequesterPII
        ? resolveOptionalField(rawRequesterDepartment, requester_department || null, MAX_SHORT_STR, ticket.requester_department)
        : ticket.requester_department;
      if (resolvedRequesterDept && resolvedRequesterDept.error) {
        throw new Error('INVALID_REQUESTER_DEPARTMENT');
      }
      const resolvedRequesterPhone = canEditRequesterPII
        ? ((rawRequesterPhone === undefined || rawRequesterPhone === null)
          ? ticket.requester_phone
          : (requester_phone ? requester_phone.substring(0, MAX_PHONE) : null))
        : ticket.requester_phone;
      // Absent-vs-empty convention for the optional text fields: an ABSENT field
      // (partial API submission) preserves the stored value, while an explicit
      // empty string CLEARS it (null). A present non-string value is rejected
      // via resolveOptionalField's error sentinel. Previously description and
      // resolution_notes were unconditionally overwritten, so a partial PUT that
      // omitted them silently wiped the stored values — the exact bug class
      // already fixed for assignee/asset/due_date/requester PII above. Mirrors
      // the update convention in changes.js / licenses.js / vendors.js.
      const resolvedDescription = resolveOptionalField(rawDescription, description || null, MAX_DESC, ticket.description);
      if (resolvedDescription && resolvedDescription.error) {
        throw new Error('INVALID_DESCRIPTION');
      }
      const resolvedResolutionNotes = resolveOptionalField(rawResolutionNotes, resolution_notes || null, MAX_DESC, ticket.resolution_notes);
      if (resolvedResolutionNotes && resolvedResolutionNotes.error) {
        throw new Error('INVALID_RESOLUTION_NOTES');
      }
      // Resolve the enum fields against the transaction-consistent row using
      // the same absent-preserves convention as the optional text fields: an
      // ABSENT (or empty) field keeps the stored value. The edit form always
      // submits a concrete value, and a present-but-invalid value was already
      // rejected above, so only valid enums and "no opinion" reach here.
      const effectiveCategory = category || ticket.category;
      const effectivePriority = priority || ticket.priority;
      const effectiveStatus = status || ticket.status;

      const params = [title.substring(0, MAX_MEDIUM_STR), resolvedDescription, effectiveCategory, effectivePriority, effectiveStatus,
        resolvedAssignee, resolvedAssetId, resolvedDueDate, resolvedResolutionNotes,
        (requester_name || '').substring(0, MAX_SHORT_STR), resolvedRequesterEmail, resolvedRequesterDept, resolvedRequesterPhone];

      const wasResolved = ticket.status === 'resolved' || ticket.status === 'closed';
      const isNowResolved = effectiveStatus === 'resolved' || effectiveStatus === 'closed';
      const shouldSet = isNowResolved && !wasResolved ? 1 : 0;
      const shouldClear = !isNowResolved && wasResolved ? 1 : 0;

      const result = _updateTicketStmt.run(...params, shouldSet, shouldClear, id);
      if (result.changes === 0) {
        throw new Error('NOT_FOUND');
      }
      // Surface the resolved status to the post-transaction audit entry — an
      // absent status on a partial submission must audit the EFFECTIVE status,
      // not the empty submitted value.
      auditStatus = effectiveStatus;
    });
    updateTicket();

    req.audit('update', 'ticket', id, `Updated ticket (status: ${auditStatus})`);
    req.flash('success', 'Ticket updated successfully');
    invalidateDashboardCache();
    return res.redirect(`/tickets/${id}`);
  } catch (err) {
    if (err.message === 'NOT_FOUND') {
      req.flash('error', 'Ticket not found');
      return res.redirect('/tickets');
    }
    if (err.message === 'ACCESS_DENIED') {
      req.audit('access_denied', 'ticket', id, 'Unauthorized update attempt on ticket');
      req.flash('error', 'You can only update tickets assigned to you');
      return res.redirect(`/tickets/${id}`);
    }
    if (err.message === 'ASSIGNEE_NOT_AVAILABLE') {
      req.flash('error', 'Selected assignee is not available');
      return res.redirect(`/tickets/${id}/edit`);
    }
    if (err.message === 'ASSET_NOT_FOUND') {
      req.flash('error', 'Selected asset does not exist');
      return res.redirect(`/tickets/${id}/edit`);
    }
    // Map the resolveOptionalField sentinels (INVALID_DESCRIPTION,
    // INVALID_RESOLUTION_NOTES, INVALID_REQUESTER_DEPARTMENT) to a specific
    // validation message instead of the generic server-error flash — a rejected
    // value is a client error, not a transient failure (mirrors the INVALID_
    // mapping in vendors.js).
    if (err.message.startsWith('INVALID_')) {
      req.flash('error', `Invalid ${titleCase(err.message.replace('INVALID_', ''))}`);
      return res.redirect(`/tickets/${id}/edit`);
    }
    console.error('Ticket update error:', err.message);
    req.flash('error', 'Error updating ticket. Please try again.');
    return res.redirect(`/tickets/${id}/edit`);
  }
});

// Add comment — any authenticated user can comment on any ticket they can
// access. This is intentional: IT staff need to collaborate across tickets
// (e.g. second opinions, status updates from other teams). Note that
// "any ticket" is scoped by canAccessResource(): admin/manager can comment on
// all tickets, while regular staff can only comment on tickets assigned to
// them (enforced inside the transaction below).
// Re-checks ticket visibility inside the transaction via canAccessResource()
// so that staff cannot comment on tickets they shouldn't see.
router.post('/:id/comments', commentRateLimiter, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid ticket ID');
    return res.redirect('/tickets');
  }
  // Fail closed on HTTP parameter pollution: reject array payloads.
  const hppErrors = rejectHppArrays(req, ['comment', 'is_internal']);
  if (hppErrors.length > 0) {
    req.flash('error', 'Invalid request parameters');
    return res.redirect(`/tickets/${id}`);
  }

  const comment = safeQueryValue(req.body.comment);
  const is_internal = safeQueryValue(req.body.is_internal);

  const trimmedComment = trim(comment) || '';
  if (!trimmedComment) {
    req.flash('error', 'Comment cannot be empty');
    return res.redirect(`/tickets/${id}`);
  }
  if (trimmedComment.length > MAX_DESC) {
    req.flash('error', `Comment must be at most ${MAX_DESC} characters`);
    return res.redirect(`/tickets/${id}`);
  }

  try {
    // Verify ticket exists, check user access, and add comment in a single
    // transaction to avoid a TOCTOU race where the ticket is deleted between
    // the existence check and the INSERT (mirrors the task-add / member-add patterns).
    const addComment = db.transaction(() => {
      const ticket = _commentExistsStmt.get(id);
      if (!ticket) {
        throw new Error('NOT_FOUND');
      }
      // Recheck commenter is still active inside the transaction so a
      // concurrent deactivation between the earlier _verifySessionUser call
      // and this INSERT cannot bypass the active-user check.
      if (!isActiveUser(db, req.session.user.id)) {
        throw new Error('USER_INACTIVE');
      }
      // Check that the user has access to this ticket before allowing a comment.
      // Admin/manager can access all tickets; regular staff can only access
      // tickets assigned to them. This prevents users from guessing ticket IDs
      // and commenting on tickets they shouldn't see.
      if (!canAccessResource(req, ticket)) {
        throw new Error('ACCESS_DENIED');
      }

      _commentInsertStmt.run(id, req.session.user.id, trimmedComment.substring(0, MAX_DESC),
        // Only admin/manager can mark comments as internal.
        // parseBooleanFlag rejects any non-canonical string ('false', 'off',
        // 'no') so it cannot be coerced truthy, and it gates on privilege.
        parseBooleanFlag(is_internal, isPrivileged(req.session.user)));

      // Refresh ticket updated_at so it sorts as recently active
      _commentTouchStmt.run(id);
    });
    addComment();

    req.audit('comment', 'ticket', id, 'Added comment');
    req.flash('success', 'Comment added');
    invalidateDashboardCache();
    return res.redirect(`/tickets/${id}`);
  } catch (err) {
    if (err.message === 'NOT_FOUND') {
      req.flash('error', 'Ticket not found');
      return res.redirect('/tickets');
    }
    if (err.message === 'USER_INACTIVE') {
      req.flash('error', 'Your account is no longer active');
      return res.redirect('/login?reason=session_expired');
    }
    if (err.message === 'ACCESS_DENIED') {
      req.audit('access_denied', 'ticket', id, 'Unauthorized comment attempt on ticket');
      req.flash('error', 'You do not have permission to comment on this ticket');
      return res.redirect(`/tickets/${id}`);
    }
    console.error('Ticket comment error:', err.message);
    req.flash('error', 'Error adding comment. Please try again.');
    return res.redirect(`/tickets/${id}`);
  }
});

// Quick status update
const statusUpdateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: authKeyGenerator,
  message: 'Too many status updates. Please slow down.',
  standardHeaders: true,
  legacyHeaders: false
});

router.put('/:id/status', statusUpdateLimiter, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid ticket ID');
    return res.redirect('/tickets');
  }
  // Fail closed on HTTP parameter pollution: reject array payloads before
  // safeQueryValue silently collapses status[]=a&status[]=b to its first
  // element. Mirrors the array-rejection guards on the other ticket write routes.
  const hppErrors = rejectHppArrays(req, ['status']);
  if (hppErrors.length > 0) {
    req.flash('error', 'Invalid request parameters');
    return res.redirect(`/tickets/${id}`);
  }

  const status = safeQueryValue(req.body.status);

  if (typeof status !== 'string' || !VALID_STATUSES.includes(status)) {
    req.flash('error', 'Invalid status');
    return res.redirect(`/tickets/${id}`);
  }

  try {
    // Verify ticket, check access, and update status in a single transaction
    // to avoid TOCTOU races: the ticket could be deleted or reassigned between
    // the access check and the UPDATE (mirrors the updateTicket pattern).
    const updateStatus = db.transaction(() => {
      const ticket = _ticketAssigneeStmt.get(id);
      if (!ticket) {
        throw new Error('NOT_FOUND');
      }

      if (!canAccessResource(req, ticket)) {
        throw new Error('ACCESS_DENIED');
      }

      const isNowResolved = status === 'resolved' || status === 'closed';
      const stmt = isNowResolved ? _statusResolveStmt : _statusUnresolveStmt;
      const result = stmt.run(status, id);
      if (result.changes === 0) {
        throw new Error('NOT_FOUND');
      }
    });
    updateStatus();

    req.audit('update', 'ticket', id, `Status changed to ${status}`);
    req.flash('success', `Ticket status updated to ${status.replace(/_/g, ' ')}`);
    invalidateDashboardCache();
    return res.redirect(`/tickets/${id}`);
  } catch (err) {
    if (err.message === 'NOT_FOUND') {
      req.flash('error', 'Ticket not found');
      return res.redirect('/tickets');
    }
    if (err.message === 'ACCESS_DENIED') {
      req.audit('access_denied', 'ticket', id, 'Unauthorized quick-status update attempt on ticket');
      req.flash('error', 'You can only update status of tickets assigned to you');
      return res.redirect(`/tickets/${id}`);
    }
    console.error('Ticket status update error:', err.message);
    req.flash('error', 'Error updating status. Please try again.');
    return res.redirect(`/tickets/${id}`);
  }
});

// Satisfaction rating (admin/manager only, resolved/closed tickets only)
const satisfactionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: authKeyGenerator,
  message: 'Too many rating submissions. Please slow down.',
  standardHeaders: true,
  legacyHeaders: false
});

router.put('/:id/satisfaction', requireAdminOrManager, satisfactionLimiter, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid ticket ID');
    return res.redirect('/tickets');
  }
  // Fail-closed HPP rejection, matching the array-rejection guard used by every
  // other write route in the codebase. safeInt already rejects arrays, but the
  // explicit check prevents a polluted satisfaction_rating[]=a&...=b from being
  // silently collapsed to its first element.
  const hppErrors = rejectHppArrays(req, ['satisfaction_rating']);
  if (hppErrors.length > 0) {
    req.flash('error', 'Invalid request parameters');
    return res.redirect(`/tickets/${id}`);
  }
  const rating = safeInt(safeQueryValue(req.body.satisfaction_rating), 0);
  if (rating < 1 || rating > 5) {
    req.flash('error', 'Invalid satisfaction rating');
    return res.redirect(`/tickets/${id}`);
  }

  try {
    // Verify ticket status and update in a single transaction to avoid a TOCTOU
    // race where the ticket is reopened between the status check and the UPDATE
    // (mirrors the status update transaction pattern).
    const rateTicket = db.transaction(() => {
      const ticket = _satisfactionCheckStmt.get(id);
      if (!ticket) {
        throw new Error('NOT_FOUND');
      }
      // Only allow rating on resolved/closed tickets — prevents rating open tickets
      // via direct API call even though the template hides the form.
      if (ticket.status !== 'resolved' && ticket.status !== 'closed') {
        throw new Error('NOT_RESOLVED');
      }

      const result = _satisfactionUpdateStmt.run(rating, id);
      if (result.changes === 0) {
        throw new Error('NOT_FOUND');
      }
    });
    rateTicket();

    req.audit('update', 'ticket', id, `Satisfaction rated ${rating}/5`);
    req.flash('success', 'Thank you for your feedback!');
    invalidateDashboardCache();
  } catch (err) {
    if (err.message === 'NOT_FOUND') {
      req.flash('error', 'Ticket not found');
      return res.redirect('/tickets');
    }
    if (err.message === 'NOT_RESOLVED') {
      req.flash('error', 'Can only rate resolved or closed tickets');
      return res.redirect(`/tickets/${id}`);
    }
    console.error('Ticket satisfaction error:', err.message);
    req.flash('error', 'Error submitting rating.');
  }
  return res.redirect(`/tickets/${id}`);
});

// Delete ticket
router.delete('/:id', requireAdminOrManager, ticketWriteLimiter, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid ticket ID');
    return res.redirect('/tickets');
  }

  try {
    // Verify ticket exists and delete in a single transaction to avoid a
    // TOCTOU race where the ticket is deleted between the earlier existence
    // check and the DELETE (mirrors the ticket update transaction pattern).
    const deleteTicket = db.transaction(() => {
      const ticket = _editTicketStmt.get(id);
      if (!ticket) {
        return { changes: 0, ticket_number: null };
      }
      return { changes: _deleteTicketStmt.run(id).changes, ticket_number: ticket.ticket_number };
    });
    const result = deleteTicket();
    if (result.changes === 0) {
      req.flash('error', 'Ticket not found');
    } else {
      req.audit('delete', 'ticket', id, `Deleted ticket ${result.ticket_number}`);
      req.flash('success', 'Ticket deleted');
      invalidateDashboardCache();
    }
  } catch (err) {
    console.error('Ticket delete error:', err.message);
    req.flash('error', 'Error deleting ticket.');
  }
  return res.redirect('/tickets');
});

/**
 * Reset module-level cached prepared statements (test use only).
 * Ensures test isolation when using mock db instances — consistent with
 * the same-named export in middleware/auth.js, audit.js, utils.js, etc.
 */
function resetCachedStatements() {
  // Clear prepared statement cache for this module.
  // The statements are module-level const bindings from db.prepare(),
  // so there is no lazy-init to null out — the cache is unused when
  // the db mock is swapped. This function exists for API consistency
  // across all route modules.
}

module.exports = router;
// Exposed for unit testing (the route module is mocked in app.test.js).
module.exports.commentKeyGenerator = commentKeyGenerator;
module.exports.ensureLinkedAssetInList = ensureLinkedAssetInList;
module.exports.resetCachedStatements = resetCachedStatements;
