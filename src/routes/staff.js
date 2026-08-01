const db = require('../models/database');
const { requireAuth, requireAdminOrManager, requireAdmin } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { paginate, paginationBaseUrl, addSearch, buildFilters, safeId, validatePassword, isValidUsername, isValidEmail, trim, sanitizePhone, isValidPhone, recalcProjectProgress, asyncHandler, countQuery, selectQuery, safeQueryValue, safeFilters, isPrivileged, rejectHppArrays } = require('../utils');
const { USER_ROLES, MAX_USERNAME, MAX_PASSWORD_BYTES, MAX_EMAIL, MAX_SHORT_STR, MAX_PHONE, BCRYPT_SALT_ROUNDS } = require('../constants');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { invalidateDashboardCache } = require('./dashboard');
const { clearLoginFailure } = require('./auth');

const router = require('express').Router();
router.use(requireAuth, auditMiddleware);

// Cached prepared statements for show/edit routes (static SQL).
const _showStaffStmt = db.prepare('SELECT id, username, email, first_name, last_name, role, department, phone, avatar, is_active, last_login, password_changed_at, created_at, updated_at FROM users WHERE id = ?');
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
// Cap the result set — a user could be assigned many assets (unlike the
// status-filtered ticket/task queries above), and this summary view must not
// load/render an unbounded number of rows. Mirrors the LIMIT on the sibling
// _assignedTicketsStmt / _assignedTasksStmt queries.
const _assignedAssetsStmt = db.prepare(`
    SELECT id, asset_tag, name, category, status
    FROM assets WHERE assigned_to = ?
    LIMIT 50
  `);
const _projectMembershipsStmt = db.prepare(`
    SELECT pm.role as project_role, p.name as project_name, p.id as project_id, p.status as project_status
    FROM project_members pm
    JOIN projects p ON pm.project_id = p.id
    WHERE pm.user_id = ?
    ORDER BY p.updated_at DESC
  `);
