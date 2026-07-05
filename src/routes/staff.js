const db = require('../models/database');
const { requireAuth, requireAdminOrManager, requireAdmin } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { paginate, paginationBaseUrl, addSearch, buildFilters, safeId, validatePassword, isValidUsername, isValidEmail, trim, sanitizePhone, isValidPhone, recalcProjectProgress, asyncHandler, countQuery, selectQuery, safeQueryValue } = require('../utils');
const { USER_ROLES, MAX_USERNAME, MAX_PASSWORD, MAX_EMAIL, MAX_SHORT_STR, MAX_PHONE, BCRYPT_SALT_ROUNDS } = require('../constants');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { invalidateDashboardCache } = require('./dashboard');
const { clearLoginFailure, clearIpLoginFailure } = require('./auth');

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
    LIMIT 10
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
    ORDER BY p.updated_at DESC
  `);
const _staffUserStmt = db.prepare('SELECT id, role, username, is_active FROM users WHERE id = ?');
const _reactivateStmt = db.prepare('UPDATE users SET is_active = 1, updated_at = datetime(\'now\') WHERE id = ?');
const _passwordResetStmt = db.prepare('UPDATE users SET password = ?, password_changed_at = datetime(\'now\'), updated_at = datetime(\'now\') WHERE id = ?');
const _adminPasswordStmt = db.prepare('SELECT password FROM users WHERE id = ?');
const _deactivateStmt = db.prepare('UPDATE users SET is_active = 0, updated_at = datetime(\'now\') WHERE id = ?');
const _unassignTicketsStmt = db.prepare(`UPDATE tickets SET assigned_to = NULL, updated_at = datetime('now')
    WHERE assigned_to = ? AND status IN ('open', 'in_progress', 'waiting')`);
const _affectedProjectsStmt = db.prepare(
    'SELECT DISTINCT project_id FROM project_tasks WHERE assigned_to = ? AND status != \'done\''
  );
const _unassignTasksStmt = db.prepare(`UPDATE project_tasks SET assigned_to = NULL, updated_at = datetime('now')
    WHERE assigned_to = ? AND status != 'done'`);
// Only unassign SCHEDULED / IN_PROGRESS changes so finished records
// (completed/failed/cancelled) keep their assignee for historical attribution
// — the user row is only soft-deleted (is_active=0), so the LEFT JOIN in the
// show page still resolves the name. Mirrors the selective ticket/task unassign.
const _unassignChangesStmt = db.prepare(`UPDATE change_log SET assigned_to = NULL, updated_at = datetime('now')
    WHERE assigned_to = ? AND status NOT IN ('completed', 'failed', 'cancelled')`);
// Only clear ownership of ACTIVE projects (planning/in_progress/on_hold) so
// they can be reassigned; completed/cancelled projects keep their owner for
// history (the deactivated user row persists, so owner_name still resolves).
const _unassignProjectOwnerStmt = db.prepare(`UPDATE projects SET owner_id = NULL, updated_at = datetime('now')
    WHERE owner_id = ? AND status NOT IN ('completed', 'cancelled')`);

// Cached prepared statements for staff create/update routes
const _staffInsertStmt = db.prepare(`
    INSERT INTO users (username, password, email, first_name, last_name, role, department, phone)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
const _staffUpdateStmt = db.prepare(`
    UPDATE users SET email = ?, first_name = ?, last_name = ?, role = ?,
      department = ?, phone = ?, is_active = is_active, updated_at = datetime('now')
    WHERE id = ?
  `);

// Cached prepared statement for department list in staff index.
// Include all departments (not just those with active users) so the filter
// dropdown accurately represents all departments in the system.
const _departmentsStmt = db.prepare('SELECT DISTINCT department FROM users WHERE department IS NOT NULL ORDER BY department');

