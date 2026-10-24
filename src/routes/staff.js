const db = require('../models/database');
const { requireAuth, requireAdminOrManager, requireAdmin } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { paginate, paginationBaseUrl, addSearch, buildFilters, safeId, validatePassword, isValidUsername, isValidEmail, trim, sanitizePhone, isValidPhone, recalcProjectProgress, asyncHandler, countQuery, selectQuery, safeQueryValue, safeFilters, isPrivileged, rejectHppArrays, resolveOptionalField, resolveEnumField, findNonStringField, invalidateActiveStaffCache, authKeyGenerator, logError, capList } = require('../utils');
const { USER_ROLES, MAX_USERNAME, MAX_PASSWORD_BYTES, MAX_EMAIL, MAX_SHORT_STR, MAX_PHONE, BCRYPT_SALT_ROUNDS, ASSIGNED_ITEMS_CAP, MEMBER_LIST_CAP } = require('../constants');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { invalidateDashboardCache } = require('./dashboard');
const { clearLoginFailure } = require('./auth');

const router = require('express').Router();
router.use(requireAuth, auditMiddleware);

// Cached prepared statements for show/edit routes (static SQL).
//
// The four sidebar queries below are capped, and each fetches ONE ROW BEYOND
// its cap: the extra row is the truncation probe, so the "(N+)" marker in the
// view is exact (a list holding exactly as many rows as the cap is complete
// and is not marked). The old `length >= cap` heuristic claimed a truncation
// that did not exist.
const _showStaffStmt = db.prepare('SELECT id, username, email, first_name, last_name, role, department, phone, avatar, is_active, last_login, password_changed_at, created_at, updated_at FROM users WHERE id = ?');
const _assignedTicketsStmt = db.prepare(`
    SELECT id, ticket_number, title, status, priority, created_at
    FROM tickets WHERE assigned_to = ?
    ORDER BY CASE status WHEN 'open' THEN 1 WHEN 'in_progress' THEN 2 WHEN 'waiting' THEN 3 ELSE 4 END, created_at DESC, id DESC
    LIMIT ${ASSIGNED_ITEMS_CAP + 1}
  `);
const _assignedTasksStmt = db.prepare(`
    SELECT pt.id, pt.title, pt.due_date, p.name as project_name, p.id as project_id, p.owner_id
    FROM project_tasks pt
    JOIN projects p ON pt.project_id = p.id
    WHERE pt.assigned_to = ? AND pt.status != 'done'
    ORDER BY pt.due_date ASC, pt.id ASC
    LIMIT ${ASSIGNED_ITEMS_CAP + 1}
  `);
// Cap the result set like every sibling sidebar query in this module — a user
// who is a member of many projects must not render an unbounded list.
const _assignedAssetsStmt = db.prepare(`
    SELECT id, asset_tag, name, category, status
    FROM assets WHERE assigned_to = ?
    ORDER BY name ASC, id ASC
    LIMIT ${ASSIGNED_ITEMS_CAP + 1}
  `);
// Cap the result set like every sibling sidebar query in this module — a user
// who is a member of many projects must not render an unbounded list.
const _projectMembershipsStmt = db.prepare(`
    SELECT pm.role as project_role, p.name as project_name, p.id as project_id, p.status as project_status, p.owner_id
    FROM project_members pm
    JOIN projects p ON pm.project_id = p.id
    WHERE pm.user_id = ?
    ORDER BY p.updated_at DESC, p.id DESC
    LIMIT ${MEMBER_LIST_CAP + 1}
  `);
const _staffUserStmt = db.prepare('SELECT id, role, username, is_active, department, phone, email, first_name, last_name FROM users WHERE id = ?');
const _reactivateStmt = db.prepare('UPDATE users SET is_active = 1, updated_at = datetime(\'now\') WHERE id = ? AND is_active = 0');
// Password-reset marker. The value is compared against the copy stored in the
// target user's session (middleware/auth.js) to invalidate sessions issued
// against the old credential. It uses MILLISECOND resolution
// (strftime('%Y-%m-%d %H:%M:%f')) rather than datetime('now')'s one-second
// resolution: with a one-second marker, a reset that landed in the same second
// as the session's marker compared EQUAL, so the old session survived a
// credential change for its full lifetime.
const _passwordResetStmt = db.prepare('UPDATE users SET password = ?, password_changed_at = strftime(\'%Y-%m-%d %H:%M:%f\', \'now\'), updated_at = datetime(\'now\') WHERE id = ?');
const _adminPasswordStmt = db.prepare('SELECT password FROM users WHERE id = ?');
const _deactivateStmt = db.prepare('UPDATE users SET is_active = 0, updated_at = datetime(\'now\') WHERE id = ?');
const _unassignTicketsStmt = db.prepare('UPDATE tickets SET assigned_to = NULL, updated_at = datetime(\'now\') WHERE assigned_to = ? AND status IN (\'open\', \'in_progress\', \'waiting\')');
const _affectedProjectsStmt = db.prepare(
  'SELECT DISTINCT project_id FROM project_tasks WHERE assigned_to = ? AND status != \'done\''
);
const _unassignTasksStmt = db.prepare('UPDATE project_tasks SET assigned_to = NULL, updated_at = datetime(\'now\') WHERE assigned_to = ? AND status != \'done\'');
// Only unassign SCHEDULED / IN_PROGRESS changes so finished records
// (completed/failed/cancelled) keep their assignee for historical attribution
// — the user row is only soft-deleted (is_active=0), so the LEFT JOIN in the
// show page still resolves the name. Mirrors the selective ticket/task unassign.
const _unassignChangesStmt = db.prepare('UPDATE change_log SET assigned_to = NULL, updated_at = datetime(\'now\') WHERE assigned_to = ? AND status NOT IN (\'completed\', \'failed\', \'cancelled\')');
// Only clear ownership of ACTIVE projects (planning/in_progress/on_hold) so
// they can be reassigned; completed/cancelled projects keep their owner for
// history (the deactivated user row persists, so owner_name still resolves).
const _unassignProjectOwnerStmt = db.prepare('UPDATE projects SET owner_id = NULL, updated_at = datetime(\'now\') WHERE owner_id = ? AND status NOT IN (\'completed\', \'cancelled\')');
// Release the deactivated user's PROJECT MEMBERSHIPS on LIVE projects. A
// membership is the one live assignment the deactivate transaction used to
// leave behind: the deactivated employee kept appearing in the project Team
// roster, and — when they were the project's only lead — the "cannot remove
// the last lead" guard then refused to remove them, so the project could not
// be cleaned up without first promoting somebody else. The member-add route
// already refuses to add an INACTIVE user, so keeping the row was
// inconsistent in both directions.
//
// Only LIVE projects are affected: like the ownership unassign above, a
// finished project keeps its historical team (the deactivated user row
// persists, so the name still resolves).
const _releaseProjectMembersStmt = db.prepare(
  "DELETE FROM project_members WHERE user_id = ? AND project_id IN (SELECT id FROM projects WHERE status NOT IN ('completed', 'cancelled'))"
);

