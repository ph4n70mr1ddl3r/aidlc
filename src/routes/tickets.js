const db = require('../models/database');
const { requireAuth, requireAdminOrManager, canAccessResource } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { paginate, paginationBaseUrl, safeSort, addSearch, buildFilters, safeId, safeDate, safeInt, isValidEmail, trim, sanitizePhone, isValidPhone, getActiveStaff, isActiveUser, isPrivileged, countQuery, selectQuery, safeQueryValue } = require('../utils');
const { TICKET_CATEGORIES: VALID_CATEGORIES, TICKET_PRIORITIES: VALID_PRIORITIES, TICKET_STATUSES: VALID_STATUSES, MAX_SHORT_STR, MAX_MEDIUM_STR, MAX_DESC, MAX_EMAIL, MAX_PHONE } = require('../constants');
const { invalidateDashboardCache } = require('./dashboard');

const rateLimit = require('express-rate-limit');

// express-rate-limit v8 renamed the exported IP key generator from
// `defaultKeyGenerator` to `ipKeyGenerator`. The library docs recommend
// `ipKeyGenerator(req.ip)` for the unauthenticated fallback of a custom
// per-user keyGenerator.
const { ipKeyGenerator } = rateLimit;

// Rate limit ticket write operations to prevent abuse
const ticketWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: 'Too many ticket operations. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});

// Key comment rate-limiting by user id (per-account) so a single user can't
// be silenced by another's IP, falling back to IP for unauthenticated calls.
function commentKeyGenerator(req) {
  return req.session && req.session.user && req.session.user.id
    ? `user:${req.session.user.id}`
    : ipKeyGenerator(req.ip);
}

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
const _assetListStmt = db.prepare('SELECT id, asset_tag, name FROM assets ORDER BY name');

// Cached prepared statements for show/edit routes (static SQL).
const _showTicketStmt = db.prepare(`
    SELECT t.*, u.first_name || ' ' || u.last_name as assigned_name,
      a.name as asset_name, a.asset_tag
    FROM tickets t
    LEFT JOIN users u ON t.assigned_to = u.id
    LEFT JOIN assets a ON t.asset_id = a.id
    WHERE t.id = ?
  `);
const _showCommentsStmt = db.prepare(`
    SELECT tc.*, u.first_name || ' ' || u.last_name as author_name, u.role as author_role
    FROM ticket_comments tc
    LEFT JOIN users u ON tc.user_id = u.id
    WHERE tc.ticket_id = ?
    ORDER BY tc.created_at ASC
  `);
const _editTicketStmt = db.prepare('SELECT * FROM tickets WHERE id = ?');
const _ticketAssigneeStmt = db.prepare('SELECT assigned_to FROM tickets WHERE id = ?');
const _satisfactionCheckStmt = db.prepare('SELECT status FROM tickets WHERE id = ?');
const _satisfactionUpdateStmt = db.prepare(
    'UPDATE tickets SET satisfaction_rating = ?, updated_at = datetime(\'now\') WHERE id = ?'
  );
const _assetExistsStmt = db.prepare('SELECT 1 FROM assets WHERE id = ?');
const _deleteTicketStmt = db.prepare('DELETE FROM tickets WHERE id = ?');

// Cached statement for ticket update route
const _updateCheckStmt = db.prepare('SELECT status, assigned_to FROM tickets WHERE id = ?');
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
const _commentExistStmt = db.prepare('SELECT id FROM tickets WHERE id = ?');

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

const SORT_MAP = {
  newest: 't.created_at DESC',
  oldest: 't.created_at ASC',
  priority: "CASE t.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 END, t.created_at ASC",
  default: 't.created_at DESC'
};