// List staff (paginated)
router.get('/', (req, res) => {
  const { page, limit, offset } = paginate(req);

  // Whitelist known departments from DB
  let departments = [];
  try {
    departments = _departmentsStmt.all().map(r => r.department);
  } catch (err) {
    console.error('Staff departments query error:', err.message);
  }
  const qStatus = safeQueryValue(req.query.status);
  const qRole = safeQueryValue(req.query.role);
  const qDept = safeQueryValue(req.query.department);
  const activeFilter = qStatus === 'active' ? 1 : qStatus === 'inactive' ? 0 : '';
  const filters = buildFilters({
    'u.role': { value: USER_ROLES.includes(qRole) ? qRole : '' },
    'u.department': { value: departments.includes(qDept) ? qDept : '' },
    'u.is_active': { value: activeFilter }
  }, ['u.role', 'u.department', 'u.is_active']);

  const where = [...filters.where];
  const params = [...filters.params];
  addSearch(where, params, safeQueryValue(req.query.search), ['u.first_name', 'u.last_name', 'u.email', 'u.username']);

  const whereClause = where.length ? where.join(' AND ') : '1=1';

  const total = countQuery(db, 'users', 'u', whereClause, params);
  const totalPages = Math.ceil(total / limit) || 1;

  const staff = selectQuery(db, `
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
  `, [...params, limit, offset]);

  res.render('pages/staff/index', {
    title: 'Staff', staff, departments, filters: req.query,
    page, limit, totalPages, total,
    baseUrl: paginationBaseUrl(req)
  });
});

// New staff form
router.get('/new', requireAdminOrManager, (req, res) => {
  res.render('pages/staff/form', { title: 'New Staff Member', staffMember: {}, isEdit: false, viewerRole: req.session.user.role });
});

// Rate limit staff creation to prevent account-mass-creation attacks
const createStaffLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: 'Too many staff creation attempts. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});

const staffWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: 'Too many staff update operations. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});

