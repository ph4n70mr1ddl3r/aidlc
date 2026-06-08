const db = require('../models/database');
const { requireAuth, requireAdminOrManager, requireAdmin } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { paginate, paginationBaseUrl, addSearch, buildFilters, safeId, validatePassword, isValidUsername, isValidEmail, trim, sanitizePhone, isValidPhone, recalcProjectProgress, asyncHandler } = require('../utils');
const { USER_ROLES } = require('../constants');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');

const router = require('express').Router();
router.use(requireAuth, auditMiddleware);

// Cached prepared statements for show/edit routes (static SQL).
const _showStaffStmt = db.prepare('SELECT id, username, email, first_name, last_name, role, department, phone, avatar, is_active, last_login, created_at, updated_at FROM users WHERE id = ?');
const _assignedTicketsStmt = db.prepare(`
    SELECT id, ticket_number, title, status, priority, created_at
    FROM tickets WHERE assigned_to = ?
    ORDER BY CASE status WHEN 'open' THEN 1 WHEN 'in_progress' THEN 2 WHEN 'waiting' THEN 3 ELSE 4 END, created_at DESC
    LIMIT 10
  `);
const _assignedTasksStmt = db.prepare(`
    SELECT pt.*, p.name as project_name, p.id as project_id
    FROM project_tasks pt
    JOIN projects p ON pt.project_id = p.id
    WHERE pt.assigned_to = ? AND pt.status != 'done'
    ORDER BY pt.due_date ASC
  `);
const _assignedAssetsStmt = db.prepare(`
    SELECT id, asset_tag, name, category, status
    FROM assets WHERE assigned_to = ?
  `);
const _projectMembershipsStmt = db.prepare(`
    SELECT pm.role as project_role, p.name as project_name, p.id as project_id, p.status as project_status
    FROM project_members pm
    JOIN projects p ON pm.project_id = p.id
    WHERE pm.user_id = ?
  `);
const _staffRoleStmt = db.prepare('SELECT role FROM users WHERE id = ?');
const _reactivateCheckStmt = db.prepare('SELECT role, is_active FROM users WHERE id = ?');
const _reactivateStmt = db.prepare('UPDATE users SET is_active = 1, updated_at = datetime(\'now\') WHERE id = ?');
const _passwordResetStmt = db.prepare('UPDATE users SET password = ?, updated_at = datetime(\'now\') WHERE id = ?');
const _deactivateStmt = db.prepare('UPDATE users SET is_active = 0, updated_at = datetime(\'now\') WHERE id = ?');
const _unassignTicketsStmt = db.prepare(`UPDATE tickets SET assigned_to = NULL, updated_at = datetime('now')
    WHERE assigned_to = ? AND status IN ('open', 'in_progress', 'waiting')`);
const _affectedProjectsStmt = db.prepare(
    'SELECT DISTINCT project_id FROM project_tasks WHERE assigned_to = ? AND status != \'done\''
  );
const _unassignTasksStmt = db.prepare(`UPDATE project_tasks SET assigned_to = NULL, updated_at = datetime('now')
    WHERE assigned_to = ? AND status != 'done'`);