// Cached prepared statements for staff create/update routes
const _staffInsertStmt = db.prepare(`
    INSERT INTO users (username, password, email, first_name, last_name, role, department, phone)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
const _staffUpdateStmt = db.prepare('UPDATE users SET email = ?, first_name = ?, last_name = ?, role = ?, department = ?, phone = ?, is_active = is_active, updated_at = datetime(\'now\') WHERE id = ?');

// Cached prepared statement for department list in staff index.
// Include all departments (not just those with active users) so the filter
// dropdown accurately represents all departments in the system.
const _departmentsStmt = db.prepare('SELECT DISTINCT department FROM users WHERE department IS NOT NULL ORDER BY department');

// List staff (paginated)
router.get('/', (req, res) => {
  req.audit('read', 'user', null, 'Viewed staff list');
  // Fail closed on HTTP parameter pollution: reject array payloads on query
  // params. Mirrors the explicit HPP guard on GET /audit and the array-rejection
  // convention used by every write route in the app.
  const hppErrors = rejectHppArrays(req, ['search', 'status', 'role', 'department']);
  if (hppErrors.length > 0) {
    req.flash('error', 'Invalid request parameters');
    return res.redirect('/staff');
  }
  const { page: requestedPage, limit } = paginate(req);

  const viewer = req.session.user;
  const viewerPrivileged = isPrivileged(viewer);

  // Whitelist known departments from DB.
  //
  // PII disclosure control: the directory redacts each row's department for a
  // viewer who is neither privileged nor the row's owner (the template renders
  // "Restricted"). Handing every viewer the full department list — and letting
  // them filter by it — defeated that redaction: the dropdown named every
  // department in the organisation, and `?department=X` returned the headcount
  // of that department. Both are now restricted to privileged viewers, whose
  // rows are not redacted in the first place.
  let departments = [];
  if (viewerPrivileged) {
    try {
      departments = _departmentsStmt.all().map(r => r.department);
    } catch (err) {
      logError('Staff departments query error:', err);
    }
  }
  const qStatus = safeQueryValue(req.query.status);
  const qRole = safeQueryValue(req.query.role);
  const qDept = safeQueryValue(req.query.department);
  const activeFilter = qStatus === 'active' ? 1 : qStatus === 'inactive' ? 0 : '';
  const filters = buildFilters({
    'u.role': { value: USER_ROLES.includes(qRole) ? qRole : '' },
    'u.department': { value: viewerPrivileged && departments.includes(qDept) ? qDept : '' },
    'u.is_active': { value: activeFilter }
  }, ['u.role', 'u.department', 'u.is_active']);

  const where = [...filters.where];
  const params = [...filters.params];
  // PII disclosure control: the email column is redacted for non-privileged
  // viewers further down (rendered as "Restricted"), so matching the search
  // term against u.email for those viewers turns the row COUNT into an
  // email-existence oracle — a staff member could probe whether a given
  // address belongs to an account without ever seeing the address. Restrict
  // the searchable columns for non-privileged viewers to the ones the
  // directory actually renders for them (first_name / last_name).
  //
  // The USERNAME is rendered by neither the directory nor the profile page —
  // only the staff EDIT form shows it, and a manager cannot open the edit
  // form of a manager or admin account (the route refuses it as a privilege
  // boundary crossing). So the username is searchable for an ADMIN (who can
  // reach every edit form) and for nobody else: a manager who could search
  // it could confirm the existence of a privileged account's LOGIN NAME
  // without being able to read it anywhere in the app.
  //
  // The Name column renders the two name columns as ONE string ("<first>
  // <last>"), so the search matches that CONCATENATION rather than the halves
  // separately — otherwise the name the user could read was unfindable
  // ("John Smith" matched nothing while "John" and "Smith" each did). Both
  // halves were already searchable for every viewer tier, so the
  // concatenation exposes nothing the viewer cannot already read.
  const searchColumns = req.session.user.role === 'admin'
    ? [{ concat: ['u.first_name', 'u.last_name'] }, 'u.email', 'u.username']
    : (viewerPrivileged
      ? [{ concat: ['u.first_name', 'u.last_name'] }, 'u.email']
      : [{ concat: ['u.first_name', 'u.last_name'] }]);
  addSearch(where, params, safeQueryValue(req.query.search), searchColumns);

  const whereClause = where.length ? where.join(' AND ') : '1=1';

  const total = countQuery(db, 'users', 'u', whereClause, params);
  const totalPages = Math.ceil(total / limit) || 1;
  // Clamp the requested page to the actual page count so a page beyond the
  // last one (e.g. ?page=999) renders the final page instead of an empty list
  // with a broken "Showing N–M" range (M < N) in the pagination partial.
  const page = Math.min(requestedPage, totalPages);
  const offset = (page - 1) * limit;

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
      -- status != 'done' (not an explicit status list) so tasks in the
      -- non-terminal 'review' state count as open here — matching the show
      -- route's Active Tasks sidebar and the unassign-recalc queries in this
      -- module. Previously a task moved to review vanished from this count.
      SELECT assigned_to, COUNT(*) as open_tasks
      FROM project_tasks WHERE status != 'done'
      GROUP BY assigned_to
    ) ptCounts ON ptCounts.assigned_to = u.id
    WHERE ${whereClause}
    ORDER BY u.first_name ASC, u.id ASC
    LIMIT ? OFFSET ?
  `, [...params, limit, offset]);

  // PII disclosure control: mirror the protection on the GET /:id show route.
  // Non-privileged users (regular staff) must not be able to harvest other
  // employees' email/phone via the directory listing. Only privileged users
  // (admin/manager) and the user themselves receive those fields; everyone
  // else gets them zeroed out before rendering. last_login and avatar are
  // zeroed too — the email/phone/department redaction only controls what the
  // index template renders today, so any future template change reviving a
  // column would leak the data. Use a shallow copy per row to avoid mutating
  // the DB query result objects in-place — a mutated row object could leak
  // through a cache or middleware.
  //
  // The username is zeroed for EVERY row, including the privileged viewer's
  // own: it is the login identifier (half of the credential pair) and the
  // directory does not render it at all, so keeping it in the render context
  // only risks a future template change disclosing it. The README documents
  // that a manager cannot open the edit form of a manager or admin account —
  // so a manager's directory render context must not carry the login
  // identifier of an account the manager cannot read anywhere else. The
  // privileged branch used to keep it, which contradicted the comment it
  // sat under.
  const renderedStaff = staff.map(s => {
    const base = (viewerPrivileged || Number(s.id) === Number(viewer.id))
      ? { ...s }
      : { ...s, email: null, phone: null, department: null, last_login: null, avatar: null };
    return { ...base, username: null };
  });

  res.render('pages/staff/index', {
    title: 'Staff', staff: renderedStaff, departments,
    filters: safeFilters(req.query, ['search', 'status', 'role', 'department']),
    page, limit, totalPages, total,
    baseUrl: paginationBaseUrl(req)
  });
});