// List tickets (paginated)
router.get('/', (req, res) => {
  const { page, limit, offset } = paginate(req);

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

  const tickets = selectQuery(db, `
    SELECT t.*, u.first_name || ' ' || u.last_name as assigned_name
    FROM tickets t
    LEFT JOIN users u ON t.assigned_to = u.id
    WHERE ${whereClause}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `, [...params, limit, offset]);

  const staff = getActiveStaff(db);

  res.render('pages/tickets/index', {
    title: 'Tickets', tickets, staff, filters: req.query,
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
  const title = trim(safeQueryValue(req.body.title));
  const description = trim(safeQueryValue(req.body.description));
  const category = trim(safeQueryValue(req.body.category));
  const priority = trim(safeQueryValue(req.body.priority));
  const requester_name = trim(safeQueryValue(req.body.requester_name));
  const requester_email = trim(safeQueryValue(req.body.requester_email)).toLowerCase();
  const requester_department = trim(safeQueryValue(req.body.requester_department));
  const requester_phone = sanitizePhone(safeQueryValue(req.body.requester_phone));
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

  // Validate assignee is an active user
  const safeAssignee = assigned_to ? safeId(assigned_to) : null;
  if (safeAssignee && !isActiveUser(db, safeAssignee)) {
    req.flash('error', 'Selected assignee is not available');
    return res.redirect('/tickets/new');
  }

  // Validate linked asset exists
  const safeAssetId = asset_id ? safeId(asset_id) : null;
  if (safeAssetId) {
    const assetExists = _assetExistsStmt.get(safeAssetId);
    if (!assetExists) {
      req.flash('error', 'Selected asset does not exist');
      return res.redirect('/tickets/new');
    }
  }

  // Generate ticket number atomically using dedicated counter table.
  // Use UTC date for consistency with DB datetime('now') which stores UTC.
  const createTicket = db.transaction(() => {
    const now = new Date();
    const todayStr = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
    const row = _ticketCounterStmt.get(todayStr);
    const seq = row.next_seq;
    const ticket_number = `TK-${todayStr}-${String(seq).padStart(3, '0')}`;

    const result = _ticketInsertStmt.run(ticket_number, title.substring(0, MAX_MEDIUM_STR), (description || '').substring(0, MAX_DESC) || null, category, priority,
      requester_name.substring(0, MAX_SHORT_STR), requester_email.substring(0, MAX_EMAIL), (requester_department || '').substring(0, MAX_SHORT_STR) || null, requester_phone ? requester_phone.substring(0, MAX_PHONE) : null,
      safeAssignee, safeAssetId, safeDate(due_date));
    return { ticket_number, id: result.lastInsertRowid };
  });

  try {
    const { ticket_number, id } = createTicket();

    req.audit('create', 'ticket', id, `Created ticket ${ticket_number}`);
    req.flash('success', `Ticket ${ticket_number} created successfully`);
    invalidateDashboardCache();
    res.redirect('/tickets');
  } catch (err) {
    console.error('Ticket create error:', err.message);
    req.flash('error', 'Error creating ticket. Please check your input and try again.');
    res.redirect('/tickets/new');
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

  const rawComments = _showCommentsStmt.all(id);
  // Filter internal comments server-side — non-privileged users must not
  // receive internal comments even if the template rendering fails.
  const comments = isPrivileged(req.session.user) ? rawComments : rawComments.filter(c => !c.is_internal);

  res.render('pages/tickets/show', { title: `Ticket ${ticket.ticket_number}`, ticket, comments });
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
    req.flash('error', 'You can only edit tickets assigned to you');
    return res.redirect(`/tickets/${id}`);
  }

  const staff = getActiveStaff(db);
  const assets = _assetListStmt.all();
  res.render('pages/tickets/form', { title: 'Edit Ticket', ticket, staff, assets, isEdit: true });
});

// Update ticket
router.put('/:id', ticketWriteLimiter, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid ticket ID');
    return res.redirect('/tickets');
  }

  const title = trim(safeQueryValue(req.body.title));
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
  const requester_phone = sanitizePhone(safeQueryValue(req.body.requester_phone));

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

  // Validate enum fields — reject empty/missing values
  if (!category || !VALID_CATEGORIES.includes(category)) {
    req.flash('error', 'Invalid category');
    return res.redirect(`/tickets/${id}/edit`);
  }
  if (!priority || !VALID_PRIORITIES.includes(priority)) {
    req.flash('error', 'Invalid priority');
    return res.redirect(`/tickets/${id}/edit`);
  }
  if (!status || !VALID_STATUSES.includes(status)) {
    req.flash('error', 'Invalid status');
    return res.redirect(`/tickets/${id}/edit`);
  }

  if (resolution_notes && resolution_notes.length > MAX_DESC) {
    req.flash('error', `Resolution notes must be at most ${MAX_DESC} characters`);
    return res.redirect(`/tickets/${id}/edit`);
  }

  // Validate requester fields — must be present and within length limits
  if (!requester_name) {
    req.flash('error', 'Requester name is required');
    return res.redirect(`/tickets/${id}/edit`);
  }
  if (requester_name.length > MAX_SHORT_STR) {
    req.flash('error', `Requester name must be at most ${MAX_SHORT_STR} characters`);
    return res.redirect(`/tickets/${id}/edit`);
  }
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

  // Validate assignee is an active user
  const updateAssignee = assigned_to ? safeId(assigned_to) : null;
  if (updateAssignee && !isActiveUser(db, updateAssignee)) {
    req.flash('error', 'Selected assignee is not available');
    return res.redirect(`/tickets/${id}/edit`);
  }

  // Validate linked asset exists
  const updateAssetId = asset_id ? safeId(asset_id) : null;
  if (updateAssetId) {
    const assetExists = _assetExistsStmt.get(updateAssetId);
    if (!assetExists) {
      req.flash('error', 'Selected asset does not exist');
      return res.redirect(`/tickets/${id}/edit`);
    }
  }

  try {
    const ticket = _updateCheckStmt.get(id);
    if (!ticket) {
      req.flash('error', 'Ticket not found');
      return res.redirect('/tickets');
    }

    if (!canAccessResource(req, ticket)) {
      req.flash('error', 'You can only update tickets assigned to you');
      return res.redirect(`/tickets/${id}`);
    }

    const params = [title.substring(0, MAX_MEDIUM_STR), (description || '').substring(0, MAX_DESC) || null, category, priority, status,
      updateAssignee, updateAssetId, safeDate(due_date), (resolution_notes || '').substring(0, MAX_DESC) || null,
      (requester_name || '').substring(0, MAX_SHORT_STR), (requester_email || '').substring(0, MAX_EMAIL), (requester_department || '').substring(0, MAX_SHORT_STR) || null, requester_phone ? requester_phone.substring(0, MAX_PHONE) : null];

    const wasResolved = ticket.status === 'resolved' || ticket.status === 'closed';
    const isNowResolved = status === 'resolved' || status === 'closed';
    const shouldSet = isNowResolved && !wasResolved ? 1 : 0;
    const shouldClear = !isNowResolved && wasResolved ? 1 : 0;

    _updateTicketStmt.run(...params, shouldSet, shouldClear, id);

    req.audit('update', 'ticket', id, `Updated ticket (status: ${status})`);
    req.flash('success', 'Ticket updated successfully');
    invalidateDashboardCache();
    res.redirect(`/tickets/${id}`);
  } catch (err) {
    console.error('Ticket update error:', err.message);
    req.flash('error', 'Error updating ticket. Please try again.');
    res.redirect(`/tickets/${id}/edit`);
  }
});

