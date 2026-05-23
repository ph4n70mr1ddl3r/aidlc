const db = require('../models/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const bcrypt = require('bcryptjs');

const router = require('express').Router();
router.use(requireAuth);

// List staff
router.get('/', (req, res) => {
  const { role, department, search } = req.query;
  let where = ['1=1'];
  let params = [];
  
  if (role) { where.push('role = ?'); params.push(role); }
  if (department) { where.push('department = ?'); params.push(department); }
  if (search) {
    where.push('(first_name LIKE ? OR last_name LIKE ? OR email LIKE ? OR username LIKE ?)');
    const term = `%${search}%`;
    params.push(term, term, term, term);
  }
  
  const staff = db.prepare(`
    SELECT u.*,
      (SELECT COUNT(*) FROM tickets WHERE assigned_to = u.id AND status IN ('open','in_progress','waiting')) as open_tickets,
      (SELECT COUNT(*) FROM project_tasks WHERE assigned_to = u.id AND status IN ('todo','in_progress')) as open_tasks
    FROM users u
    WHERE ${where.join(' AND ')}
    ORDER BY u.first_name ASC
  `).all(...params);

  const departments = db.prepare('SELECT DISTINCT department FROM users WHERE department IS NOT NULL ORDER BY department').all().map(r => r.department);
  
  res.render('pages/staff/index', { title: 'Staff', staff, departments, filters: req.query });
});

// New staff form
router.get('/new', requireRole('admin', 'manager'), (req, res) => {
  res.render('pages/staff/form', { title: 'New Staff Member', user: {}, isEdit: false });
});

// Create staff
router.post('/', requireRole('admin', 'manager'), (req, res) => {
  const { username, password, email, first_name, last_name, role, department, phone } = req.body;
  
  try {
    const hashedPassword = bcrypt.hashSync(password, 10);
    db.prepare(`
      INSERT INTO users (username, password, email, first_name, last_name, role, department, phone)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(username, hashedPassword, email, first_name, last_name, role, department, phone);
    
    req.flash('success', `Staff member ${first_name} ${last_name} created`);
    res.redirect('/staff');
  } catch (err) {
    req.flash('error', 'Error creating staff member: ' + err.message);
    res.redirect('/staff/new');
  }
});

// Show staff member
router.get('/:id', (req, res) => {
  const staffUser = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!staffUser) {
    req.flash('error', 'Staff member not found');
    return res.redirect('/staff');
  }

  const { password: _, ...safeUser } = staffUser;
  
  const assignedTickets = db.prepare(`
    SELECT id, ticket_number, title, status, priority, created_at
    FROM tickets WHERE assigned_to = ?
    ORDER BY CASE status WHEN 'open' THEN 1 WHEN 'in_progress' THEN 2 WHEN 'waiting' THEN 3 ELSE 4 END, created_at DESC
    LIMIT 10
  `).all(req.params.id);

  const assignedTasks = db.prepare(`
    SELECT pt.*, p.name as project_name, p.id as project_id
    FROM project_tasks pt
    JOIN projects p ON pt.project_id = p.id
    WHERE pt.assigned_to = ? AND pt.status != 'done'
    ORDER BY pt.due_date ASC
  `).all(req.params.id);

  const assignedAssets = db.prepare(`
    SELECT id, asset_tag, name, category, status
    FROM assets WHERE assigned_to = ?
  `).all(req.params.id);

  const projectMemberships = db.prepare(`
    SELECT pm.role as project_role, p.name as project_name, p.id as project_id, p.status as project_status
    FROM project_members pm
    JOIN projects p ON pm.project_id = p.id
    WHERE pm.user_id = ?
  `).all(req.params.id);

  res.render('pages/staff/show', {
    title: `${safeUser.first_name} ${safeUser.last_name}`,
    staffUser: safeUser,
    assignedTickets,
    assignedTasks,
    assignedAssets,
    projectMemberships
  });
});

// Edit staff form
router.get('/:id/edit', requireRole('admin', 'manager'), (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) {
    req.flash('error', 'Staff member not found');
    return res.redirect('/staff');
  }
  res.render('pages/staff/form', { title: 'Edit Staff Member', user, isEdit: true });
});

// Update staff
router.put('/:id', requireRole('admin', 'manager'), (req, res) => {
  const { email, first_name, last_name, role, department, phone, is_active } = req.body;
  
  try {
    db.prepare(`
      UPDATE users SET email = ?, first_name = ?, last_name = ?, role = ?,
        department = ?, phone = ?, is_active = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(email, first_name, last_name, role, department, phone, is_active ? 1 : 0, req.params.id);
    
    req.flash('success', 'Staff member updated');
    res.redirect(`/staff/${req.params.id}`);
  } catch (err) {
    req.flash('error', 'Error updating staff: ' + err.message);
    res.redirect(`/staff/${req.params.id}/edit`);
  }
});

// Reset password
router.put('/:id/reset-password', requireRole('admin'), (req, res) => {
  const { new_password } = req.body;
  if (!new_password || new_password.length < 6) {
    req.flash('error', 'Password must be at least 6 characters');
    return res.redirect(`/staff/${req.params.id}`);
  }
  
  const hashed = bcrypt.hashSync(new_password, 10);
  db.prepare(`UPDATE users SET password = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(hashed, req.params.id);
  
  req.flash('success', 'Password reset successfully');
  res.redirect(`/staff/${req.params.id}`);
});

// Delete staff
router.delete('/:id', requireRole('admin'), (req, res) => {
  try {
    db.prepare(`UPDATE users SET is_active = 0, updated_at = datetime('now') WHERE id = ?`).run(req.params.id);
    req.flash('success', 'Staff member deactivated');
  } catch (err) {
    req.flash('error', 'Error deactivating staff');
  }
  res.redirect('/staff');
});

module.exports = router;