// Create staff
router.post('/', requireAdminOrManager, createStaffLimiter, asyncHandler(async (req, res) => {
  const username = trim(safeQueryValue(req.body.username)).toLowerCase();
  const password = safeQueryValue(req.body.password);
  const email = trim(safeQueryValue(req.body.email)).toLowerCase();
  const first_name = trim(safeQueryValue(req.body.first_name));
  const last_name = trim(safeQueryValue(req.body.last_name));
  const role = trim(safeQueryValue(req.body.role));
  const department = trim(safeQueryValue(req.body.department));
  const phone = sanitizePhone(safeQueryValue(req.body.phone));

  if (!username || !password || !email || !first_name || !last_name) {
    req.flash('error', 'All required fields must be filled in');
    return res.redirect('/staff/new');
  }
  // Reject non-string / excessively long passwords early to prevent bcrypt DoS
  if (typeof password !== 'string' || password.length > MAX_PASSWORD) {
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
  if (phone && phone.length > MAX_PHONE) {
    req.flash('error', `Phone number must be at most ${MAX_PHONE} characters`);
    return res.redirect('/staff/new');
  }
  if (first_name.length > MAX_SHORT_STR) {
    req.flash('error', `First name must be at most ${MAX_SHORT_STR} characters`);
    return res.redirect('/staff/new');
  }
  if (last_name.length > MAX_SHORT_STR) {
    req.flash('error', `Last name must be at most ${MAX_SHORT_STR} characters`);
    return res.redirect('/staff/new');
  }
  if (email.length > MAX_EMAIL) {
    req.flash('error', `Email must be at most ${MAX_EMAIL} characters`);
    return res.redirect('/staff/new');
  }
  if (department && department.length > MAX_SHORT_STR) {
    req.flash('error', `Department must be at most ${MAX_SHORT_STR} characters`);
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

  // Only admins can create admin accounts (managers must not escalate privileges)
  if (role === 'admin' && req.session.user.role !== 'admin') {
    req.flash('error', 'Only administrators can create admin accounts');
    return res.redirect('/staff/new');
  }

  const hashedPassword = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
  try {
    const result = _staffInsertStmt.run(username.substring(0, MAX_USERNAME), hashedPassword, email.substring(0, MAX_EMAIL), first_name.substring(0, MAX_SHORT_STR), last_name.substring(0, MAX_SHORT_STR), role, (department || '').substring(0, MAX_SHORT_STR), phone ? phone.substring(0, MAX_PHONE) : null);

    req.audit('create', 'user', result.lastInsertRowid, `Created user ${username}`);
    req.flash('success', `Staff member ${first_name} ${last_name} created`);
    invalidateDashboardCache();
    res.redirect('/staff');
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      req.flash('error', 'Username or email address is already in use');
    } else {
      console.error('Staff create error:', err.message);
      req.flash('error', 'Error creating staff member. Please try again.');
    }
    res.redirect('/staff/new');
  }
}));

// Show staff member
router.get('/:id', (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid staff ID');
    return res.redirect('/staff');
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
    req.flash('error', 'Invalid staff ID');
    return res.redirect('/staff');
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
  res.render('pages/staff/form', { title: 'Edit Staff Member', staffMember: user, isEdit: true, viewerRole: req.session.user.role });
});

// Update staff
router.put('/:id', requireAdminOrManager, staffWriteLimiter, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid staff ID');
    return res.redirect('/staff');
  }

  const email = trim(safeQueryValue(req.body.email)).toLowerCase();
  const first_name = trim(safeQueryValue(req.body.first_name));
  const last_name = trim(safeQueryValue(req.body.last_name));
  const department = trim(safeQueryValue(req.body.department));
  const phone = sanitizePhone(safeQueryValue(req.body.phone));
  if (!email || !first_name || !last_name) {
    req.flash('error', 'Email, first name, and last name are required');
    return res.redirect(`/staff/${id}/edit`);
  }
  if (!isValidEmail(email)) {
    req.flash('error', 'Please enter a valid email address');
    return res.redirect(`/staff/${id}/edit`);
  }
  if (first_name.length > MAX_SHORT_STR) {
    req.flash('error', `First name must be at most ${MAX_SHORT_STR} characters`);
    return res.redirect(`/staff/${id}/edit`);
  }
  if (last_name.length > MAX_SHORT_STR) {
    req.flash('error', `Last name must be at most ${MAX_SHORT_STR} characters`);
    return res.redirect(`/staff/${id}/edit`);
  }
  if (email.length > MAX_EMAIL) {
    req.flash('error', `Email must be at most ${MAX_EMAIL} characters`);
    return res.redirect(`/staff/${id}/edit`);
  }
  if (phone && !isValidPhone(phone)) {
    req.flash('error', 'Please enter a valid phone number');
    return res.redirect(`/staff/${id}/edit`);
  }
  if (phone && phone.length > MAX_PHONE) {
    req.flash('error', `Phone number must be at most ${MAX_PHONE} characters`);
    return res.redirect(`/staff/${id}/edit`);
  }
  if (department && department.length > MAX_SHORT_STR) {
    req.flash('error', `Department must be at most ${MAX_SHORT_STR} characters`);
    return res.redirect(`/staff/${id}/edit`);
  }
  const safeRole = trim(safeQueryValue(req.body.role));
  if (!USER_ROLES.includes(safeRole)) {
    req.flash('error', 'Invalid role');
    return res.redirect(`/staff/${id}/edit`);
  }

  // Fetch the target user to check their current role
  // (permission checks that depend on the fetched data must stay outside the
  // transaction since they redirect; the UPDATE itself is wrapped in a transaction
  // to prevent a TOCTOU race where the user is deleted between the check and UPDATE).
  const targetUser = _staffUserStmt.get(id);
  if (!targetUser) {
    req.flash('error', 'Staff member not found');
    return res.redirect('/staff');
  }

  // Only admins can assign the admin role
  if (safeRole === 'admin' && req.session.user.role !== 'admin') {
    req.flash('error', 'Only administrators can assign the admin role');
    return res.redirect(`/staff/${id}/edit`);
  }
  // Prevent admin from changing their own role (would lock themselves out)
  if (Number(id) === Number(req.session.user.id) && safeRole !== req.session.user.role) {
    req.flash('error', 'You cannot change your own role');
    return res.redirect(`/staff/${id}/edit`);
  }
  // Managers cannot edit or deactivate admin accounts
  if (req.session.user.role !== 'admin' && targetUser.role === 'admin') {
    req.flash('error', 'You cannot modify administrator accounts');
    return res.redirect('/staff');
  }
  // Preserve existing is_active on edit. Deactivation must go through the
  // dedicated DELETE route which also unassigns tickets/tasks atomically.
  // Setting is_active=0 via the edit form would bypass the unassignment logic,
  // but setting it to 1 would inadvertently reactivate a deactivated user.
  // The UPDATE SQL uses is_active = is_active (self-assign) to prevent a TOCTOU
  // race where is_active fetched earlier could be stale.
  if (!targetUser.is_active) {
    req.flash('info', 'This account is deactivated. Editing will not reactivate it — use the Reactivate button on the show page.');
  }

  try {
    // Verify the user still exists and update in a single transaction to avoid
    // a TOCTOU race where the user is deleted between the check and the UPDATE.
    const updateStaff = db.transaction(() => {
      const recheck = _staffUserStmt.get(id);
      if (!recheck) {
        throw new Error('NOT_FOUND');
      }
      _staffUpdateStmt.run(email.substring(0, MAX_EMAIL), first_name.substring(0, MAX_SHORT_STR), last_name.substring(0, MAX_SHORT_STR), safeRole,
        (department || '').substring(0, MAX_SHORT_STR), phone ? phone.substring(0, MAX_PHONE) : null, id);
    });
    updateStaff();

    req.audit('update', 'user', id, `Updated staff ${first_name} ${last_name}`);
    invalidateDashboardCache();

    // Keep session in sync if user is editing their own record (full reassign to ensure save with resave:false)
    if (Number(id) === Number(req.session.user.id)) {
      req.session.user = { ...req.session.user, first_name: first_name.substring(0, MAX_SHORT_STR), last_name: last_name.substring(0, MAX_SHORT_STR), email: email.substring(0, MAX_EMAIL), role: safeRole, department: (department || '').substring(0, MAX_SHORT_STR), phone: phone ? phone.substring(0, MAX_PHONE) : null };
    }

    req.flash('success', 'Staff member updated');
    res.redirect(`/staff/${id}`);
  } catch (err) {
    if (err.message === 'NOT_FOUND') {
      req.flash('error', 'Staff member not found');
      return res.redirect('/staff');
    }
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
const reactivateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: 'Too many reactivation attempts. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});

router.put('/:id/reactivate', requireAdmin, reactivateLimiter, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid staff ID');
    return res.redirect('/staff');
  }

  try {
    const target = _staffUserStmt.get(id);
    if (!target) {
      req.flash('error', 'Staff member not found');
      return res.redirect('/staff');
    }
    if (target.is_active) {
      req.flash('info', 'Account is already active');
      return res.redirect(`/staff/${id}`);
    }

    _reactivateStmt.run(id);

    // Clear any login failure lockout so the user can log in immediately
    // rather than waiting for the lockout to expire (which could persist
    // across the deactivation/reactivation cycle).
    if (target.username) {
      clearLoginFailure(target.username);
    }
    if (req.ip) {
      clearIpLoginFailure(req.ip);
    }

    req.audit('reactivate', 'user', id, 'Reactivated user account');
    invalidateDashboardCache();
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
    req.flash('error', 'Invalid staff ID');
    return res.redirect('/staff');
  }

  // Prevent admin from resetting own password via this route (use profile instead)
  if (Number(id) === Number(req.session.user.id)) {
    req.flash('error', 'Use the profile page to change your own password');
    return res.redirect('/profile');
  }

  const new_password = safeQueryValue(req.body.new_password);
  const current_password = safeQueryValue(req.body.current_password);
  if (!new_password || typeof new_password !== 'string') {
    req.flash('error', 'Password is required');
    return res.redirect(`/staff/${id}`);
  }
  if (new_password.length > MAX_PASSWORD) {
    req.flash('error', `Password must be at most ${MAX_PASSWORD} characters`);
    return res.redirect(`/staff/${id}`);
  }

  // Require the admin to confirm their own password before resetting another user's
  if (!current_password || typeof current_password !== 'string' || current_password.length > MAX_PASSWORD) {
    req.flash('error', 'Your current password is required to reset another user\'s password');
    return res.redirect(`/staff/${id}`);
  }
  const adminUser = _adminPasswordStmt.get(req.session.user.id);
  if (!adminUser || !(await bcrypt.compare(current_password, adminUser.password))) {
    req.flash('error', 'Your current password is incorrect');
    return res.redirect(`/staff/${id}`);
  }

  const pwErr = validatePassword(new_password);
  if (pwErr) {
    req.flash('error', pwErr);
    return res.redirect(`/staff/${id}`);
  }

  // Fetch the target user to get their username for login failure cleanup
  const targetUser = _staffUserStmt.get(id);
  if (!targetUser) {
    req.flash('error', 'Staff member not found');
    return res.redirect('/staff');
  }

  const hashed = await bcrypt.hash(new_password, BCRYPT_SALT_ROUNDS);
  _passwordResetStmt.run(hashed, id);

  // Clear any login failure lockout for this user so the password reset
  // takes effect immediately instead of waiting for lockout expiry.
  if (targetUser.username) {
    clearLoginFailure(targetUser.username);
  }

  req.audit('update', 'user', id, `Password reset by admin${targetUser.username ? ` (cleared login lockout for ${targetUser.username})` : ''}`);
  req.flash('success', 'Password reset successfully');
  res.redirect(`/staff/${id}`);
}));