// New staff form
router.get('/new', requireAdminOrManager, (req, res) => {
  res.render('pages/staff/form', { title: 'New Staff Member', staffMember: {}, isEdit: false, viewerRole: req.session.user.role });
});

// Rate limit staff creation to prevent account-mass-creation attacks.
// Per-account keyed so one admin's bulk work cannot silence another admin.
const createStaffLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  keyGenerator: authKeyGenerator,
  message: 'Too many staff creation attempts. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});

const staffWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  keyGenerator: authKeyGenerator,
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
  const department = trim(safeQueryValue(req.body.department));
  // Fail closed on a present-but-blank department (whitespace only). A
  // whitespace-only value is neither an ABSENT field ("no department") nor
  // an intentional empty string, so it is an invalid value — the app-wide
  // rule the matching UPDATE route already enforces ("Please enter a valid
  // department") and the sibling phone field in this same handler enforces
  // on BOTH verbs. The create route used to trim it to '' and store NULL
  // with a success flash, so the identical submission was accepted on create
  // and refused on update.
  if (typeof req.body.department === 'string' && req.body.department !== '' && req.body.department.trim() === '') {
    req.flash('error', 'Please enter a valid department');
    return res.redirect('/staff/new');
  }
  // The REQUIRED columns are guarded too: without it a JSON number in
  // `username`, `email`, `first_name` or `last_name` collapsed to '' and was
  // reported as a MISSING field ("All required fields must be filled in"),
  // while the matching update route reported the identical submission as
  // "Invalid request parameters" — a type error masquerading as an absent
  // one. The password is guarded for the same reason: the truthiness test
  // below ("All required fields must be filled in") ran BEFORE the type test,
  // so a FALSY non-string password (0, false) was reported as a missing
  // field while a truthy one (12345) was reported as "Invalid Password" —
  // the same type error, two verdicts, and neither matched the app-wide
  // wording the reset-password route in this very module already uses.
  //
  // `role` is guarded as well: it is an enum, and a non-string role used to
  // be reported as an invalid VALUE ("Invalid Role") because
  // resolveEnumField() classifies a non-string as 'invalid'. Every other enum
  // in the app answers a wrong-typed submission with the app-wide type-error
  // wording (the project member's role, a change's status/priority, a ticket's
  // category/priority/status, an article's status), so staff.js was the lone
  // module where a wrong-typed enum was indistinguishable from an unknown
  // value. "Invalid Role" now means what it says: an unknown role VALUE.
  //
  // `department` is guarded here too, for the same reason: a wrong TYPE is
  // reported with the app-wide wording, while the field-specific wording
  // ("Please enter a valid department") is reserved for the whitespace-only
  // VALUE above. It used to answer "Invalid Department" for the type error,
  // which the README's partial-update contract does not allow.
  const wrongTypeField = findNonStringField(req.body, ['username', 'password', 'email', 'first_name', 'last_name', 'role', 'department']);
  if (wrongTypeField) {
    req.flash('error', 'Invalid request parameters');
    return res.redirect('/staff/new');
  }
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
    req.flash('error', 'Invalid Password');
    return res.redirect('/staff/new');
  }
  if (!isValidUsername(username)) {
    req.flash('error', 'Username must be 2-50 characters and contain only letters, numbers, dots, dashes, and underscores');
    return res.redirect('/staff/new');
  }
  // The length check runs BEFORE isValidEmail(): isValidEmail already caps the
  // length at MAX_EMAIL, so an over-long address failed the format check and
  // the user was told "Please enter a valid email address" — a message the
  // dedicated length check below could never produce, so it was dead code.
  // The UPDATE route in this module already checks the length first; the
  // CREATE route now reports the same condition the same way.
  if (email.length > MAX_EMAIL) {
    req.flash('error', `Email must be at most ${MAX_EMAIL} characters`);
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
  if (department && department.length > MAX_SHORT_STR) {
    req.flash('error', `Department must be at most ${MAX_SHORT_STR} characters`);
    return res.redirect('/staff/new');
  }
  const pwError = validatePassword(password);
  if (pwError) {
    req.flash('error', pwError);
    return res.redirect('/staff/new');
  }
  // Enum resolution — the role column is `NOT NULL DEFAULT 'staff'`, so an
  // ABSENT role takes the schema's documented default (exactly like every
  // other entity's create route: a project without a status is 'planning',
  // a ticket without a priority is 'medium', a project member without a role
  // is 'member'). The route used to REQUIRE the role instead, so an API
  // client that submitted only the required fields was refused with "Invalid
  // Role" while every sibling entity accepted the same omission. The route's
  // own required-field check never listed the role — it reads "All required
  // fields must be filled in" for username/password/email/first/last name —
  // so the field was never actually required, only accidentally so.
  //
  // The presence test runs against the RAW submitted value, so a
  // present-but-blank/empty/unknown role is rejected rather than silently
  // defaulting. The column is NOT NULL, so an empty value has no valid
  // meaning either.
  const createRoleEnum = resolveEnumField(req.body.role, USER_ROLES);
  if (createRoleEnum.state === 'blank' || createRoleEnum.state === 'invalid' || createRoleEnum.state === 'empty') {
    req.flash('error', 'Invalid Role');
    return res.redirect('/staff/new');
  }
  const role = createRoleEnum.state === 'valid' ? createRoleEnum.value : 'staff';
  // Only admins can create privileged accounts (manager/admin). Managers must
  // not be able to escalate privileges by creating new manager accounts.
  if (role !== 'staff' && req.session.user.role !== 'admin') {
    // Non-enumerating wording: a distinct "Only administrators can create
    // manager or admin accounts." message would confirm that the role column
    // is what it is, revealing that a privileged account was targeted. Every
    // other refusal in the app (the show and edit routes below, the sibling
    // denial branches in tickets/assets/projects/changes/knowledge) answers
    // the denial exactly like a missing record.
    req.audit('access_denied', 'user', null, `Unauthorized privileged account creation attempt (role: ${role})`);
    req.flash('error', 'Staff member not found');
    return res.redirect('/staff');
  }

  try {
    const hashedPassword = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
    const result = _staffInsertStmt.run(
      username.substring(0, MAX_USERNAME),
      hashedPassword,
      email.substring(0, MAX_EMAIL),
      first_name.substring(0, MAX_SHORT_STR),
      last_name.substring(0, MAX_SHORT_STR),
      role,
      // The `department` column carries the schema default 'IT'. The insert
      // statement always writes the column explicitly, so the default could
      // never fire: a staff member created without a department landed in
      // NULL, rendered as "-" in the directory and matched by NO department
      // filter (the filter query excludes NULL departments). An absent
      // (or empty) department now takes the documented default, exactly like
      // every other entity's absent create field.
      (department || 'IT').substring(0, MAX_SHORT_STR),
      phone ? phone.substring(0, MAX_PHONE) : null
    );

    req.audit('create', 'user', result.lastInsertRowid, `Created user ${username}`);
    req.flash('success', `Staff member ${first_name} ${last_name} created.`);
    invalidateActiveStaffCache();
    invalidateDashboardCache();
    return res.redirect('/staff');
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      req.flash('error', 'An account with this username or email address already exists');
    } else {
      logError('Staff create error:', err);
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

  // Fetch first so a non-existent id reports NOT_FOUND (not ACCESS_DENIED):
  // the access gate below would otherwise audit an enumeration probe against
  // an id that does not exist as an access denial, mirroring the fetch-first
  // convention in tickets/assets/projects show routes.
  const staffUser = _showStaffStmt.get(id);
  if (!staffUser) {
    req.flash('error', 'Staff member not found');
    return res.redirect('/staff');
  }

  // PII disclosure control: only privileged users (admin/manager) or the user
  // themselves may view a staff profile. A regular staff member enumerating
  // IDs must not be able to read other employees' email/phone/department.
  const isSelf = Number(id) === Number(req.session.user.id);
  if (!isPrivileged(req.session.user) && !isSelf) {
    // Audit the denial like every other entity show route — an ID-enumeration
    // attempt against staff PII is exactly the probing the audit log exists
    // to surface (mirrors tickets/assets/projects/changes/knowledge).
    req.audit('access_denied', 'user', id, 'Unauthorized staff profile view attempt');
    // Use the same non-enumerating wording as the 'not found' branch above: a
    // distinct "you do not have permission" message reveals that the account
    // ID exists even though the viewer was refused the profile. Mirrors the
    // changes/knowledge show routes, which answer both branches identically.
    req.flash('error', 'Staff member not found');
    return res.redirect('/staff');
  }

  req.audit('read', 'user', id, `Viewed staff profile: ${staffUser.first_name} ${staffUser.last_name}`);

  const assignedTicketsCap = capList(_assignedTicketsStmt.all(id), ASSIGNED_ITEMS_CAP);
  const assignedTickets = assignedTicketsCap.rows;

  const assignedTasksCap = capList(_assignedTasksStmt.all(id), ASSIGNED_ITEMS_CAP);
  const assignedTasks = assignedTasksCap.rows;

  const assignedAssetsCap = capList(_assignedAssetsStmt.all(id), ASSIGNED_ITEMS_CAP);
  const assignedAssets = assignedAssetsCap.rows;

  const projectMembershipsCap = capList(_projectMembershipsStmt.all(id), MEMBER_LIST_CAP);
  const projectMemberships = projectMembershipsCap.rows;

  res.render('pages/staff/show', {
    title: `${staffUser.first_name} ${staffUser.last_name}`,
    staffUser,
    assignedTickets, assignedTasks, assignedAssets, projectMemberships,
    // Exact truncation flags for the four capped sidebar lists (computed from
    // the one-row-beyond-the-cap probe the queries fetch).
    assignedTicketsTruncated: assignedTicketsCap.truncated,
    assignedTasksTruncated: assignedTasksCap.truncated,
    assignedAssetsTruncated: assignedAssetsCap.truncated,
    projectMembershipsTruncated: projectMembershipsCap.truncated
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
    // Audit the denial like the sibling knowledge edit route — a manager
    // probing the admin/manager edit form is a privilege boundary crossing.
    req.audit('access_denied', 'user', id, 'Unauthorized staff edit attempt');
    // Use the same non-enumerating wording as the 'not found' branch above: a
    // distinct "you cannot modify…" message reveals that the account ID exists
    // even though the viewer was refused the record. Mirrors the
    // changes/knowledge show routes, which answer both branches identically.
    req.flash('error', 'Staff member not found');
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
  // Raw body values (NOT trimmed) so an ABSENT field can be told apart from
  // an explicit empty one. The three required columns are absent-preserving
  // (resolved inside the transaction from the re-read row), so the raw values
  // are needed for the presence test. Mirrors the raw-vs-processed split in
  // assets.js and vendors.js.
  const rawEmail = req.body.email;
  const rawFirstName = req.body.first_name;
  const rawLastName = req.body.last_name;
  const rawDepartment = req.body.department;
  const department = trim(safeQueryValue(rawDepartment));
  // Fail closed on a present-but-blank department (whitespace only). The
  // raw value is kept so an ABSENT field (partial submission — preserve the
  // stored value) and an EXPLICIT empty string (clear the field) stay
  // distinguishable. A whitespace-only value is neither: it trimmed to an
  // empty string, so resolveOptionalField treated it as an explicit clear and
  // silently wiped the stored department while the route flashed "success".
  // The sibling phone field in this same handler already rejects a
  // present-but-blank value; department now behaves the same way.
  if (typeof rawDepartment === 'string' && rawDepartment !== '' && rawDepartment.trim() === '') {
    req.flash('error', 'Please enter a valid department');
    return res.redirect(`/staff/${id}/edit`);
  }
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
  // Absent-vs-present markers for the three required columns. An ABSENT field
  // in a partial API submission preserves the stored value (resolved inside the
  // transaction from the re-read row) — the same contract the optional fields
  // on this route (department, phone, role) already follow. The email, first
  // name and last name were the sole exception: a partial PUT that only
  // changed the department was rejected outright with "Email, first name, and
  // last name are required" even though the stored values were perfectly
  // valid. A PRESENT but empty value is still rejected — all three columns are
  // NOT NULL and an empty value has no valid meaning.
  const emailAbsent = rawEmail === undefined || rawEmail === null;
  const firstNameAbsent = rawFirstName === undefined || rawFirstName === null;
  const lastNameAbsent = rawLastName === undefined || rawLastName === null;
  // Fail closed on present-but-non-string values (e.g. a JSON number): trim()
  // coerces them to '', which would turn a valid partial update into a
  // spurious "required" error.
  //
  // `role` is guarded as well: it is an enum, and a non-string role used to
  // be reported as an invalid VALUE ("Invalid Role") because
  // resolveEnumField() classifies a non-string as 'invalid'. Every other enum
  // in the app answers a wrong-typed submission with the app-wide type-error
  // wording (the project member's role, a change's status/priority, a ticket's
  // category/priority/status, an article's status), so staff.js was the lone
  // module where a wrong-typed enum was indistinguishable from an unknown
  // value. "Invalid Role" now means what it says: an unknown role VALUE.
  //
  // `department` joins the guard so the wrong-typed value is reported with the
  // app-wide wording on both verbs (it used to answer "Invalid Department"
  // here and on the create route). The field-specific wording ("Please enter a
  // valid department") is reserved for the whitespace-only VALUE, which is
  // rejected by the dedicated check above.
  const wrongTypeField = findNonStringField(req.body, ['email', 'first_name', 'last_name', 'role', 'department']);
  if (wrongTypeField) {
    req.flash('error', 'Invalid request parameters');
    return res.redirect(`/staff/${id}/edit`);
  }
  if ((!emailAbsent && !email) || (!firstNameAbsent && !first_name) || (!lastNameAbsent && !last_name)) {
    req.flash('error', 'Email, first name, and last name are required');
    return res.redirect(`/staff/${id}/edit`);
  }
  if (!emailAbsent && email.length > MAX_EMAIL) {
    req.flash('error', `Email must be at most ${MAX_EMAIL} characters`);
    return res.redirect(`/staff/${id}/edit`);
  }
  if (!emailAbsent && !isValidEmail(email)) {
    req.flash('error', 'Please enter a valid email address');
    return res.redirect(`/staff/${id}/edit`);
  }
  if (!firstNameAbsent && first_name.length > MAX_SHORT_STR) {
    req.flash('error', `First name must be at most ${MAX_SHORT_STR} characters`);
    return res.redirect(`/staff/${id}/edit`);
  }
  if (!lastNameAbsent && last_name.length > MAX_SHORT_STR) {
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
  // Absent-vs-present marker for the role. An ABSENT role in a partial API
  // submission preserves the stored role — the same convention the optional
  // fields on this route (department, phone) already follow, resolved inside
  // the transaction against the re-read row. Previously an absent role
  // collapsed to '' via trim(), failed the USER_ROLES check and rejected the
  // whole request with "Invalid Role", so a partial update that only wanted
  // to change the department was refused outright. A PRESENT but empty or
  // unknown role is still rejected — the column is NOT NULL and only the
  // three canonical roles are valid.
  const roleAbsent = req.body.role === undefined || req.body.role === null;
  const safeRole = roleAbsent ? '' : trim(safeQueryValue(req.body.role));
  if (!roleAbsent && !USER_ROLES.includes(safeRole)) {
    req.flash('error', 'Invalid Role');
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

  // The EFFECTIVE role: the submitted value when present, otherwise the
  // stored role. Every guard below evaluates the effective role, so a
  // partial submission that omits the role is judged by the role the account
  // actually has (and is not mistaken for an attempt to assign a privileged
  // role). The stored value is re-read inside the transaction below, so a
  // concurrent role change is still caught.
  const effectiveRole = roleAbsent ? targetUser.role : safeRole;

  // Only admins can assign privileged roles (manager/admin). A manager must
  // not be able to escalate a staff user to manager (or another admin), which
  // would grant near-admin capabilities. Managers are limited to editing
  // staff-role users.
  //
  // The guard is evaluated against the EFFECTIVE role, so a partial
  // submission that omits the role is judged by the role the account
  // actually has. The audit entry names WHICH attempt it was: a request that
  // carried a role is a role-assignment attempt, while a request that carried
  // NO role at all is an attempt to modify a privileged account. Recording
  // the latter as a privilege-escalation attempt put a fabricated escalation
  // in the audit log for an actor who made none, and the real event was never
  // recorded with its own message.
  if (effectiveRole !== 'staff' && req.session.user.role !== 'admin') {
    if (roleAbsent) {
      req.audit('access_denied', 'user', id, 'Unauthorized administrator or manager account modification attempt');
    } else {
      req.audit('access_denied', 'user', id, `Unauthorized privileged role assignment attempt (role: ${effectiveRole})`);
    }
    // Use the same non-enumerating wording as the 'not found' branch above so
    // a manager probing IDs cannot distinguish an existing privileged account
    // from a missing one. The audit entries above preserve the trail without
    // leaking existence.
    req.flash('error', 'Staff member not found');
    return res.redirect('/staff');
  }
  // Prevent admin from changing their own role (would lock themselves out).
  // Audit the denial so the attempt leaves a trail — mirrors the access_denied
  // audits on the privileged-role guard above and the admin-protection guard
  // below. Self-role changes are benign but must not silently disappear from
  // the audit log.
  if (Number(id) === Number(req.session.user.id) && effectiveRole !== req.session.user.role) {
    req.audit('access_denied', 'user', id, 'Unauthorized self-role-change attempt');
    // Use the same non-enumerating wording as the 'not found' branch above so
    // the refusal does not confirm the account's existence or its role.
    req.flash('error', 'Staff member not found');
    return res.redirect('/staff');
  }
  // Managers cannot edit or deactivate admin accounts, nor other managers
  // (only admins may manage manager accounts).
  if (req.session.user.role !== 'admin' && targetUser.role !== 'staff') {
    req.audit('access_denied', 'user', id, 'Unauthorized administrator or manager account modification attempt');
    // Use the same non-enumerating wording as the 'not found' branch above so
    // a manager probing IDs cannot distinguish an existing privileged account
    // from a missing one.
    req.flash('error', 'Staff member not found');
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
  // resolvedStaffName is hoisted out of the transaction so the audit entry
  // names the EFFECTIVE (resolved) staff member even when the request
  // omitted the name fields.
  let wasInactive = false;
  let resolvedStaffName = `${first_name} ${last_name}`;
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
      // Resolve the optional fields against the transaction-consistent row so a
      // partial submission that omits them preserves the stored values instead
      // of wiping them to NULL — the absent-vs-empty convention applied by every
      // other route's update handlers. An explicit empty string in the edit form
      // still CLEARS the field (null). Present non-string values were already
      // rejected above (fail closed), so the error sentinels below are defensive.
      // Raw body values (NOT trimmed) are needed to distinguish an ABSENT optional
      // text field (partial submission — preserve stored value) from an explicit
      // empty string (clear the field). trim() collapses undefined to '', so the raw
      // values are captured here for the resolveOptionalField resolution inside the
      // transaction. Mirrors the raw-vs-processed split in assets.js and vendors.js.
      const rawDept = rawDepartment;
      // No error sentinel is needed for it: resolveOptionalField's three
      // error classes are all rejected before the transaction — an array by
      // the HPP guard, a non-string by the findNonStringField guard, and a
      // whitespace-only value by the dedicated department check above. The
      // sentinel was unreachable, and its message ("Invalid Department")
      // contradicted the one the route actually reports for a whitespace-only
      // department ("Please enter a valid department").
      const resolvedDepartment = resolveOptionalField(rawDept, department || null, MAX_SHORT_STR, recheck.department);
      const rawStaffPhone = req.body.phone;
      const resolvedPhone = resolveOptionalField(rawStaffPhone, phone || null, MAX_PHONE, recheck.phone);
      if (resolvedPhone && resolvedPhone.error) {
        throw new Error('INVALID_PHONE');
      }
      wasInactive = !recheck.is_active;
      // The role follows the same absent-vs-present rule as the optional text
      // fields: an absent role preserves the CURRENT stored role (read inside
      // the transaction, so a concurrent role change is not clobbered), a
      // present role replaces it.
      const resolvedRole = roleAbsent ? recheck.role : safeRole;
      // The three required columns follow the same rule: an absent field
      // preserves the CURRENT stored value (read inside the transaction, so a
      // concurrent edit cannot be clobbered), a present field replaces it. A
      // present-but-empty value was already rejected above.
      const resolvedEmail = emailAbsent ? recheck.email : email.substring(0, MAX_EMAIL);
      const resolvedFirstName = firstNameAbsent ? recheck.first_name : first_name.substring(0, MAX_SHORT_STR);
      const resolvedLastName = lastNameAbsent ? recheck.last_name : last_name.substring(0, MAX_SHORT_STR);
      resolvedStaffName = `${resolvedFirstName} ${resolvedLastName}`;
      const updateResult = _staffUpdateStmt.run(
        resolvedEmail,
        resolvedFirstName,
        resolvedLastName,
        resolvedRole,
        resolvedDepartment,
        resolvedPhone,
        id
      );
      // Belt-and-braces NOT_FOUND guard mirroring the tickets/assets/projects/
      // licenses/changes update transactions: the recheck above guarantees the
      // row exists at this point, but checking the affected-row count keeps the
      // convention uniform across every update route (and catches any future
      // statement edit that drops the WHERE id term).
      if (updateResult.changes === 0) {
        throw new Error('NOT_FOUND');
      }
    });
    updateStaff();

    if (wasInactive) {
      req.flash('info', 'This account is deactivated. Editing will not reactivate it — use the Reactivate button on the show page.');
    }

    req.audit('update', 'user', id, `Updated staff ${resolvedStaffName}`);
    invalidateActiveStaffCache();
    invalidateDashboardCache();

    // Keep session in sync if user is editing their own record — fetch fresh
    // data from the DB (consistent with the auth.js password-change route) so
    // the session user object is a complete mirror of the current DB row instead
    // of a hand-patched subset that could diverge if new columns are added.
    // The SELECT never includes the password column; the destructure below is
    // defensive belt-and-braces so credential material can never enter the
    // session even if a future column-list edit adds it back.
    if (Number(id) === Number(req.session.user.id)) {
      const fresh = _showStaffStmt.get(id);
      if (fresh) {
        const { password: _pw, ...sessionUser } = fresh;
        req.session.user = sessionUser;
      }
    }

    req.flash('success', 'Staff member updated.');
    return res.redirect(`/staff/${id}`);
  } catch (err) {
    if (err.message === 'NOT_FOUND') {
      req.flash('error', 'Staff member not found');
      return res.redirect('/staff');
    }
    if (err.message === 'ACCESS_DENIED_ADMIN') {
      // Same condition as the outer check (non-admin editing a manager/admin
      // account) — keep the message identical so the race path does not
      // misdescribe which guard fired, and non-enumerating so a manager
      // probing IDs cannot confirm a privileged account's existence.
      req.audit('access_denied', 'user', id, 'Unauthorized administrator or manager account modification attempt');
      req.flash('error', 'Staff member not found');
      return res.redirect('/staff');
    }
    if (err.message === 'ROLE_CHANGED') {
      req.flash('error', 'This account\'s role changed since the form was loaded. Please review and try again.');
      return res.redirect(`/staff/${id}/edit`);
    }
    // Map the resolveOptionalField sentinels (defensive — the outer guards
    // already reject present non-string values) to a specific validation
    // message instead of the generic server-error flash, matching the INVALID_
    // mapping in vendors.js / licenses.js.
    if (err.message === 'INVALID_PHONE') {
      req.flash('error', 'Please enter a valid phone number');
      return res.redirect(`/staff/${id}/edit`);
    }
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      req.flash('error', 'An account with this email address already exists');
    } else {
      logError('Staff update error:', err);
      req.flash('error', 'Error updating staff member. Please try again.');
    }
    return res.redirect(`/staff/${id}/edit`);
  }
});

// Reactivate staff (dedicated route — no hidden-field tampering risk)
const reactivateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: authKeyGenerator,
  message: 'Too many reactivation attempts. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});

router.put('/:id/reactivate', requireAdmin, reactivateLimiter, (req, res) => {
  // Fail closed on HTTP parameter pollution: reject array payloads. Mirrors the
  // array-rejection guards on every other write route in the app.
  const hppErrors = rejectHppArrays(req, ['id']);
  if (hppErrors.length > 0) {
    req.flash('error', 'Invalid request parameters');
    return res.redirect('/staff');
  }

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

      const reactivateResult = _reactivateStmt.run(id);
      // Belt-and-braces: the recheck above guarantees the row is inactive, but
      // keep the changes === 0 convention uniform across every mutation route.
      if (reactivateResult.changes === 0) {
        return { notFound: true };
      }
      targetUsername = target.username;
      return { ok: true };
    });
    const result = reactivate();

    if (result.notFound) {
      req.flash('error', 'Staff member not found');
      return res.redirect('/staff');
    }
    if (result.alreadyActive) {
      req.flash('info', 'Staff member is already active.');
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
    invalidateActiveStaffCache();
    invalidateDashboardCache();
    req.flash('success', 'Account reactivated successfully.');
  } catch (err) {
    logError('Staff reactivate error:', err);
    req.flash('error', 'Error reactivating account.');
  }
  return res.redirect(`/staff/${id}`);
});