// Cached prepared statements for staff create/update routes
const _staffInsertStmt = db.prepare(`
    INSERT INTO users (username, password, email, first_name, last_name, role, department, phone)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
const _staffUpdateStmt = db.prepare(`
    UPDATE users SET email = ?, first_name = ?, last_name = ?, role = ?,
      department = ?, phone = ?, is_active = ?, updated_at = datetime('now')
    WHERE id = ?
  `);

// Cached prepared statement for department list in staff index
const _departmentsStmt = db.prepare('SELECT DISTINCT department FROM users WHERE department IS NOT NULL ORDER BY department');

// List staff (paginated)
router.get('/', (req, res) => {
  const { page, limit, offset } = paginate(req);

  const validRoles = USER_ROLES;
  // Whitelist known departments from DB
  const departments = _departmentsStmt.all().map(r => r.department);
  const validDepartments = departments;
  const filters = buildFilters({
    'u.role': { value: validRoles.includes(req.query.role) ? req.query.role : '' },
    'u.department': { value: validDepartments.includes(req.query.department) ? req.query.department : '' },
    'u.is_active': { value: req.query.status === 'active' ? 1 : req.query.status === 'inactive' ? 0 : '' }
  });

  const where = [...filters.where];
  const params = [...filters.params];
  addSearch(where, params, req.query.search, ['u.first_name', 'u.last_name', 'u.email', 'u.username']);

  const whereClause = where.length ? where.join(' AND ') : '1=1';

  const total = db.prepare(`SELECT COUNT(*) as c FROM users u WHERE ${whereClause}`).get(...params).c;
  const totalPages = Math.ceil(total / limit) || 1;

  const staff = db.prepare(`
    SELECT u.id, u.username, u.email, u.first_name, u.last_name, u.role,
      u.department, u.phone, u.avatar, u.is_active, u.last_login,
      u.created_at, u.updated_at,
      COALESCE(tCounts.open_tickets, 0) as open_tickets,
      COALESCE(ptCounts.open_tasks, 0) as open_tasks
    FROM users u
    LEFT JOIN (
      SELECT assigned_to, COUNT(*) as open_tickets
      FROM tickets WHERE status IN ('open','in_progress','waiting')
      GROUP BY assigned_to
    ) tCounts ON tCounts.assigned_to = u.id
    LEFT JOIN (
      SELECT assigned_to, COUNT(*) as open_tasks
      FROM project_tasks WHERE status IN ('todo','in_progress')
      GROUP BY assigned_to
    ) ptCounts ON ptCounts.assigned_to = u.id
    WHERE ${whereClause}
    ORDER BY u.first_name ASC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  res.render('pages/staff/index', {
    title: 'Staff', staff, departments, filters: req.query,
    page, limit, totalPages, total,
    baseUrl: paginationBaseUrl(req)
  });
});

// New staff form
router.get('/new', requireAdminOrManager, (req, res) => {
  res.render('pages/staff/form', { title: 'New Staff Member', user: {}, isEdit: false, viewerRole: req.session.user.role });
});

// Create staff
router.post('/', requireAdminOrManager, asyncHandler(async (req, res) => {
  const username = trim(req.body.username);
  const { password } = req.body;
  const email = trim(req.body.email);
  const first_name = trim(req.body.first_name);
  const last_name = trim(req.body.last_name);
  const { role } = req.body;
  const department = trim(req.body.department);
  const phone = sanitizePhone(req.body.phone);

  if (!username || !password || !email || !first_name || !last_name) {
    req.flash('error', 'All required fields must be filled in');
    return res.redirect('/staff/new');
  }
  // Reject non-string / excessively long passwords early to prevent bcrypt DoS
  if (typeof password !== 'string' || password.length > 128) {
    req.flash('error', 'Invalid password');
    return res.redirect('/staff/new');
  }
  if (!isValidUsername(username)) {
    req.flash('error', 'Username must be 2-50 characters and contain only letters, numbers, dots, dashes, and underscores');
    return res.redirect('/staff/new');
  }
  if (!isValidEmail(email)) {
    req.flash('error', 'Please enter a valid email address');
    return res.redirect('/staff/new');
  }
  if (phone && !isValidPhone(phone)) {
    req.flash('error', 'Please enter a valid phone number');
    return res.redirect('/staff/new');
  }
  const pwError = validatePassword(password);
  if (pwError) {
    req.flash('error', pwError);
    return res.redirect('/staff/new');
  }
  if (!USER_ROLES.includes(role)) {
    req.flash('error', 'Invalid role');
    return res.redirect('/staff/new');
  }

  const hashedPassword = await bcrypt.hash(password, 12);
  const result = _staffInsertStmt.run(username.substring(0, 50), hashedPassword, email.substring(0, 200), first_name.substring(0, 100), last_name.substring(0, 100), role, (department || '').substring(0, 100), phone ? phone.substring(0, 50) : null);

  req.audit('create', 'user', result.lastInsertRowid, `Created user ${username}`);
  req.flash('success', `Staff member ${first_name} ${last_name} created`);
  res.redirect('/staff');
}));