// Rate limit staff deactivation (bcrypt DoS, account lockout bypass)
const deactivateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: 'Too many deactivation attempts. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});

// Delete staff (soft delete — deactivate)
router.delete('/:id', requireAdmin, deactivateLimiter, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid staff ID');
    return res.redirect('/staff');
  }

  // Prevent admin from deactivating themselves
  if (Number(id) === Number(req.session.user.id)) {
    req.flash('error', 'You cannot deactivate your own account');
    return res.redirect('/staff');
  }

  try {
    // Check is_active and deactivate in a single transaction to avoid a TOCTOU
    // race with concurrent activate/deactivate requests. Returns an object
    // describing the outcome instead of mutating outer-scope variables.
    const deactivate = db.transaction(() => {
      const target = _staffUserStmt.get(id);
      if (!target) {
        return { notFound: true };
      }
      if (!target.is_active) {
        return { alreadyInactive: true };
      }

      _deactivateStmt.run(id);

      // Unassign open/in_progress/waiting tickets so they don't stall on an inactive user
      _unassignTicketsStmt.run(id);

      // Unassign non-done project tasks and recalculate affected project progress
      const affectedProjects = _affectedProjectsStmt.all(id).map(r => r.project_id);

      _unassignTasksStmt.run(id);

      // Unassign change-log entries so they don't orphan on an inactive user
      _unassignChangesStmt.run(id);

      // Reassign projects owned by this user so they don't orphan
      _unassignProjectOwnerStmt.run(id);

      for (const projectId of affectedProjects) {
        recalcProjectProgress(db, projectId);
      }
      return { ok: true };
    });
    const result = deactivate();

    if (result.notFound) {
      req.flash('error', 'Staff member not found');
    } else if (result.alreadyInactive) {
      req.flash('info', 'Account is already inactive');
    } else {
      req.audit('deactivate', 'user', id, 'Deactivated user and unassigned open tickets/tasks/changes/projects');
      req.flash('success', 'Staff member deactivated and open tickets/tasks/changes unassigned');
      invalidateDashboardCache();
    }
  } catch (err) {
    console.error('Staff deactivate error:', err.message);
    req.flash('error', 'Error deactivating staff');
  }
  res.redirect('/staff');
});

module.exports = router;