// Rate limit admin password resets to prevent bcrypt DoS
const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: authKeyGenerator,
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
    req.flash('error', 'You cannot reset your own password via this route.');
    return res.redirect(`/staff/${id}`);
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
  // Fail closed on a present-but-non-string password (e.g. a JSON number):
  // it is a type error, not a missing field, so it is reported with the
  // app-wide "Invalid request parameters" instead of the "Password is
  // required" wording that a genuinely absent field gets. Every other
  // required-text write route in the app already reports a wrong-typed value
  // this way.
  if (req.body.new_password !== undefined && req.body.new_password !== null && req.body.new_password !== '' && typeof req.body.new_password !== 'string') {
    req.flash('error', 'Invalid request parameters');
    return res.redirect(`/staff/${id}`);
  }
  if (req.body.current_password !== undefined && req.body.current_password !== null && req.body.current_password !== '' && typeof req.body.current_password !== 'string') {
    req.flash('error', 'Invalid request parameters');
    return res.redirect(`/staff/${id}`);
  }
  if (!new_password) {
    req.flash('error', 'Password is required');
    return res.redirect(`/staff/${id}`);
  }
  if (Buffer.byteLength(new_password, 'utf8') > MAX_PASSWORD_BYTES) {
    req.flash('error', `Password must be at most ${MAX_PASSWORD_BYTES} bytes`);
    return res.redirect(`/staff/${id}`);
  }

  // Require the admin to confirm their own password before resetting another user's
  if (!current_password || typeof current_password !== 'string' || Buffer.byteLength(current_password, 'utf8') > MAX_PASSWORD_BYTES) {
    req.flash('error', 'Your current password is required to reset another user\'s password.');
    return res.redirect(`/staff/${id}`);
  }
  const adminUser = _adminPasswordStmt.get(req.session.user.id);
  // Short-circuit when the admin row is missing so bcrypt.compare is never
  // invoked with a zero-length hash (which would leak timing information about
  // whether the admin row exists). Mirrors the early-return pattern used in
  // the profile password-change route in auth.js.
  if (!adminUser) {
    req.flash('error', 'Your current password is incorrect.');
    return res.redirect(`/staff/${id}`);
  }
  let passwordMatch;
  try {
    passwordMatch = await bcrypt.compare(current_password, adminUser.password);
  } catch (err) {
    logError('bcrypt.compare error during staff password reset:', err);
    req.flash('error', 'An error occurred. Please try again.');
    return res.redirect(`/staff/${id}`);
  }
  if (!passwordMatch) {
    req.flash('error', 'Your current password is incorrect.');
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

  try {
    const hashed = await bcrypt.hash(new_password, BCRYPT_SALT_ROUNDS);
    const result = _passwordResetStmt.run(hashed, id);
    if (result.changes === 0) {
      logError('Staff password reset: user not found (possibly deleted concurrently)');
      req.flash('error', 'Staff member not found');
      return res.redirect('/staff');
    }
  } catch (err) {
    logError('Staff password reset DB error:', err);
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
  invalidateDashboardCache();
  req.flash('success', 'Password reset successfully.');
  return res.redirect(`/staff/${id}`);
}));