const _staffUserStmt = db.prepare('SELECT id, role, username, is_active FROM users WHERE id = ?');
const _reactivateStmt = db.prepare('UPDATE users SET is_active = 1, updated_at = datetime(\'now\') WHERE id = ? AND is_active = 0');
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

  // PII disclosure control: mirror the protection on the GET /:id show route.
  // Non-privileged users (regular staff) must not be able to harvest other
  // employees' email/phone via the directory listing. Only privileged users
  // (admin/manager) and the user themselves receive those fields; everyone
  // else gets them zeroed out before rendering.
  const viewer = req.session.user;
  const viewerPrivileged = isPrivileged(viewer);
  if (!viewerPrivileged) {
    for (const s of staff) {
      if (Number(s.id) !== Number(viewer.id)) {
        s.email = null;
        s.phone = null;
        s.department = null;
      }
    }
  }

  res.render('pages/staff/index', {
    title: 'Staff', staff, departments,
    filters: safeFilters(req.query, ['search', 'status', 'role', 'department']),
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
  // Fail closed on HTTP parameter pollution: reject array payloads.
  const hppErrors = rejectHppArrays(req, ['username', 'password', 'email', 'first_name', 'last_name', 'role', 'department', 'phone']);
  if (hppErrors.length > 0) {
    req.flash('error', 'Invalid request parameters');
    return res.redirect('/staff/new');
  }

  const username = trim(safeQueryValue(req.body.username)).toLowerCase();
  const password = safeQueryValue(req.body.password);
  const email = trim(safeQueryValue(req.body.email)).toLowerCase();
  const first_name = trim(safeQueryValue(req.body.first_name));
  const last_name = trim(safeQueryValue(req.body.last_name));
  const role = trim(safeQueryValue(req.body.role));
  const department = trim(safeQueryValue(req.body.department));
  const rawPhone = safeQueryValue(req.body.phone);
  // Reject overly long phone input before expensive sanitization
  if (typeof rawPhone === 'string' && rawPhone.length > MAX_PHONE) {
    req.flash('error', `Phone number must be at most ${MAX_PHONE} characters`);
    return res.redirect('/staff/new');
  }
  const phone = sanitizePhone(rawPhone);
  // Fail closed on a present-but-malformed phone: a value that sanitizes to
  // nothing (e.g. "abc", or a non-string JSON value) must be rejected rather
  // than silently stored as NULL — the fail-closed convention applied to every
  // other present-but-invalid field. Absent/empty values are allowed (no phone).
  if (rawPhone !== undefined && rawPhone !== null && rawPhone !== '' && !phone) {
    req.flash('error', 'Please enter a valid phone number');
    return res.redirect('/staff/new');
  }

  if (!username || !password || !email || !first_name || !last_name) {
    req.flash('error', 'All required fields must be filled in');
    return res.redirect('/staff/new');
  }
  // Reject non-string / excessively long passwords early to prevent bcrypt DoS
  // and silent 72-byte truncation.
  if (typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
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

  // Only admins can create privileged accounts (manager/admin). Managers must
  // not be able to escalate privileges by creating new manager accounts.
  if (role !== 'staff' && req.session.user.role !== 'admin') {
    req.flash('error', 'Only administrators can create manager or admin accounts');
    return res.redirect('/staff/new');
  }

  const hashedPassword = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
  try {
    const result = _staffInsertStmt.run(username.substring(0, MAX_USERNAME), hashedPassword, email.substring(0, MAX_EMAIL), first_name.substring(0, MAX_SHORT_STR), last_name.substring(0, MAX_SHORT_STR), role, (department || '').substring(0, MAX_SHORT_STR) || null, phone ? phone.substring(0, MAX_PHONE) : null);

    req.audit('create', 'user', Number(result.lastInsertRowid), `Created user ${username}`);
    req.flash('success', `Staff member ${first_name} ${last_name} created`);
    invalidateDashboardCache();
    return res.redirect('/staff');
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      req.flash('error', 'An account with this username or email address already exists');
    } else {
      console.error('Staff create error:', err.message);
      req.flash('error', 'Error creating staff member. Please try again.');
    }
    return res.redirect('/staff/new');
  }
}));

