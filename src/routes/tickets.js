const db = require('../models/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { paginate, paginationBaseUrl, safeSort, addSearch, buildFilters, safeId, safeDate, safeInt, isValidEmail, trim, getActiveStaff, isActiveUser } = require('../utils');
const { TICKET_CATEGORIES: VALID_CATEGORIES, TICKET_PRIORITIES: VALID_PRIORITIES, TICKET_STATUSES: VALID_STATUSES } = require('../constants');

const router = require('express').Router();
router.use(requireAuth, auditMiddleware);

const SORT_MAP = {
  newest: 't.created_at DESC',
  oldest: 't.created_at ASC',
  priority: "CASE t.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 END, t.created_at ASC",
};

// List tickets (paginated)
router.get('/', (req, res) => {
  const { page, limit, offset } = paginate(req);

  const filters = buildFilters({
    't.status': { value: VALID_STATUSES.includes(req.query.status) ? req.query.status : '' },
    't.priority': { value: VALID_PRIORITIES.includes(req.query.priority) ? req.query.priority : '' },
    't.category': { value: VALID_CATEGORIES.includes(req.query.category) ? req.query.category : '' },
    't.assigned_to': { value: req.query.assigned_to ? safeId(req.query.assigned_to) || '' : '' },
  });

  const where = [...filters.where];
  const params = [...filters.params];
  addSearch(where, params, req.query.search, ['t.title', 't.description', 't.ticket_number']);

  const whereClause = where.length ? where.join(' AND ') : '1=1';
  const orderBy = safeSort(req.query.sort, SORT_MAP, 'newest');

  const total = db.prepare(`SELECT COUNT(*) as c FROM tickets t WHERE ${whereClause}`).get(...params).c;
  const totalPages = Math.ceil(total / limit) || 1;

  const tickets = db.prepare(`
    SELECT t.*, u.first_name || ' ' || u.last_name as assigned_name
    FROM tickets t
    LEFT JOIN users u ON t.assigned_to = u.id
    WHERE ${whereClause}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const staff = getActiveStaff(db);

  res.render('pages/tickets/index', {
    title: 'Tickets', tickets, staff, filters: req.query,
    page, totalPages, total,
    baseUrl: paginationBaseUrl(req),
  });
});

// New ticket form
router.get('/new', (req, res) => {
  const staff = getActiveStaff(db);
  const assets = db.prepare('SELECT id, asset_tag, name FROM assets ORDER BY name').all();
  // Pre-fill requester info from logged-in user
  const prefill = {
    requester_name: `${req.session.user.first_name} ${req.session.user.last_name}`,
    requester_email: req.session.user.email,
    requester_department: req.session.user.department || '',
  };
  res.render('pages/tickets/form', { title: 'New Ticket', ticket: prefill, staff, assets, isEdit: false });
});

// Create ticket
router.post('/', (req, res) => {
  const title = trim(req.body.title);
  const description = trim(req.body.description);
  const category = req.body.category;
  const priority = req.body.priority;
  const requester_name = trim(req.body.requester_name);
  const requester_email = trim(req.body.requester_email);
  const requester_department = trim(req.body.requester_department);
  const requester_phone = trim(req.body.requester_phone);
  const assigned_to = req.body.assigned_to;
  const asset_id = req.body.asset_id;
  const due_date = req.body.due_date;

  if (!title || !category || !requester_name || !requester_email) {
    req.flash('error', 'Title, category, requester name, and requester email are required');
    return res.redirect('/tickets/new');
  }

  if (!isValidEmail(requester_email)) {
    req.flash('error', 'Please enter a valid requester email address');
    return res.redirect('/tickets/new');
  }

  if (!VALID_CATEGORIES.includes(category)) {
    req.flash('error', 'Invalid category');
    return res.redirect('/tickets/new');
  }
  const safePriority = VALID_PRIORITIES.includes(priority) ? priority : 'medium';

  // Validate assignee is an active user
  const safeAssignee = assigned_to ? safeId(assigned_to) : null;
  if (safeAssignee && !isActiveUser(db, safeAssignee)) {
    req.flash('error', 'Selected assignee is not available');
    return res.redirect('/tickets/new');
  }

  // Validate linked asset exists
  const safeAssetId = asset_id ? safeId(asset_id) : null;
  if (safeAssetId) {
    const assetExists = db.prepare('SELECT 1 FROM assets WHERE id = ?').get(safeAssetId);
    if (!assetExists) {
      req.flash('error', 'Selected asset does not exist');
      return res.redirect('/tickets/new');
    }
  }

  // Generate ticket number atomically using dedicated counter table
  const createTicket = db.transaction(() => {
    const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    // Atomically increment the counter for today's date
    const row = db.prepare(`
      INSERT INTO ticket_counter (counter_date, next_seq)
      VALUES (?, 1)
      ON CONFLICT(counter_date) DO UPDATE SET next_seq = next_seq + 1
      RETURNING next_seq
    `).get(todayStr);
    const seq = row.next_seq;
    const ticket_number = `TK-${todayStr}-${String(seq).padStart(3, '0')}`;

    const result = db.prepare(`
      INSERT INTO tickets (ticket_number, title, description, category, priority,
        requester_name, requester_email, requester_department, requester_phone,
        assigned_to, asset_id, due_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(ticket_number, title.substring(0, 200), (description || '').substring(0, 5000), category, safePriority,
      requester_name.substring(0, 100), requester_email.substring(0, 200), (requester_department || '').substring(0, 100), (requester_phone || '').substring(0, 50),
      safeAssignee, safeAssetId, safeDate(due_date));
    return { ticket_number, id: result.lastInsertRowid };
  });

  try {
    const { ticket_number, id } = createTicket();

    req.audit('create', 'ticket', id, `Created ticket ${ticket_number}`);
    req.flash('success', `Ticket ${ticket_number} created successfully`);
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
  if (!id) { req.flash('error', 'Invalid ticket ID'); return res.redirect('/tickets'); }

  const ticket = db.prepare(`
    SELECT t.*, u.first_name || ' ' || u.last_name as assigned_name,
      a.name as asset_name, a.asset_tag
    FROM tickets t
    LEFT JOIN users u ON t.assigned_to = u.id
    LEFT JOIN assets a ON t.asset_id = a.id
    WHERE t.id = ?
  `).get(id);

  if (!ticket) {
    req.flash('error', 'Ticket not found');
    return res.redirect('/tickets');
  }

  const comments = db.prepare(`
    SELECT tc.*, u.first_name || ' ' || u.last_name as author_name, u.role as author_role
    FROM ticket_comments tc
    JOIN users u ON tc.user_id = u.id
    WHERE tc.ticket_id = ?
    ORDER BY tc.created_at ASC
  `).all(id);

  const staff = getActiveStaff(db);

  res.render('pages/tickets/show', { title: `Ticket ${ticket.ticket_number}`, ticket, comments, staff });
});

// Edit ticket form
router.get('/:id/edit', (req, res) => {
  const id = safeId(req.params.id);
  if (!id) { req.flash('error', 'Invalid ticket ID'); return res.redirect('/tickets'); }

  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
  if (!ticket) {
    req.flash('error', 'Ticket not found');
    return res.redirect('/tickets');
  }
  const staff = getActiveStaff(db);
  const assets = db.prepare('SELECT id, asset_tag, name FROM assets ORDER BY name').all();
  res.render('pages/tickets/form', { title: 'Edit Ticket', ticket, staff, assets, isEdit: true });
});

// Update ticket
router.put('/:id', (req, res) => {
  const id = safeId(req.params.id);
  if (!id) { req.flash('error', 'Invalid ticket ID'); return res.redirect('/tickets'); }

  const title = trim(req.body.title);
  const description = trim(req.body.description);
  const category = req.body.category;
  const priority = req.body.priority;
  const status = req.body.status;
  const assigned_to = req.body.assigned_to;
  const asset_id = req.body.asset_id;
  const due_date = req.body.due_date;
  const resolution_notes = trim(req.body.resolution_notes);

  if (!title) {
    req.flash('error', 'Title is required');
    return res.redirect(`/tickets/${id}/edit`);
  }
  if (!category) {
    req.flash('error', 'Category is required');
    return res.redirect(`/tickets/${id}/edit`);
  }

  // Validate enum fields
  if (!VALID_CATEGORIES.includes(category)) {
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
  const safeCategory = category;
  const safePriority = VALID_PRIORITIES.includes(priority) ? priority : 'medium';
  const safeStatus = VALID_STATUSES.includes(status) ? status : null;
  if (!safeStatus) {
    req.flash('error', 'Status is required');
    return res.redirect(`/tickets/${id}/edit`);
  }

  try {
    // Fetch current ticket to compare status transitions
    const ticket = db.prepare('SELECT status FROM tickets WHERE id = ?').get(id);
    if (!ticket) { req.flash('error', 'Ticket not found'); return res.redirect('/tickets'); }

    // Validate assignee is an active user
    const updateAssignee = assigned_to ? safeId(assigned_to) : null;
    if (updateAssignee && !isActiveUser(db, updateAssignee)) {
      req.flash('error', 'Selected assignee is not available');
      return res.redirect(`/tickets/${id}/edit`);
    }

    // Validate linked asset exists
    const updateAssetId = asset_id ? safeId(asset_id) : null;
    if (updateAssetId) {
      const assetExists = db.prepare('SELECT 1 FROM assets WHERE id = ?').get(updateAssetId);
      if (!assetExists) {
        req.flash('error', 'Selected asset does not exist');
        return res.redirect(`/tickets/${id}/edit`);
      }
    }

    let query = `UPDATE tickets SET title = ?, description = ?, category = ?, priority = ?,
        status = ?, assigned_to = ?, asset_id = ?, due_date = ?, resolution_notes = ?,
        updated_at = datetime('now')`;
    const params = [title.substring(0, 200), (description || '').substring(0, 5000), safeCategory, safePriority, safeStatus,
      updateAssignee, updateAssetId, safeDate(due_date), (resolution_notes || '').substring(0, 5000)];

    const wasResolved = ticket.status === 'resolved' || ticket.status === 'closed';
    const isNowResolved = safeStatus === 'resolved' || safeStatus === 'closed';
    if (isNowResolved && !wasResolved) {
      query += `, resolved_at = datetime('now')`;
    } else if (!isNowResolved && wasResolved) {
      query += `, resolved_at = NULL`;
    }
    query += ` WHERE id = ?`;
    params.push(id);

    db.prepare(query).run(...params);

    req.audit('update', 'ticket', id, `Updated ticket (status: ${safeStatus})`);
    req.flash('success', 'Ticket updated successfully');
    res.redirect(`/tickets/${id}`);
  } catch (err) {
    console.error('Ticket update error:', err.message);
    req.flash('error', 'Error updating ticket. Please try again.');
    res.redirect(`/tickets/${id}/edit`);
  }
});

// Add comment
router.post('/:id/comments', (req, res) => {
  const id = safeId(req.params.id);
  if (!id) { req.flash('error', 'Invalid ticket ID'); return res.redirect('/tickets'); }
  const { comment, is_internal } = req.body;

  if (!comment || !comment.trim()) {
    req.flash('error', 'Comment cannot be empty');
    return res.redirect(`/tickets/${id}`);
  }

  try {
    // Verify ticket exists before adding comment
    const ticket = db.prepare('SELECT id FROM tickets WHERE id = ?').get(id);
    if (!ticket) { req.flash('error', 'Ticket not found'); return res.redirect('/tickets'); }

    const addComment = db.transaction(() => {
      db.prepare(`
        INSERT INTO ticket_comments (ticket_id, user_id, comment, is_internal)
        VALUES (?, ?, ?, ?)
      `).run(id, req.session.user.id, comment.trim().substring(0, 5000),
        // Only admin/manager can mark comments as internal
        (is_internal && (req.session.user.role === 'admin' || req.session.user.role === 'manager')) ? 1 : 0);

      // Refresh ticket updated_at so it sorts as recently active
      db.prepare(`UPDATE tickets SET updated_at = datetime('now') WHERE id = ?`).run(id);
    });
    addComment();

    req.audit('comment', 'ticket', id, 'Added comment');
    req.flash('success', 'Comment added');
  } catch (err) {
    console.error('Ticket comment error:', err.message);
    req.flash('error', 'Error adding comment');
  }
  res.redirect(`/tickets/${id}`);
});

// Quick status update
router.put('/:id/status', (req, res) => {
  const id = safeId(req.params.id);
  if (!id) { req.flash('error', 'Invalid ticket ID'); return res.redirect('/tickets'); }
  const { status } = req.body;

  if (!VALID_STATUSES.includes(status)) {
    req.flash('error', 'Invalid status');
    return res.redirect(`/tickets/${id}`);
  }

  try {
    let query = `UPDATE tickets SET status = ?, updated_at = datetime('now')`;
    if (status === 'resolved' || status === 'closed') {
      query += `, resolved_at = COALESCE(resolved_at, datetime('now'))`;
    } else {
      // Clear resolved_at when reopening a ticket
      query += `, resolved_at = NULL`;
    }
    query += ` WHERE id = ?`;
    const result = db.prepare(query).run(status, id);
    if (result.changes === 0) {
      req.flash('error', 'Ticket not found');
      return res.redirect('/tickets');
    }
    req.audit('update', 'ticket', id, `Status changed to ${status}`);
    req.flash('success', `Ticket status updated to ${status.replace(/_/g, ' ')}`);
  } catch (err) {
    console.error('Ticket status update error:', err.message);
    req.flash('error', 'Error updating status');
  }
  res.redirect(`/tickets/${id}`);
});

// Satisfaction rating
router.put('/:id/satisfaction', (req, res) => {
  const id = safeId(req.params.id);
  if (!id) { req.flash('error', 'Invalid ticket ID'); return res.redirect('/tickets'); }
  const rating = safeInt(req.body.satisfaction_rating, 0);
  if (rating < 1 || rating > 5) {
    req.flash('error', 'Invalid satisfaction rating');
    return res.redirect(`/tickets/${id}`);
  }

  try {
    const result = db.prepare(
      `UPDATE tickets SET satisfaction_rating = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(rating, id);
    if (result.changes === 0) {
      req.flash('error', 'Ticket not found');
      return res.redirect('/tickets');
    }
    req.audit('update', 'ticket', id, `Satisfaction rated ${rating}/5`);
    req.flash('success', 'Thank you for your feedback!');
  } catch (err) {
    console.error('Ticket satisfaction error:', err.message);
    req.flash('error', 'Error submitting rating');
  }
  res.redirect(`/tickets/${id}`);
});

// Delete ticket
router.delete('/:id', requireRole('admin', 'manager'), (req, res) => {
  const id = safeId(req.params.id);
  if (!id) { req.flash('error', 'Invalid ticket ID'); return res.redirect('/tickets'); }

  try {
    let changes = 0;
    const deleteStmt = db.transaction(() => {
      db.prepare('DELETE FROM ticket_comments WHERE ticket_id = ?').run(id);
      const result = db.prepare('DELETE FROM tickets WHERE id = ?').run(id);
      changes = result.changes;
    });
    deleteStmt();
    if (changes === 0) {
      req.flash('error', 'Ticket not found');
    } else {
      req.audit('delete', 'ticket', id, 'Deleted ticket');
      req.flash('success', 'Ticket deleted');
    }
  } catch (err) {
    console.error('Ticket delete error:', err.message);
    req.flash('error', 'Error deleting ticket');
  }
  res.redirect('/tickets');
});

module.exports = router;
