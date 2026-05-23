const db = require('../models/database');
const { requireAuth } = require('../middleware/auth');

const router = require('express').Router();
router.use(requireAuth);

// List tickets
router.get('/', (req, res) => {
  const { status, priority, category, assigned_to, search, sort } = req.query;
  
  let where = ['1=1'];
  let params = [];
  
  if (status) { where.push('t.status = ?'); params.push(status); }
  if (priority) { where.push('t.priority = ?'); params.push(priority); }
  if (category) { where.push('t.category = ?'); params.push(category); }
  if (assigned_to) { where.push('t.assigned_to = ?'); params.push(assigned_to); }
  if (search) { 
    where.push('(t.title LIKE ? OR t.description LIKE ? OR t.ticket_number LIKE ?)'); 
    const term = `%${search}%`;
    params.push(term, term, term);
  }
  
  const orderBy = sort === 'oldest' ? 't.created_at ASC' :
                  sort === 'priority' ? "CASE t.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 END, t.created_at ASC" :
                  't.created_at DESC';

  const tickets = db.prepare(`
    SELECT t.*, u.first_name || ' ' || u.last_name as assigned_name
    FROM tickets t
    LEFT JOIN users u ON t.assigned_to = u.id
    WHERE ${where.join(' AND ')}
    ORDER BY ${orderBy}
  `).all(...params);

  const staff = db.prepare('SELECT id, first_name, last_name FROM users WHERE is_active = 1 ORDER BY first_name').all();
  
  res.render('pages/tickets/index', { title: 'Tickets', tickets, staff, filters: req.query });
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
  
  // Generate ticket number
  const count = db.prepare("SELECT COUNT(*) as c FROM tickets WHERE date(created_at) = date('now')").get().c;
  const ticket_number = `TK-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${String(count + 1).padStart(3, '0')}`;
  
  try {
    db.prepare(`
      INSERT INTO tickets (ticket_number, title, description, category, priority,
        requester_name, requester_email, requester_department, requester_phone,
        assigned_to, asset_id, due_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(ticket_number, title, description, category, priority,
      requester_name, requester_email, requester_department, requester_phone,
      assigned_to || null, asset_id || null, due_date || null);
    
    req.flash('success', `Ticket ${ticket_number} created successfully`);
    res.redirect('/tickets');
  } catch (err) {
    req.flash('error', 'Error creating ticket: ' + err.message);
    res.redirect('/tickets/new');
  }
});

// Show ticket
router.get('/:id', (req, res) => {
  const ticket = db.prepare(`
    SELECT t.*, u.first_name || ' ' || u.last_name as assigned_name,
      a.name as asset_name, a.asset_tag
    FROM tickets t
    LEFT JOIN users u ON t.assigned_to = u.id
    LEFT JOIN assets a ON t.asset_id = a.id
    WHERE t.id = ?
  `).get(req.params.id);
  
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
  `).all(req.params.id);

  const staff = db.prepare('SELECT id, first_name, last_name FROM users WHERE is_active = 1 ORDER BY first_name').all();
  
  res.render('pages/tickets/show', { title: `Ticket ${ticket.ticket_number}`, ticket, comments, staff });
});

// Edit ticket form
router.get('/:id/edit', (req, res) => {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
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
  const { title, description, category, priority, status, assigned_to, asset_id, 
          due_date, resolution_notes } = req.body;
  
  try {
    let query = `UPDATE tickets SET title = ?, description = ?, category = ?, priority = ?,
        status = ?, assigned_to = ?, asset_id = ?, due_date = ?, resolution_notes = ?,
        updated_at = datetime('now')`;
    const params = [title, description, category, priority, status,
      assigned_to || null, asset_id || null, due_date || null, resolution_notes];
    
    if (status === 'resolved' || status === 'closed') {
      query += `, resolved_at = datetime('now')`;
    }
    query += ` WHERE id = ?`;
    params.push(req.params.id);
    
    db.prepare(query).run(...params);
    
    req.flash('success', 'Ticket updated successfully');
    res.redirect(`/tickets/${req.params.id}`);
  } catch (err) {
    req.flash('error', 'Error updating ticket: ' + err.message);
    res.redirect(`/tickets/${req.params.id}/edit`);
  }
});

// Add comment
router.post('/:id/comments', (req, res) => {
  const { comment, is_internal } = req.body;
  
  try {
    db.prepare(`
      INSERT INTO ticket_comments (ticket_id, user_id, comment, is_internal)
      VALUES (?, ?, ?, ?)
    `).run(req.params.id, req.session.user.id, comment, is_internal ? 1 : 0);
    
    req.flash('success', 'Comment added');
  } catch (err) {
    req.flash('error', 'Error adding comment');
  }
  res.redirect(`/tickets/${req.params.id}`);
});

// Quick status update
router.put('/:id/status', (req, res) => {
  const { status } = req.body;
  try {
    let query = `UPDATE tickets SET status = ?, updated_at = datetime('now')`;
    if (status === 'resolved' || status === 'closed') {
      query += `, resolved_at = datetime('now')`;
    }
    query += ` WHERE id = ?`;
    db.prepare(query).run(status, req.params.id);
    req.flash('success', `Ticket status updated to ${status}`);
  } catch (err) {
    req.flash('error', 'Error updating status');
  }
  res.redirect(`/tickets/${req.params.id}`);
});

// Delete ticket
router.delete('/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM tickets WHERE id = ?').run(req.params.id);
    req.flash('success', 'Ticket deleted');
  } catch (err) {
    req.flash('error', 'Error deleting ticket');
  }
  res.redirect('/tickets');
});

module.exports = router;