// Show staff member
router.get('/:id', (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid staff ID');
    return res.redirect('/staff');
  }

  // PII disclosure control: only privileged users (admin/manager) or the user
  // themselves may view a staff profile. A regular staff member enumerating
  // IDs must not be able to read other employees' email/phone/department.
  const isSelf = Number(id) === Number(req.session.user.id);
  if (!isPrivileged(req.session.user) && !isSelf) {
    req.flash('error', 'You do not have permission to view that staff member');
    return res.redirect('/staff');
  }

  const staffUser = _showStaffStmt.get(id);
  if (!staffUser) {
    req.flash('error', 'Staff member not found');
    return res.redirect('/staff');
  }

  req.audit('read', 'user', id, `Viewed staff profile: ${staffUser.first_name} ${staffUser.last_name}`);

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
  if (req.session.user.role !== 'admin' && user.role !== 'staff') {
    req.flash('error', 'You cannot modify administrator or manager accounts');
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

  // Fail closed on HTTP parameter pollution: reject array payloads.
  const hppErrors = rejectHppArrays(req, ['email', 'first_name', 'last_name', 'department', 'phone', 'role']);
  if (hppErrors.length > 0) {
    req.flash('error', 'Invalid request parameters');
    return res.redirect(`/staff/${id}/edit`);
  }

  const email = trim(safeQueryValue(req.body.email)).toLowerCase();
  const first_name = trim(safeQueryValue(req.body.first_name));
  const last_name = trim(safeQueryValue(req.body.last_name));
  const department = trim(safeQueryValue(req.body.department));
  const rawPhone = safeQueryValue(req.body.phone);
  // Reject overly long phone input before expensive sanitization
  if (typeof rawPhone === 'string' && rawPhone.length > MAX_PHONE) {
    req.flash('error', `Phone number must be at most ${MAX_PHONE} characters`);
    return res.redirect(`/staff/${id}/edit`);
  }
  const phone = sanitizePhone(rawPhone);
  // Fail closed on a present-but-malformed phone: a value that sanitizes to
  // nothing (e.g. "abc", or a non-string JSON value) must be rejected rather
  // than silently stored as NULL — the fail-closed convention applied to every
  // other present-but-invalid field. Absent/empty values are allowed (no phone).
  if (rawPhone !== undefined && rawPhone !== null && rawPhone !== '' && !phone) {
    req.flash('error', 'Please enter a valid phone number');
    return res.redirect(`/staff/${id}/edit`);
  }
  if (!email || !first_name || !last_name) {
    req.flash('error', 'Email, first name, and last name are required');
    return res.redirect(`/staff/${id}/edit`);
  }
  if (email.length > MAX_EMAIL) {
    req.flash('error', `Email must be at most ${MAX_EMAIL} characters`);
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
  if (phone && !isValidPhone(phone)) {
    req.flash('error', 'Please enter a valid phone number');
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

  // Only admins can assign privileged roles (manager/admin). A manager must
  // not be able to escalate a staff user to manager (or another admin), which
  // would grant near-admin capabilities. Managers are limited to editing
  // staff-role users.
  if (safeRole !== 'staff' && req.session.user.role !== 'admin') {
    req.flash('error', 'Only administrators can assign the manager or admin role');
    return res.redirect(`/staff/${id}/edit`);
  }
  // Prevent admin from changing their own role (would lock themselves out)
  if (Number(id) === Number(req.session.user.id) && safeRole !== req.session.user.role) {
    req.flash('error', 'You cannot change your own role');
    return res.redirect(`/staff/${id}/edit`);
  }
  // Managers cannot edit or deactivate admin accounts, nor other managers
  // (only admins may manage manager accounts).
  if (req.session.user.role !== 'admin' && targetUser.role !== 'staff') {
    req.flash('error', 'You cannot modify administrator or manager accounts');
    return res.redirect('/staff');
  }
  // Preserve existing is_active on edit. Deactivation must go through the
  // dedicated DELETE route which also unassigns tickets/tasks atomically.
  // Setting is_active=0 via the edit form would bypass the unassignment logic,
  // but setting it to 1 would inadvertently reactivate a deactivated user.
  // The UPDATE SQL uses is_active = is_active (self-assign) to prevent a TOCTOU
  // race where is_active fetched earlier could be stale.

  // Capture the deactivation state from inside the transaction (recheck) rather
  // than the stale outer fetch, so the informational flash reflects the actual
  // row state at update time (consistent with the role recheck below).
  let wasInactive = false;
  try {
    // Verify the user still exists, recheck admin protection, and update in a
    // single transaction to avoid TOCTOU races: the user could be deleted or
    // their role changed between the outer checks and the UPDATE. Rechecking
    // the role inside the transaction prevents a concurrent admin role downgrade
    // from letting a manager bypass the admin protection, AND prevents a
    // concurrent admin role-upgrade from being silently overwritten by the
    // stale `safeRole` value from the outer check.
    const updateStaff = db.transaction(() => {
      const recheck = _staffUserStmt.get(id);
      if (!recheck) {
        throw new Error('NOT_FOUND');
      }
      // Recheck admin/manager protection inside the transaction so a concurrent
      // role change between the outer check and the UPDATE cannot bypass the
      // guard (managers must not modify admin or manager accounts).
      if (req.session.user.role !== 'admin' && recheck.role !== 'staff') {
        throw new Error('ACCESS_DENIED_ADMIN');
      }
      // Prevent a stale `safeRole` (computed from req.body before the
      // transaction) from silently overwriting a concurrent admin role change.
      if (recheck.role !== targetUser.role) {
        throw new Error('ROLE_CHANGED');
      }
      wasInactive = !recheck.is_active;
      _staffUpdateStmt.run(email.substring(0, MAX_EMAIL), first_name.substring(0, MAX_SHORT_STR), last_name.substring(0, MAX_SHORT_STR), safeRole,
        (department || '').substring(0, MAX_SHORT_STR) || null, phone ? phone.substring(0, MAX_PHONE) : null, id);
    });
    updateStaff();

    if (wasInactive) {
      req.flash('info', 'This account is deactivated. Editing will not reactivate it — use the Reactivate button on the show page.');
    }

    req.audit('update', 'user', id, `Updated staff ${first_name} ${last_name}`);
    invalidateDashboardCache();

    // Keep session in sync if user is editing their own record — fetch fresh
    // data from the DB (consistent with the auth.js password-change route) so
    // the session user object is a complete mirror of the current DB row instead
    // of a hand-patched subset that could diverge if new columns are added.
    if (Number(id) === Number(req.session.user.id)) {
      const fresh = _showStaffStmt.get(id);
      if (fresh) {
        req.session.user = fresh;
      }
    }

    req.flash('success', 'Staff member updated');
    return res.redirect(`/staff/${id}`);
  } catch (err) {
    if (err.message === 'NOT_FOUND') {
      req.flash('error', 'Staff member not found');
      return res.redirect('/staff');
    }
    if (err.message === 'ACCESS_DENIED_ADMIN') {
      req.flash('error', 'You cannot modify administrator accounts');
      return res.redirect('/staff');
    }
    if (err.message === 'ROLE_CHANGED') {
      req.flash('error', 'This account\'s role changed since the form was loaded. Please review and try again.');
      return res.redirect(`/staff/${id}/edit`);
    }
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      req.flash('error', 'An account with this email address already exists');
    } else {
      console.error('Staff update error:', err.message);
      req.flash('error', 'Error updating staff. Please try again.');
    }
    return res.redirect(`/staff/${id}/edit`);
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

  let targetUsername = null;
  try {
    // Verify user state and reactivate in a single transaction to avoid a
    // TOCTOU race with concurrent deactivate/reactivate requests — mirrors
    // the deactivate transaction pattern above.
    const reactivate = db.transaction(() => {
      const target = _staffUserStmt.get(id);
      if (!target) {
        return { notFound: true };
      }
      if (target.is_active) {
        return { alreadyActive: true };
      }

      _reactivateStmt.run(id);
      targetUsername = target.username;
      return { ok: true };
    });
    const result = reactivate();

    if (result.notFound) {
      req.flash('error', 'Staff member not found');
      return res.redirect('/staff');
    }
    if (result.alreadyActive) {
      req.flash('info', 'Account is already active');
      return res.redirect(`/staff/${id}`);
    }

    // Clear login failure lockout outside the transaction so in-memory state
    // is not cleared if the DB transaction fails (mirrors auth.js login handler).
    if (targetUsername) {
      clearLoginFailure(targetUsername);
    }
    // Note: IP lockout is attacker-specific; clearing req.ip here would remove
    // the admin's own IP from the failure map, which has no effect on the
    // locked-out user. IP lockouts are only cleared at login success.

    req.audit('reactivate', 'user', id, 'Reactivated user account');
    invalidateDashboardCache();
    req.flash('success', 'Account reactivated successfully');
  } catch (err) {
    console.error('Staff reactivate error:', err.message);
    req.flash('error', 'Error reactivating account');
  }
  return res.redirect(`/staff/${id}`);
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

  // Fail closed on HTTP parameter pollution: reject array payloads on the
  // password fields.
  const hppErrors = rejectHppArrays(req, ['new_password', 'current_password']);
  if (hppErrors.length > 0) {
    req.flash('error', 'Invalid request parameters');
    return res.redirect(`/staff/${id}`);
  }

  const new_password = safeQueryValue(req.body.new_password);
  const current_password = safeQueryValue(req.body.current_password);
  if (!new_password || typeof new_password !== 'string') {
    req.flash('error', 'Password is required');
    return res.redirect(`/staff/${id}`);
  }
  if (Buffer.byteLength(new_password, 'utf8') > MAX_PASSWORD_BYTES) {
    req.flash('error', `Password must be at most ${MAX_PASSWORD_BYTES} bytes`);
    return res.redirect(`/staff/${id}`);
  }

  // Require the admin to confirm their own password before resetting another user's
  if (!current_password || typeof current_password !== 'string' || Buffer.byteLength(current_password, 'utf8') > MAX_PASSWORD_BYTES) {
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
  try {
    const result = _passwordResetStmt.run(hashed, id);
    if (result.changes === 0) {
      console.error('Staff password reset: user not found (possibly deleted concurrently)');
      req.flash('error', 'Staff member not found');
      return res.redirect('/staff');
    }
  } catch (err) {
    console.error('Staff password reset DB error:', err.message);
    req.flash('error', 'Error resetting password. Please try again.');
    return res.redirect(`/staff/${id}`);
  }

  // Clear any login failure lockout for this user so the password reset
  // takes effect immediately instead of waiting for lockout expiry.
  if (targetUser.username) {
    clearLoginFailure(targetUser.username);
  }
  // Note: IP lockout is attacker-specific; clearing req.ip here would remove
  // the admin's own IP from the failure map, which has no effect on the
  // locked-out user. IP lockouts are only cleared at login success.

  req.audit('update', 'user', id, `Password reset by admin${targetUser.username ? ` (cleared login lockout for ${targetUser.username})` : ''}`);
  req.flash('success', 'Password reset successfully');
  return res.redirect(`/staff/${id}`);
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

      // Collect affected project IDs before the unassign so the N+1
      // progress recalculation loop (below) uses the pre-unassign state.
      const affectedProjects = _affectedProjectsStmt.all(id).map(r => r.project_id);

      _unassignTasksStmt.run(id);

      // Unassign change-log entries so they don't orphan on an inactive user
      _unassignChangesStmt.run(id);

      // Unassign projects owned by this user so they don't orphan
      _unassignProjectOwnerStmt.run(id);

      return { ok: true, username: target.username, affectedProjects };
    });
    const result = deactivate();

    if (result.notFound) {
      req.flash('error', 'Staff member not found');
    } else if (result.alreadyInactive) {
      req.flash('info', 'Account is already inactive');
    } else {
      // Recalculate project progress outside the transaction so SQLite's
      // write lock is not held across multiple sequential queries. The
      // project progress was read as of the transaction's snapshot, so
      // the recalc reflects the post-unassign state correctly even though
      // the queries execute after the commit.
      for (const projectId of result.affectedProjects) {
        try {
          recalcProjectProgress(db, projectId);
        } catch (err) {
          console.error(`Progress recalculation error for project #${projectId}:`, err.message);
        }
      }

      // Clear login failure lockout for this user so stale in-memory lockout
      // does not persist after reactivation. Consistent with the reactivate and
      // password-reset routes which also clear login failures.
      if (result.username) {
        clearLoginFailure(result.username);
      }
      // IP lockout is tracked by attacker IP, not user IP, so no IP-level
      // lockout to clear here.

      req.audit('deactivate', 'user', id, `Deactivated user "${result.username}" and unassigned open tickets/tasks/changes/projects`);
      req.flash('success', 'Staff member deactivated and open tickets/tasks/changes unassigned');
      invalidateDashboardCache();
    }
  } catch (err) {
    console.error('Staff deactivate error:', err.message);
    req.flash('error', 'Error deactivating staff');
  }
  return res.redirect('/staff');
});

module.exports = router;
/**
 * Reset module-level cached prepared statements (test use only).
 * Ensures test isolation when using mock db instances — consistent with
 * the same-named export in all other route modules.
 */
function resetCachedStatements() {
  // All cached statements are module-level const bindings from db.prepare(),
  // so there is no lazy-init to null out — the cache is unused when
  // the db mock is swapped. This function exists for API consistency
  // across all route modules.
}
module.exports.resetCachedStatements = resetCachedStatements;