// Show staff member
router.get('/:id', (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
 req.flash('error', 'Invalid staff ID'); return res.redirect('/staff');
}

  const staffUser = _showStaffStmt.get(id);
  if (!staffUser) {
    req.flash('error', 'Staff member not found');
    return res.redirect('/staff');
  }

  const assignedTickets = _assignedTicketsStmt.all(id);

  const assignedTasks = _assignedTasksStmt.all(id);

  const assignedAssets = _assignedAssetsStmt.all(id);

  const projectMemberships = _projectMembershipsStmt.all(id);

  res.render('pages/staff/show', {
    title: `${staffUser.first_name} ${staffUser.last_name}`,
    staffUser,
    assignedTickets,
    assignedTasks,
    assignedAssets,
    projectMemberships
  });
});

// Edit staff form
router.get('/:id/edit', requireAdminOrManager, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
 req.flash('error', 'Invalid staff ID'); return res.redirect('/staff');
}

  const user = _showStaffStmt.get(id);
  if (!user) {
    req.flash('error', 'Staff member not found');
    return res.redirect('/staff');
  }
  // Managers cannot edit admin accounts
  if (req.session.user.role !== 'admin' && user.role === 'admin') {
    req.flash('error', 'You cannot modify administrator accounts');
    return res.redirect('/staff');
  }
  res.render('pages/staff/form', { title: 'Edit Staff Member', user, isEdit: true, viewerRole: req.session.user.role });
});

// Update staff
router.put('/:id', requireAdminOrManager, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
 req.flash('error', 'Invalid staff ID'); return res.redirect('/staff');
}

  const email = trim(req.body.email);
  const first_name = trim(req.body.first_name);
  const last_name = trim(req.body.last_name);
  const { role } = req.body;
  const department = trim(req.body.department);
  const phone = sanitizePhone(req.body.phone);
  if (!email || !first_name || !last_name) {
    req.flash('error', 'Email, first name, and last name are required');
    return res.redirect(`/staff/${id}/edit`);
  }
  if (!isValidEmail(email)) {
    req.flash('error', 'Please enter a valid email address');
    return res.redirect(`/staff/${id}/edit`);
  }
  if (phone && !isValidPhone(phone)) {
    req.flash('error', 'Please enter a valid phone number');
    return res.redirect(`/staff/${id}/edit`);
  }
  if (!USER_ROLES.includes(role)) {
    req.flash('error', 'Invalid role');
    return res.redirect(`/staff/${id}/edit`);
  }

  // Fetch the target user to check their current role
  const targetUser = _staffRoleStmt.get(id);
  if (!targetUser) {
 req.flash('error', 'Staff member not found'); return res.redirect('/staff');
}

  // Only admins can assign the admin role
  if (role === 'admin' && req.session.user.role !== 'admin') {
    req.flash('error', 'Only administrators can assign the admin role');
    return res.redirect(`/staff/${id}/edit`);
  }
  // Prevent admin from changing their own role (would lock themselves out)
  if (Number(id) === Number(req.session.user.id) && role !== req.session.user.role) {
    req.flash('error', 'You cannot change your own role');
    return res.redirect(`/staff/${id}/edit`);
  }
  // Managers cannot edit or deactivate admin accounts
  if (req.session.user.role !== 'admin' && targetUser.role === 'admin') {
    req.flash('error', 'You cannot modify administrator accounts');
    return res.redirect('/staff');
  }
  // Always keep is_active = 1 on the edit form. Deactivation must go through
  // the dedicated DELETE route which also unassigns tickets/tasks atomically.
  // Prevents bypassing the unassignment logic via the edit form.
  const safeIsActive = 1;

  try {
    _staffUpdateStmt.run(email.substring(0, 200), first_name.substring(0, 100), last_name.substring(0, 100), role,
      (department || '').substring(0, 100), (phone || '').substring(0, 50), safeIsActive, id);

    req.audit('update', 'user', id, `Updated staff ${first_name} ${last_name}`);

    // Keep session in sync if admin is editing their own record
    if (Number(id) === Number(req.session.user.id)) {
      req.session.user.first_name = first_name;
      req.session.user.last_name = last_name;
      req.session.user.email = email;
      req.session.user.role = role;
      req.session.user.department = department;
      req.session.user.phone = phone ? phone.substring(0, 50) : null;
    }

    req.flash('success', 'Staff member updated');
    res.redirect(`/staff/${id}`);
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      req.flash('error', 'Email address is already in use');
    } else {
      console.error('Staff update error:', err.message);
      req.flash('error', 'Error updating staff. Please try again.');
    }
    res.redirect(`/staff/${id}/edit`);
  }
});