// Rate limit staff deactivation (bcrypt DoS, account lockout bypass)
const deactivateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  keyGenerator: authKeyGenerator,
  message: 'Too many deactivation attempts. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});

// Delete staff (soft delete — deactivate)
router.delete('/:id', requireAdmin, deactivateLimiter, (req, res) => {
  // Fail closed on HTTP parameter pollution: reject array payloads. Mirrors the
  // array-rejection guards on every other write route in the app.
  const hppErrors = rejectHppArrays(req, ['id']);
  if (hppErrors.length > 0) {
    req.flash('error', 'Invalid request parameters');
    return res.redirect('/staff');
  }

  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid staff ID');
    return res.redirect('/staff');
  }

  // Prevent admin from deactivating themselves
  if (Number(id) === Number(req.session.user.id)) {
    req.flash('error', 'You cannot deactivate your own account.');
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

      const deactivateResult = _deactivateStmt.run(id);
      // Belt-and-braces: the recheck above guarantees the row is active, but
      // keep the changes === 0 convention uniform across every mutation route
      // (and avoid unassigning dependent records / auditing a no-op).
      if (deactivateResult.changes === 0) {
        return { notFound: true };
      }

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

      // Release the user's project memberships for the same reason every
      // other live assignment above is released: a deactivated employee must
      // not keep a seat on a project team (and must not hold the "last lead"
      // slot that blocks the project's cleanup).
      _releaseProjectMembersStmt.run(id);

      return { ok: true, username: target.username, affectedProjects };
    });
    const result = deactivate();

    if (result.notFound) {
      req.flash('error', 'Staff member not found');
    } else if (result.alreadyInactive) {
      req.flash('info', 'Staff member is already inactive.');
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
          logError(`Progress recalculation error for project #${projectId}:`, err);
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

      req.audit('deactivate', 'user', id, `Deactivated user "${result.username}" and unassigned open tickets/tasks/changes/projects and project memberships`);
      // The audit trail already names projects; the user-facing flash must
      // match the actual effect — deactivating a user also clears the
      // ownership of in-progress projects (the unassign statement above) and
      // releases their project memberships.
      req.flash('success', 'Staff member deactivated and open tickets/tasks/changes/projects and project memberships unassigned.');
      invalidateActiveStaffCache();
      invalidateDashboardCache();
    }
  } catch (err) {
    logError('Staff deactivate error:', err);
    req.flash('error', 'Error deactivating staff.');
  }
  return res.redirect('/staff');
});

module.exports = router;
module.exports.resetCachedStatements = () => {};
