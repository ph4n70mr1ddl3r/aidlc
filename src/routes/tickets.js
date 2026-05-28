const db = require('../models/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { paginate, paginationBaseUrl, addSearch, buildFilters, safeId } = require('../utils');
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
  const orderBy = SORT_MAP[req.query.sort] || SORT_MAP.newest;

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

  const staff = db.prepare('SELECT id, first_name, last_name FROM users WHERE is_active = 1 ORDER BY first_name').all();

  res.render('pages/tickets/index', {
    title: 'Tickets', tickets, staff, filters: req.query,
    page, totalPages, total,
    baseUrl: paginationBaseUrl(req),
  });
});

// New ticket form
router.get('/new', (req, res) => {
  const staff = db.prepare('SELECT id, first_name, last_name FROM users WHERE is_active = 1 ORDER BY first_name').all();
  const assets = db.prepare('SELECT id, asset_tag, name FROM assets ORDER BY name').all();
  res.render('pages/tickets/form', { title: 'New Ticket', ticket: {}, staff, assets, isEdit: false });
});

// Create ticket
router.post('/', (req, res) => {
  const { title, description, category, priority, requester_name, requester_email,
          requester_department, requester_phone, assigned_to, asset_id, due_date } = req.body;

  if (!title || !title.trim() || !category || !requester_name || !requester_email) {
    req.flash('error', 'Title, category, requester name, and requester email are required');
    return res.redirect('/tickets/new');
  }

  if (!VALID_CATEGORIES.includes(category)) {
    req.flash('error', 'Invalid category');
    return res.redirect('/tickets/new');
  }
  const safePriority = VALID_PRIORITIES.includes(priority) ? priority : 'medium';

  // Generate ticket number atomically
  const createTicket = db.transaction(() => {
    const count = db.prepare("SELECT COUNT(*) as c FROM tickets WHERE date(created_at) = date('now')").get().c;
    const ticket_number = `TK-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${String(count + 1).padStart(3, '0')}`;
    const result = db.prepare(`
      INSERT INTO tickets (ticket_number, title, description, category, priority,
        requester_name, requester_email, requester_department, requester_phone,
        assigned_to, asset_id, due_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(ticket_number, title.substring(0, 200), (description || '').substring(0, 5000), category, safePriority,
      requester_name.substring(0, 100), requester_email.substring(0, 200), (requester_department || '').substring(0, 100), (requester_phone || '').substring(0, 50),
      assigned_to ? safeId(assigned_to) : null, asset_id ? safeId(asset_id) : null, due_date || null);
    return { ticket_number, id: result.lastInsertRowid };
  });

  try {
    const { ticket_number, id } = createTicket();

    req.audit('create', 'ticket', id, `Created ticket ${ticket_number}`);
    req.flash('success', `Ticket ${ticket_number} created successfully`);
    res.redirect('/tickets');
  } catch (err) {
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

  const staff = db.prepare('SELECT id, first_name, last_name FROM users WHERE is_active = 1 ORDER BY first_name').all();

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
  const staff = db.prepare('SELECT id, first_name, last_name FROM users WHERE is_active = 1 ORDER BY first_name').all();
  const assets = db.prepare('SELECT id, asset_tag, name FROM assets ORDER BY name').all();
  res.render('pages/tickets/form', { title: 'Edit Ticket', ticket, staff, assets, isEdit: true });
});

// Update ticket
router.put('/:id', (req, res) => {
  const id = safeId(req.params.id);
  if (!id) { req.flash('error', 'Invalid ticket ID'); return res.redirect('/tickets'); }

  const { title, description, category, priority, status, assigned_to, asset_id,
          due_date, resolution_notes } = req.body;

  if (!title || !title.trim()) {
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
  const safeStatus = VALID_STATUSES.includes(status) ? status : undefined;
  if (!safeStatus) {
    req.flash('error', 'Status is required');
    return res.redirect(`/tickets/${id}/edit`);
  }

  try {
    // Fetch current ticket to compare status transitions
    const ticket = db.prepare('SELECT status FROM tickets WHERE id = ?').get(id);
    if (!ticket) { req.flash('error', 'Ticket not found'); return res.redirect('/tickets'); }

    let query = `UPDATE tickets SET title = ?, description = ?, category = ?, priority = ?,
        status = ?, assigned_to = ?, asset_id = ?, due_date = ?, resolution_notes = ?,
        updated_at = datetime('now')`;
    const params = [title.substring(0, 200), (description || '').substring(0, 5000), safeCategory, safePriority, safeStatus,
      assigned_to ? safeId(assigned_to) : null, asset_id ? safeId(asset_id) : null, due_date || null, (resolution_notes || '').substring(0, 5000)];

    const wasResolved = ticket.status === 'resolved' || ticket.status === 'closed';
    const isNowResolved = status === 'resolved' || status === 'closed';
    if (isNowResolved && !wasResolved) {
      query += `, resolved_at = datetime('now')`;
    } else if (!isNowResolved && wasResolved) {
      query += `, resolved_at = NULL`;
    }
    query += ` WHERE id = ?`;
    params.push(id);

    db.prepare(query).run(...params);

    req.audit('update', 'ticket', id, `Updated ticket (status: ${status})`);
    req.flash('success', 'Ticket updated successfully');
    res.redirect(`/tickets/${id}`);
  } catch (err) {
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
    return res.redirect(`/tickets/${req.params.id}`);
  }

  try {
    db.prepare(`
      INSERT INTO ticket_comments (ticket_id, user_id, comment, is_internal)
      VALUES (?, ?, ?, ?)
    `).run(id, req.session.user.id, comment.trim().substring(0, 5000), is_internal ? 1 : 0);

    req.audit('comment', 'ticket', id, 'Added comment');
    req.flash('success', 'Comment added');
  } catch (err) {
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
    db.prepare(query).run(status, id);
    req.audit('update', 'ticket', id, `Status changed to ${status}`);
    req.flash('success', `Ticket status updated to ${status.replace(/_/g, ' ')}`);
  } catch (err) {
    req.flash('error', 'Error updating status');
  }
  res.redirect(`/tickets/${id}`);
});

// Delete ticket
router.delete('/:id', requireRole('admin', 'manager'), (req, res) => {
  const id = safeId(req.params.id);
  if (!id) { req.flash('error', 'Invalid ticket ID'); return res.redirect('/tickets'); }

  try {
    const deleteStmt = db.transaction(() => {
      db.prepare('DELETE FROM ticket_comments WHERE ticket_id = ?').run(id);
      db.prepare('DELETE FROM tickets WHERE id = ?').run(id);
    });
    deleteStmt();
    req.audit('delete', 'ticket', id, 'Deleted ticket');
    req.flash('success', 'Ticket deleted');
  } catch (err) {
    req.flash('error', 'Error deleting ticket');
  }
  res.redirect('/tickets');
});

module.exports = router;