// Reactivate staff (dedicated route — no hidden-field tampering risk)
router.put('/:id/reactivate', requireAdmin, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
 req.flash('error', 'Invalid staff ID'); return res.redirect('/staff');
}

  try {
    const target = _reactivateCheckStmt.get(id);
    if (!target) {
 req.flash('error', 'Staff member not found'); return res.redirect('/staff');
}
    if (target.is_active) {
 req.flash('info', 'Account is already active'); return res.redirect(`/staff/${id}`);
}

    _reactivateStmt.run(id);
    req.audit('update', 'user', id, 'Reactivated user account');
    req.flash('success', 'Account reactivated successfully');
  } catch (err) {
    console.error('Staff reactivate error:', err.message);
    req.flash('error', 'Error reactivating account');
  }
  res.redirect(`/staff/${id}`);
});

// Rate limit admin password resets to prevent bcrypt DoS
const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Too many password resets. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});

// Reset password
router.put('/:id/reset-password', requireAdmin, resetLimiter, asyncHandler(async (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
 req.flash('error', 'Invalid staff ID'); return res.redirect('/staff');
}

  // Prevent admin from resetting own password via this route (use profile instead)
  if (Number(id) === Number(req.session.user.id)) {
    req.flash('error', 'Use the profile page to change your own password');
    return res.redirect('/profile');
  }

  const { new_password } = req.body;
  if (!new_password || typeof new_password !== 'string') {
    req.flash('error', 'Password is required');
    return res.redirect(`/staff/${id}`);
  }
  if (new_password.length > 128) {
    req.flash('error', 'Password must be at most 128 characters');
    return res.redirect(`/staff/${id}`);
  }
  const pwErr = validatePassword(new_password);
  if (pwErr) {
    req.flash('error', pwErr);
    return res.redirect(`/staff/${id}`);
  }

  const hashed = await bcrypt.hash(new_password, 12);
  _passwordResetStmt.run(hashed, id);

  req.audit('update', 'user', id, 'Password reset by admin');
  req.flash('success', 'Password reset successfully');
  res.redirect(`/staff/${id}`);
}));

// Delete staff (soft delete — deactivate)
router.delete('/:id', requireAdmin, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
 req.flash('error', 'Invalid staff ID'); return res.redirect('/staff');
}

  // Prevent admin from deactivating themselves
  if (Number(id) === Number(req.session.user.id)) {
    req.flash('error', 'You cannot deactivate your own account');
    return res.redirect('/staff');
  }

  // Early check: skip expensive transaction if user is already inactive
  const targetCheck = _reactivateCheckStmt.get(id);
  if (!targetCheck) {
    req.flash('error', 'Staff member not found');
    return res.redirect('/staff');
  }
  if (!targetCheck.is_active) {
    req.flash('info', 'Account is already inactive');
    return res.redirect('/staff');
  }

  try {
    let changes = 0;
    const deactivate = db.transaction(() => {
      const result = _deactivateStmt.run(id);
      changes = result.changes;
      if (changes === 0) {
return;
}

      // Unassign open/in_progress/waiting tickets so they don't stall on an inactive user
      _unassignTicketsStmt.run(id);

      // Unassign non-done project tasks and recalculate affected project progress
      const affectedProjects = _affectedProjectsStmt.all(id).map(r => r.project_id);

      _unassignTasksStmt.run(id);

      for (const projectId of affectedProjects) {
        recalcProjectProgress(db, projectId);
      }
    });
    deactivate();

    if (changes === 0) {
      req.flash('error', 'Staff member not found');
    } else {
      req.audit('deactivate', 'user', id, 'Deactivated user and unassigned open tickets/tasks');
      req.flash('success', 'Staff member deactivated and open tickets/tasks unassigned');
    }
  } catch (err) {
    console.error('Staff deactivate error:', err.message);
    req.flash('error', 'Error deactivating staff');
  }
  res.redirect('/staff');
});

module.exports = router;