// Add comment — any authenticated user can comment on any ticket.
// This is intentional: IT staff need to collaborate across tickets even if
// they are not the assignee (e.g. second opinions, status updates from other teams).
// The show page already enforces visibility, so users can only reach this route
// if they can view the ticket.
router.post('/:id/comments', commentRateLimiter, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid ticket ID');
    return res.redirect('/tickets');
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
    // Verify ticket exists before adding comment
    const ticket = _commentExistStmt.get(id);
    if (!ticket) {
      req.flash('error', 'Ticket not found');
      return res.redirect('/tickets');
    }

    const addComment = db.transaction(() => {
      _commentInsertStmt.run(id, req.session.user.id, trimmedComment.substring(0, MAX_DESC),
        // Only admin/manager can mark comments as internal.
        // Guards against HPP array values via safeQueryValue on is_internal.
        // A truthy check that also excludes the explicit string '0' to match
        // the knowledge-base is_featured checkbox idiom.
        (is_internal && is_internal !== '0' && isPrivileged(req.session.user)) ? 1 : 0);

      // Refresh ticket updated_at so it sorts as recently active
      _commentTouchStmt.run(id);
    });
    addComment();

    req.audit('comment', 'ticket', id, 'Added comment');
    req.flash('success', 'Comment added');
    invalidateDashboardCache();
  } catch (err) {
    console.error('Ticket comment error:', err.message);
    req.flash('error', 'Error adding comment');
  }
  res.redirect(`/tickets/${id}`);
});

// Quick status update
const statusUpdateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
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
  const status = safeQueryValue(req.body.status);

  if (typeof status !== 'string' || !VALID_STATUSES.includes(status)) {
    req.flash('error', 'Invalid status');
    return res.redirect(`/tickets/${id}`);
  }

  try {
    const ticket = _ticketAssigneeStmt.get(id);
    if (!ticket) {
      req.flash('error', 'Ticket not found');
      return res.redirect('/tickets');
    }

    if (!canAccessResource(req, ticket)) {
      req.flash('error', 'You can only update status of tickets assigned to you');
      return res.redirect(`/tickets/${id}`);
    }

    // Use cached prepared statement based on resolved_at handling
    const isNowResolved = status === 'resolved' || status === 'closed';
    let stmt;
    if (isNowResolved) {
      stmt = _statusResolveStmt;
    } else {
      stmt = _statusUnresolveStmt;
    }
    const result = stmt.run(status, id);
    if (result.changes === 0) {
      req.flash('error', 'Ticket not found');
      return res.redirect('/tickets');
    }
    req.audit('update', 'ticket', id, `Status changed to ${status}`);
    req.flash('success', `Ticket status updated to ${status.replace(/_/g, ' ')}`);
    invalidateDashboardCache();
  } catch (err) {
    console.error('Ticket status update error:', err.message);
    req.flash('error', 'Error updating status');
  }
  res.redirect(`/tickets/${id}`);
});

// Satisfaction rating (admin/manager only, resolved/closed tickets only)
const satisfactionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
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
  const rating = safeInt(req.body.satisfaction_rating, 0);
  if (rating < 1 || rating > 5) {
    req.flash('error', 'Invalid satisfaction rating');
    return res.redirect(`/tickets/${id}`);
  }

  try {
    // Only allow rating on resolved/closed tickets — prevents rating open tickets
    // via direct API call even though the template hides the form.
    const ticket = _satisfactionCheckStmt.get(id);
    if (!ticket) {
      req.flash('error', 'Ticket not found');
      return res.redirect('/tickets');
    }
    if (ticket.status !== 'resolved' && ticket.status !== 'closed') {
      req.flash('error', 'Can only rate resolved or closed tickets');
      return res.redirect(`/tickets/${id}`);
    }

    const result = _satisfactionUpdateStmt.run(rating, id);
    if (result.changes === 0) {
      req.flash('error', 'Ticket not found');
      return res.redirect('/tickets');
    }
    req.audit('update', 'ticket', id, `Satisfaction rated ${rating}/5`);
    req.flash('success', 'Thank you for your feedback!');
    invalidateDashboardCache();
  } catch (err) {
    console.error('Ticket satisfaction error:', err.message);
    req.flash('error', 'Error submitting rating');
  }
  res.redirect(`/tickets/${id}`);
});

// Delete ticket
router.delete('/:id', requireAdminOrManager, ticketWriteLimiter, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid ticket ID');
    return res.redirect('/tickets');
  }

  try {
    const result = _deleteTicketStmt.run(id);
    if (result.changes === 0) {
      req.flash('error', 'Ticket not found');
    } else {
      req.audit('delete', 'ticket', id, 'Deleted ticket');
      req.flash('success', 'Ticket deleted');
      invalidateDashboardCache();
    }
  } catch (err) {
    console.error('Ticket delete error:', err.message);
    req.flash('error', 'Error deleting ticket');
  }
  res.redirect('/tickets');
});

module.exports = router;
// Exposed for unit testing (the route module is mocked in app.test.js).
module.exports.commentKeyGenerator = commentKeyGenerator;
