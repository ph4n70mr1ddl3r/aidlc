const db = require('../models/database');
const { requireAuth, requireAdminOrManager, canAccessResource } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { paginate, paginationBaseUrl, addSearch, buildFilters, safeId, isPresentInvalidId, resolveMoneyAmount, trim, safeDate, getActiveStaff, isActiveUser, ensureAssigneeInList, recalcProjectProgress, countQuery, selectQuery, safeQueryValue, safeFilters, safeSort, rejectHppArrays, resolveOptionalField, resolveEnumField, findBlankTextField, findNonStringField, titleCase, authKeyGenerator, logError, capList, isPrivileged } = require('../utils');
const {
  PROJECT_STATUSES: VALID_STATUSES,
  PROJECT_PRIORITIES: VALID_PRIORITIES,
  TASK_STATUSES: VALID_TASK_STATUSES,
  TASK_PRIORITIES: VALID_TASK_PRIORITIES,
  MEMBER_ROLES: VALID_MEMBER_ROLES,
  MAX_MEDIUM_STR, MAX_DESC,
  MAX_MONEY_AMOUNT,
  DESC_TRUNCATION_LEN,
  TASK_LIST_CAP, MEMBER_LIST_CAP
} = require('../constants');
const { invalidateDashboardCache } = require('./dashboard');

const rateLimit = require('express-rate-limit');

const projectWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  keyGenerator: authKeyGenerator,
  message: 'Too many project operations. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});

const router = require('express').Router();
router.use(requireAuth, auditMiddleware);

// Cached prepared statements for show/edit routes (static SQL).
const _showProjectStmt = db.prepare(`
    SELECT p.id, p.name, p.description, p.status, p.priority, p.start_date, p.end_date,
      p.budget, p.spent, p.progress, p.owner_id, p.created_at, p.updated_at,
      u.first_name || ' ' || u.last_name as owner_name
    FROM projects p
    LEFT JOIN users u ON p.owner_id = u.id
    WHERE p.id = ?
  `);
// Cap the task list on the show page to bound memory/render cost on large
// projects — every other list/sidebar query in the app is capped (e.g.
// tickets _assignedTicketsStmt LIMIT 10, assets _assetDropdownLimit).
// The query fetches ONE ROW BEYOND the cap: the extra row is the truncation
// probe, so the "(N+)" marker in the view is exact (a list holding exactly
// as many rows as the cap is complete and is not marked).
const _showTasksStmt = db.prepare(`
    SELECT pt.id, pt.title, pt.status, pt.priority, pt.due_date,
      u.first_name || ' ' || u.last_name as assigned_name
    FROM project_tasks pt
    LEFT JOIN users u ON pt.assigned_to = u.id
    WHERE pt.project_id = ?
    ORDER BY CASE pt.status WHEN 'in_progress' THEN 1 WHEN 'todo' THEN 2 WHEN 'review' THEN 3 WHEN 'done' THEN 4 END, CASE pt.priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END, pt.due_date ASC, pt.id ASC
    LIMIT ${TASK_LIST_CAP + 1}
  `);
const _showMembersStmt = db.prepare(`
    SELECT pm.id, pm.role, u.first_name || ' ' || u.last_name as member_name
    FROM project_members pm
    JOIN users u ON pm.user_id = u.id
    WHERE pm.project_id = ?
    ORDER BY pm.id ASC
    LIMIT ${MEMBER_LIST_CAP + 1}
  `);
// Loads the full set of columns the update transaction preserves on partial
// submissions (budget/spent plus status/priority/dates/owner/description).
const _projectUpdateBaseStmt = db.prepare('SELECT name, budget, spent, status, priority, start_date, end_date, owner_id, description FROM projects WHERE id = ?');
const _projectExistsStmt = db.prepare('SELECT 1 FROM projects WHERE id = ?');
const _deleteProjectTasksStmt = db.prepare('DELETE FROM project_tasks WHERE project_id = ?');
const _deleteProjectMembersStmt = db.prepare('DELETE FROM project_members WHERE project_id = ?');
const _deleteProjectStmt = db.prepare('DELETE FROM projects WHERE id = ?');

// Cached prepared statement for project update (progress is set by recalcProjectProgress
// immediately after, so it is intentionally excluded to avoid a double-write)
const _projectUpdateStmt = db.prepare(`
    UPDATE projects SET name = ?, description = ?, status = ?, priority = ?,
      start_date = ?, end_date = ?, budget = ?, spent = ?, owner_id = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `);

// Cached prepared statements for task routes
// The INSERT derives `completed_at` from the RESOLVED status: a task created
// directly in the 'done' state must carry a completion timestamp, exactly
// like the UPDATE routes' `completed_at = CASE WHEN ? THEN COALESCE(...)
// ELSE NULL END` and the ticket create route's `resolved_at`. Without it the
// create path was the only producer of a row that claimed to be done with
// no completion time — a state the UPDATE route considered impossible (a
// later PUT backfilled the column, so the same task could hold both).
const _taskInsertStmt = db.prepare(`
    INSERT INTO project_tasks (project_id, title, description, status, priority, assigned_to, due_date, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'done' THEN datetime('now') ELSE NULL END)
  `);
const _taskExistsStmt = db.prepare('SELECT id, project_id, title, description, status, priority, assigned_to, due_date, completed_at, created_at, updated_at FROM project_tasks WHERE id = ? AND project_id = ?');
const _taskQuickStatusStmt = db.prepare(`
    UPDATE project_tasks SET status = ?,
      completed_at = CASE WHEN ? THEN COALESCE(completed_at, datetime('now')) ELSE NULL END,
      updated_at = datetime('now')
    WHERE id = ? AND project_id = ?
  `);
const _taskFullUpdateStmt = db.prepare(`
    UPDATE project_tasks SET title = ?, description = ?, status = ?, priority = ?,
      assigned_to = ?, due_date = ?,
      completed_at = CASE WHEN ? THEN COALESCE(completed_at, datetime('now')) ELSE NULL END,
      updated_at = datetime('now')
    WHERE id = ? AND project_id = ?
  `);
const _taskDeleteStmt = db.prepare('DELETE FROM project_tasks WHERE id = ? AND project_id = ?');
const _taskDeleteGetStmt = db.prepare('SELECT title FROM project_tasks WHERE id = ? AND project_id = ?');

// Cached prepared statements for member routes
const _memberInsertStmt = db.prepare('INSERT OR IGNORE INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)');
const _memberDeleteStmt = db.prepare('DELETE FROM project_members WHERE id = ? AND project_id = ?');
const _memberByIdStmt = db.prepare('SELECT id, role FROM project_members WHERE id = ? AND project_id = ?');
const _leadMemberCountStmt = db.prepare('SELECT COUNT(*) as lead_count FROM project_members WHERE project_id = ? AND role = \'lead\'');

// Cached prepared statement for project select by ID (used in edit route)
const _selectProjectByIdStmt = db.prepare('SELECT id, name, description, status, priority, start_date, end_date, budget, spent, progress, owner_id, created_at, updated_at FROM projects WHERE id = ?');

const _projectInsertStmt = db.prepare(`
    INSERT INTO projects (name, description, status, priority, start_date, end_date, budget, spent, owner_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

// Sort options for the projects list route. Mirrors the pattern used in
// tickets.js / assets.js / audit.js — safeSort validates the key against
// the map and falls back to 'default' if unknown.
const SORT_MAP = Object.freeze({
  newest: 'p.updated_at DESC, p.id DESC',
  oldest: 'p.updated_at ASC, p.id ASC',
  name: 'p.name ASC, p.id ASC',
  priority: "CASE p.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 END, p.updated_at DESC, p.id DESC",
  default: 'p.updated_at DESC, p.id DESC'
});

// List projects (paginated)
router.get('/', (req, res) => {
  req.audit('read', 'project', null, 'Viewed projects list');
  // Fail closed on HTTP parameter pollution: reject array payloads on query
  // params. Mirrors the explicit HPP guard on GET /audit and the array-rejection
  // convention used by every write route in the app.
  const hppErrors = rejectHppArrays(req, ['search', 'sort', 'status', 'priority']);
  if (hppErrors.length > 0) {
    req.flash('error', 'Invalid request parameters');
    return res.redirect('/projects');
  }
  const { page: requestedPage, limit } = paginate(req);

  const qStatus = safeQueryValue(req.query.status);
  const qPriority = safeQueryValue(req.query.priority);
  const filters = buildFilters({
    'p.status': { value: VALID_STATUSES.includes(qStatus) ? qStatus : '' },
    'p.priority': { value: VALID_PRIORITIES.includes(qPriority) ? qPriority : '' }
  }, ['p.status', 'p.priority']);

  const where = [...filters.where];
  const params = [...filters.params];
  // The search surface must cover exactly what the list renders. The card
  // shows only the FIRST DESC_TRUNCATION_LEN characters of the description
  // (the full text lives on the ownership-gated show route), so the search
  // matches that same prefix: searching the full column let a viewer who
  // cannot open the project confirm the existence of text they are not
  // allowed to read (a content oracle). The knowledge index applies the same
  // rule by scoping the list to the viewer before the search runs.
  //
  // The card also renders the OWNER's name, and the list offers no owner
  // filter, so the owner's name is searchable too — a rendered value the user
  // could see must be usable to find the row. The card renders it as ONE
  // string ("<first> <last>"), so the search matches that CONCATENATION: the
  // two halves were searched separately, which left the text the user could
  // actually read unfindable ("John Smith" matched nothing while "John" and
  // "Smith" each did) — the same defect the asset list's manufacturer+name
  // cell was closed for.
  addSearch(where, params, safeQueryValue(req.query.search), [
    'p.name',
    { concat: ['u.first_name', 'u.last_name'] },
    { column: 'p.description', prefix: DESC_TRUNCATION_LEN }
  ]);

  const whereClause = where.length ? where.join(' AND ') : '1=1';
  const orderBy = safeSort(safeQueryValue(req.query.sort), SORT_MAP, 'default');

  // The count query needs the same JOIN as the list query: the search now
  // covers the owner's name, which lives in the joined users table.
  const total = countQuery(db, 'projects', 'p', whereClause, params, 'LEFT JOIN users u ON p.owner_id = u.id');
  const totalPages = Math.ceil(total / limit) || 1;
  // Clamp the requested page to the actual page count so a page beyond the
  // last one (e.g. ?page=999) renders the final page instead of an empty list
  // with a broken "Showing N–M" range (M < N) in the pagination partial.
  const page = Math.min(requestedPage, totalPages);
  const offset = (page - 1) * limit;

  // Use LEFT JOIN with conditional aggregation instead of correlated subqueries
  // for task counts — avoids N+1 query pattern on large project lists.
  // owner_id is selected (not just owner_name) so the index template can link
  // cards only for rows the viewer can open on the ownership-gated show route.
  const projects = selectQuery(db, `
    SELECT p.id, p.name, p.description, p.status, p.priority, p.start_date, p.end_date,
      p.budget, p.spent, p.progress, p.owner_id, p.created_at, p.updated_at,
      u.first_name || ' ' || u.last_name as owner_name,
      COALESCE(tCounts.task_count, 0) as task_count,
      COALESCE(tCounts.done_count, 0) as done_count
    FROM projects p
    LEFT JOIN users u ON p.owner_id = u.id
    LEFT JOIN (
      SELECT project_id, COUNT(*) as task_count,
        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done_count
      FROM project_tasks GROUP BY project_id
    ) tCounts ON tCounts.project_id = p.id
    WHERE ${whereClause}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `, [...params, limit, offset]);

  // Money redaction for viewers who may not see it. The templates gate the
  // budget/spent columns behind isPrivileged(user) — the same
  // business-sensitivity policy licenses.js applies to cost/seats — but the
  // values were still handed to the template in the render context, so any
  // future template change (or a debug dump of the context) would disclose
  // them. Zeroing them here keeps the render context as strict as the markup,
  // exactly like the staff directory's email/phone/department redaction and
  // the username redaction applied to EVERY row.
  const viewerPrivileged = isPrivileged(req.session.user);
  const renderedProjects = viewerPrivileged
    ? projects
    : projects.map(p => ({ ...p, budget: null, spent: null }));

  res.render('pages/projects/index', {
    title: 'Projects', projects: renderedProjects,
    filters: safeFilters(req.query, ['search', 'status', 'priority', 'sort']),
    page, limit, totalPages, total,
    baseUrl: paginationBaseUrl(req)
  });
});

// New project form
router.get('/new', requireAdminOrManager, (req, res) => {
  const staff = getActiveStaff(db);
  res.render('pages/projects/form', { title: 'New Project', project: {}, staff, isEdit: false });
});

// Create project
router.post('/', requireAdminOrManager, projectWriteLimiter, (req, res) => {
  // Fail closed on HTTP parameter pollution: reject array payloads.
  const hppErrors = rejectHppArrays(req, ['name', 'description', 'status', 'priority', 'start_date', 'end_date', 'budget', 'spent', 'owner_id']);
  if (hppErrors.length > 0) {
    req.flash('error', 'Invalid request parameters');
    return res.redirect('/projects/new');
  }

  const name = trim(safeQueryValue(req.body.name));
  const description = trim(safeQueryValue(req.body.description));
  // Fail closed on present-but-non-string body fields (e.g. JSON
  // numbers/objects): trim() coerces them to '', which would silently store
  // NULL for an optional text field — the same fail-closed convention the
  // update route enforces via resolveOptionalField's error sentinel. Mirrors
  // the vendors.js create guard.
  // The REQUIRED column is guarded too: without it a JSON number in `name`
  // collapsed to '' and was reported as a MISSING field ("Project name is
  // required"), while the matching update route reported the identical
  // submission as "Invalid request parameters" — a type error masquerading
  // as an absent one. The enum fields are guarded for the same reason
  // (a non-string status/priority used to be reported as an invalid enum
  // value rather than as an invalid request).
  const wrongTypeField = findNonStringField(req.body, ['name', 'description', 'status', 'priority']);
  if (wrongTypeField) {
    req.flash('error', 'Invalid request parameters');
    return res.redirect('/projects/new');
  }
  const start_date = safeQueryValue(req.body.start_date);
  const end_date = safeQueryValue(req.body.end_date);
  const budget = safeQueryValue(req.body.budget);
  // spent shares the create form with budget and must be parsed here too —
  // previously the form collected it while the create route silently dropped
  // it (INSERT omitted the column), storing 0 with a success flash.
  const spent = safeQueryValue(req.body.spent);
  const owner_id = safeQueryValue(req.body.owner_id);

  if (!name) {
    req.flash('error', 'Project name is required');
    return res.redirect('/projects/new');
  }


  // A present-but-whitespace-only value is neither an ABSENT field ("not
  // submitted") nor an intentional empty string ("clear the column") — it is
  // an INVALID value. The matching UPDATE route rejects the identical value
  // through resolveOptionalField's blank-value guard ("Invalid Description"),
  // so the create route must not accept it, store NULL and flash success:
  // the same column, two verdicts.
  const blankField = findBlankTextField(req.body, ['description']);
  if (blankField) {
    req.flash('error', `Invalid ${titleCase(blankField)}`);
    return res.redirect('/projects/new');
  }

  if (name.length > MAX_MEDIUM_STR) {
    req.flash('error', `Project name must be at most ${MAX_MEDIUM_STR} characters`);
    return res.redirect('/projects/new');
  }
  if (description && description.length > MAX_DESC) {
    req.flash('error', `Description must be at most ${MAX_DESC} characters`);
    return res.redirect('/projects/new');
  }

  // Enum resolution — the presence test runs against the RAW submitted value,
  // exactly like every sibling create route (assets, tickets, tasks, changes
  // and articles), so the documented defaults apply to an absent field and a
  // present-but-invalid field is rejected:
  //   - `status` is a NOT NULL column with the schema default 'planning' (and
  //     the form pre-selects it), so an ABSENT value takes that default while
  //     a present-but-blank/empty/unknown value is rejected. The route used to
  //     REQUIRE the field, so a client that submitted only a name was refused
  //     with "Invalid Status" — while the project's own UPDATE route preserves
  //     the stored status on absence and every sibling create route applies
  //     its documented default. The README's create-route paragraph states the
  //     rule the code did not implement: "An absent field still takes the
  //     documented default."
  //   - `priority` is a nullable column whose stored default ('medium')
  //     carries meaning, so a blank value means "not submitted" and the
  //     default applies (the task and change create routes already behave
  //     this way); a whitespace-only or unknown value is still rejected.
  const createStatusEnum = resolveEnumField(req.body.status, VALID_STATUSES);
  if (createStatusEnum.state === 'blank' || createStatusEnum.state === 'invalid' || createStatusEnum.state === 'empty') {
    req.flash('error', 'Invalid Status');
    return res.redirect('/projects/new');
  }
  const safeStatus = createStatusEnum.state === 'valid' ? createStatusEnum.value : 'planning';
  const createPriorityEnum = resolveEnumField(req.body.priority, VALID_PRIORITIES);
  if (createPriorityEnum.state === 'blank' || createPriorityEnum.state === 'invalid') {
    req.flash('error', 'Invalid Priority');
    return res.redirect('/projects/new');
  }
  const safePriority = createPriorityEnum.state === 'valid' ? createPriorityEnum.value : 'medium';

  const sStart = safeDate(start_date);
  const sEnd = safeDate(end_date);
  // Reject malformed (non-empty, non-parseable) dates instead of silently
  // storing NULL. Empty input is allowed (falls back to NULL); only a present
  // value that fails to parse is an error. Mirrors the strict date validation
  // in changes.js (_resolveDateTimeField) and licenses.js.
  if (start_date !== undefined && start_date !== null && start_date !== '' && sStart === null) {
    req.flash('error', 'Invalid Start Date');
    return res.redirect('/projects/new');
  }
  if (end_date !== undefined && end_date !== null && end_date !== '' && sEnd === null) {
    req.flash('error', 'Invalid End Date');
    return res.redirect('/projects/new');
  }
  if (sStart && sEnd && sEnd < sStart) {
    req.flash('error', 'End date must be on or after start date');
    return res.redirect('/projects/new');
  }

  // Fail closed on malformed budget (LOW). A present, non-empty budget that
  // fails to parse must be rejected rather than silently coerced to 0, which
  // would drop a legitimate budget on a typo'd submission. An empty/omitted
  // budget is allowed and falls back to 0 — the schema's column default and
  // the "no amount recorded" representation. The UPDATE path has no such
  // fallback: a blank budget there preserves the stored value (see the
  // money-field convention in the update transaction). Mirrors the projects
  // UPDATE path (2nd pass).
  //
  // The amount is also bounded by MAX_MONEY_AMOUNT — the limit the form's
  // number input declares. The attribute is a client-side hint only, so
  // without the server-side check an API client could store a budget the UI
  // refuses to accept (and the two surfaces disagreed about what a valid
  // amount is).
  const budgetCheck = resolveMoneyAmount(budget, 0);
  if (budgetCheck.error === 'invalid') {
    req.flash('error', 'Invalid Budget Amount');
    return res.redirect('/projects/new');
  }
  if (budgetCheck.error === 'too_large') {
    req.flash('error', `Budget must be at most ${MAX_MONEY_AMOUNT}`);
    return res.redirect('/projects/new');
  }
  const safeBudget = budgetCheck.value;

  // Fail closed on malformed spent, mirroring budget above: a present,
  // non-empty value that fails to parse is rejected rather than silently
  // coerced to 0. An empty/omitted value is allowed and falls back to 0 — the
  // column default and the "no amount recorded" representation (the UPDATE
  // path instead preserves the stored value). The amount carries the same
  // upper bound as the budget.
  const spentCheck = resolveMoneyAmount(spent, 0);
  if (spentCheck.error === 'invalid') {
    req.flash('error', 'Invalid Spent Amount');
    return res.redirect('/projects/new');
  }
  if (spentCheck.error === 'too_large') {
    req.flash('error', `Spent Amount must be at most ${MAX_MONEY_AMOUNT}`);
    return res.redirect('/projects/new');
  }
  const safeSpent = spentCheck.value;

  // Validate owner is an active user
  // Fail closed on a present-but-malformed owner id ("abc", "3.5", an HPP
  // array) instead of silently coercing it to NULL via safeId, which would
  // store the project unassigned with no user feedback. Absent/empty values
  // legitimately mean "no owner".
  if (isPresentInvalidId(owner_id)) {
    req.flash('error', 'Invalid Owner');
    return res.redirect('/projects/new');
  }
  const safeOwnerId = owner_id ? safeId(owner_id) : null;

  try {
    // Validate owner and insert in a single transaction to avoid a TOCTOU
    // race where the owner is deactivated between the check and the INSERT
    // (mirrors the ticket/change/create patterns).
    const createProject = db.transaction(() => {
      if (safeOwnerId && !isActiveUser(db, safeOwnerId)) {
        throw new Error('OWNER_NOT_AVAILABLE');
      }
      return _projectInsertStmt.run(name.substring(0, MAX_MEDIUM_STR), (description || '').substring(0, MAX_DESC) || null, safeStatus, safePriority,
        sStart, sEnd, safeBudget, safeSpent, safeOwnerId);
    });
    const result = createProject();

    req.audit('create', 'project', result.lastInsertRowid, `Created project ${name}`);
    req.flash('success', 'Project created successfully.');
    invalidateDashboardCache();
    return res.redirect(`/projects/${result.lastInsertRowid}`);
  } catch (err) {
    if (err.message === 'OWNER_NOT_AVAILABLE') {
      req.flash('error', 'Selected owner is not available');
      return res.redirect('/projects/new');
    }
    logError('Project create error:', err);
    req.flash('error', 'Error creating project. Please try again.');
    return res.redirect('/projects/new');
  }
});

// Show project
router.get('/:id', (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid project ID');
    return res.redirect('/projects');
  }

  const project = _showProjectStmt.get(id);

  if (!project) {
    req.flash('error', 'Project not found');
    return res.redirect('/projects');
  }

  if (!canAccessResource(req, project)) {
    req.audit('access_denied', 'project', id, `Unauthorized view attempt on project ${project.name}`);
    // Use the same non-enumerating wording as the "not found" branch above: a
    // distinct "you do not have permission" message reveals that the project ID
    // exists even though the viewer was refused the record. Mirrors the
    // assets/staff/tickets/changes/knowledge show routes, which answer both
    // branches identically, and the README's app-wide "Non-enumerating errors"
    // rule.
    req.flash('error', 'Project not found');
    return res.redirect('/projects');
  }

  req.audit('read', 'project', id, `Viewed project: ${project.name}`);

  const tasksCap = capList(_showTasksStmt.all(id), TASK_LIST_CAP);
  const tasks = tasksCap.rows;

  const membersCap = capList(_showMembersStmt.all(id), MEMBER_LIST_CAP);
  const members = membersCap.rows;

  const staff = getActiveStaff(db);

  // Money redaction for viewers who may not see it — the same policy the
  // projects list applies. The show template gates the budget/spent line
  // behind isPrivileged(user), but the values were still handed to the
  // template in the render context; a project OWNER who is not privileged
  // reached this route, so the amounts were one template change away from
  // being disclosed to them.
  const renderedProject = isPrivileged(req.session.user)
    ? project
    : { ...project, budget: null, spent: null };

  res.render('pages/projects/show', {
    title: project.name, project: renderedProject, tasks, members, staff,
    // Exact truncation flags for the two capped lists (computed from the
    // one-row-beyond-the-cap probe the queries fetch).
    tasksTruncated: tasksCap.truncated,
    membersTruncated: membersCap.truncated
  });
});

// Edit project form
router.get('/:id/edit', requireAdminOrManager, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid project ID');
    return res.redirect('/projects');
  }
  const project = _selectProjectByIdStmt.get(id);
  if (!project) {
    req.flash('error', 'Project not found');
    return res.redirect('/projects');
  }
  // Ensure the current owner appears in the dropdown even when they have since
  // been deactivated (is_active = 0). Without this, an edit form would silently
  // render "Select owner" for an inactive owner and re-saving would wipe the
  // stored owner (data loss). The update route preserves the current owner when
  // the submitted value is unchanged, so the dropdown value is saveable.
  const staff = ensureAssigneeInList(getActiveStaff(db), project.owner_id, db);
  res.render('pages/projects/form', { title: 'Edit Project', project, staff, isEdit: true });
});

// Update project
router.put('/:id', requireAdminOrManager, projectWriteLimiter, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid project ID');
    return res.redirect('/projects');
  }

  // Fail closed on HTTP parameter pollution: reject array payloads.
  const hppErrors = rejectHppArrays(req, ['name', 'description', 'status', 'priority', 'start_date', 'end_date', 'budget', 'spent', 'owner_id']);
  if (hppErrors.length > 0) {
    req.flash('error', 'Invalid request parameters');
    return res.redirect(`/projects/${id}/edit`);
  }

  const name = trim(safeQueryValue(req.body.name));
  const rawDescription = req.body.description;
  const description = trim(safeQueryValue(req.body.description));
  const start_date = safeQueryValue(req.body.start_date);
  const end_date = safeQueryValue(req.body.end_date);
  const budget = safeQueryValue(req.body.budget);
  const spent = safeQueryValue(req.body.spent);
  const owner_id = safeQueryValue(req.body.owner_id);

  // Absent-vs-present marker for the project's name. An ABSENT name in a
  // partial API submission preserves the stored value (resolved inside the
  // transaction from the re-read row) — the same contract every other field
  // on this route already follows and the one the route's own comment states
  // ("an absent field means 'keep what's stored'"). Previously the name was
  // the sole exception and a partial PUT that only changed, say, the status
  // was rejected outright with "Project name is required". A PRESENT but
  // empty name is still rejected: the column is NOT NULL and an empty name
  // has no valid meaning.
  const nameAbsent = req.body.name === undefined || req.body.name === null;

  // Fail closed on a present-but-non-string REQUIRED column (e.g. a JSON
  // number): trim() coerces it to '', so the check below reported the
  // submission as a MISSING field ("Project name is required") — a type
  // error masquerading as an absent one. The sibling required columns on the
  // assets/tickets update routes report the identical submission as "Invalid
  // request parameters", so the guard has to run BEFORE the required-field
  // check to be reached at all.
  if (req.body.name !== undefined && req.body.name !== null && req.body.name !== '' && typeof req.body.name !== 'string') {
    req.flash('error', 'Invalid request parameters');
    return res.redirect(`/projects/${id}/edit`);
  }
  if (!nameAbsent && !name) {
    req.flash('error', 'Project name is required');
    return res.redirect(`/projects/${id}/edit`);
  }
  if (!nameAbsent && name.length > MAX_MEDIUM_STR) {
    req.flash('error', `Project name must be at most ${MAX_MEDIUM_STR} characters`);
    return res.redirect(`/projects/${id}/edit`);
  }
  // Fail closed on a present-but-non-string enum value (e.g. a JSON number):
  // trim() coerces it to '', which would skip the enum checks below and leave
  // the field silently preserved with a success flash — inconsistent with
  // the fail-closed convention applied to every other present-but-invalid field
  // on this route. Absent/empty submissions are allowed (preserve stored value).
  // Mirrors the changes.js update guard.
  //
  // `description` is guarded here as well: the CREATE route rejects a
  // wrong-typed description with the app-wide "Invalid request parameters",
  // while the update route used to answer "Invalid Description" for the
  // identical submission — the same column, two messages, depending on the
  // verb. The field-specific wording is now reserved for a whitespace-only
  // VALUE.
  const wrongTypeField = findNonStringField(req.body, ['status', 'priority', 'description']);
  if (wrongTypeField) {
    req.flash('error', 'Invalid request parameters');
    return res.redirect(`/projects/${id}/edit`);
  }

  // Enum resolution — the presence test runs against the RAW submitted value
  // so a present-but-blank enum is rejected rather than being silently
  // ignored. `status` is a NOT NULL column (an empty value has no valid
  // meaning, the same rule the required name column follows); `priority` is
  // nullable with a meaningful default, so an explicit empty value is treated
  // as "not submitted" and the stored priority is preserved.
  const statusEnum = resolveEnumField(req.body.status, VALID_STATUSES);
  const priorityEnum = resolveEnumField(req.body.priority, VALID_PRIORITIES);
  if (statusEnum.state === 'blank' || statusEnum.state === 'invalid' || statusEnum.state === 'empty') {
    req.flash('error', 'Invalid Status');
    return res.redirect(`/projects/${id}/edit`);
  }
  if (priorityEnum.state === 'blank' || priorityEnum.state === 'invalid') {
    req.flash('error', 'Invalid Priority');
    return res.redirect(`/projects/${id}/edit`);
  }
  if (description && description.length > MAX_DESC) {
    req.flash('error', `Description must be at most ${MAX_DESC} characters`);
    return res.redirect(`/projects/${id}/edit`);
  }

  try {
    const sStart = safeDate(start_date);
    const sEnd = safeDate(end_date);
    // Reject malformed (non-empty, non-parseable) dates instead of silently
    // storing NULL. Empty input is allowed (falls back to NULL); only a present
    // value that fails to parse is an error. Mirrors the strict date validation
    // in changes.js (_resolveDateTimeField) and licenses.js.
    if (start_date !== undefined && start_date !== null && start_date !== '' && sStart === null) {
      req.flash('error', 'Invalid Start Date');
      return res.redirect(`/projects/${id}/edit`);
    }
    if (end_date !== undefined && end_date !== null && end_date !== '' && sEnd === null) {
      req.flash('error', 'Invalid End Date');
      return res.redirect(`/projects/${id}/edit`);
    }
    if (sStart && sEnd && sEnd < sStart) {
      req.flash('error', 'End date must be on or after start date');
      return res.redirect(`/projects/${id}/edit`);
    }

    // Fail closed on a present-but-malformed owner id ("abc", "3.5", an HPP
    // array) instead of silently coercing it to NULL via safeId, which would
    // wipe an existing assignment with no user feedback. Absent/empty values
    // legitimately mean "no owner".
    if (isPresentInvalidId(owner_id)) {
      req.flash('error', 'Invalid Owner');
      return res.redirect(`/projects/${id}/edit`);
    }

    // Verify project exists, validate owner, and update in a single transaction
    // to avoid TOCTOU races: the project could be deleted or the owner deactivated
    // between the checks and the UPDATE.
    // `resolvedName` is hoisted out of the transaction so the audit entry can
    // name the project even when the request omitted the name field (a partial
    // update) and the effective value came from the re-read row.
    let resolvedName = name;
    const updateProject = db.transaction(() => {
      // Fetch existing budget/spent/status/priority inside the transaction to
      // preserve values when the submitted fields are absent, eliminating a
      // TOCTOU race where these fields are modified between the SELECT and the
      // UPDATE.
      const existingProject = _projectUpdateBaseStmt.get(id);
      if (!existingProject) {
        throw new Error('NOT_FOUND');
      }
      const effectiveStatus = statusEnum.state === 'valid' ? statusEnum.value : existingProject.status;
      const effectivePriority = priorityEnum.state === 'valid' ? priorityEnum.value : existingProject.priority;
      // The name follows the same absent-vs-present rule: an absent field
      // preserves the stored name (resolved from the re-read row so a
      // concurrent rename cannot be clobbered), a present field replaces it.
      const effectiveName = nameAbsent ? existingProject.name : name.substring(0, MAX_MEDIUM_STR);
      resolvedName = effectiveName;

      // Resolve the owner against the transaction-consistent re-fetch using the
      // same absent-vs-empty convention as the dates on this route: an ABSENT
      // field (partial API submission) preserves the stored owner, while an
      // explicit empty string ("No owner" in the edit form) clears it (null).
      // Previously an absent field silently wiped the stored owner — resolvedStart/
      // resolvedEnd both preserved on absence, so a partial PUT could drop an
      // owner by omission.
      const resolvedOwnerId = (owner_id === undefined || owner_id === null)
        ? (existingProject.owner_id ?? null)
        : (owner_id === '' ? null : safeId(owner_id));

      // Resolve money fields against the freshly-read row to avoid a TOCTOU
      // between this SELECT and the UPDATE.
      // - Budget/spent (money): an ABSENT *or* EMPTY field preserves the
      //   stored value — a blank money field is not a "clear to NULL" signal
      //   (NULL is indistinguishable from "not recorded" and would blank the
      //   financial columns in the index/show views). Only an explicit
      //   numeric value replaces it, and an explicit 0 is a legitimate value
      //   that clears the amount to zero. This mirrors the assets
      //   purchase_price and licenses cost handling.
      //   The amount also carries the app-wide upper bound
      //   (MAX_MONEY_AMOUNT) the form's number input declares: an HTML `max`
      //   attribute is a client-side hint only, so without the server-side
      //   check an API client could store an amount the UI refuses to accept.
      //   An ABSENT field falls back to the STORED value (including NULL, via
      //   the ?? null) rather than to 0, so a partial edit never blanks the
      //   financial columns.
      const spentCheck = resolveMoneyAmount(spent, existingProject.spent ?? null);
      if (spentCheck.error === 'invalid') {
        throw Object.assign(new Error('INVALID_SPENT'), { flash: 'Invalid Spent Amount' });
      }
      if (spentCheck.error === 'too_large') {
        throw Object.assign(new Error('INVALID_SPENT'), { flash: `Spent Amount must be at most ${MAX_MONEY_AMOUNT}` });
      }
      const preservedSpent = spentCheck.value;
      const budgetCheck = resolveMoneyAmount(budget, existingProject.budget ?? null);
      if (budgetCheck.error === 'invalid') {
        throw Object.assign(new Error('INVALID_BUDGET'), { flash: 'Invalid Budget Amount' });
      }
      if (budgetCheck.error === 'too_large') {
        throw Object.assign(new Error('INVALID_BUDGET'), { flash: `Budget must be at most ${MAX_MONEY_AMOUNT}` });
      }
      const preservedBudget = budgetCheck.value;

      // Preserve the current (possibly deactivated) owner when the submitted
      // value is unchanged, so editing an unrelated field on a project whose
      // owner has since been deactivated does not force a reassignment or wipe
      // the stored value — the edit form includes the inactive owner via
      // ensureAssigneeInList. Assigning to a DIFFERENT inactive user is still
      // rejected (fail closed).
      if (resolvedOwnerId && !isActiveUser(db, resolvedOwnerId) && Number(resolvedOwnerId) !== Number(existingProject.owner_id)) {
        throw new Error('OWNER_NOT_AVAILABLE');
      }

      // Resolve start/end dates against the freshly-read transaction-consistent
      // row. An ABSENT field (partial API submission) preserves the stored value;
      // an EMPTY submitted value ('' — the form's <input type="date"> sends ''
      // when the user clears it) CLEARS it (null). This matches the absent-vs-
      // empty convention used by vendors.js, licenses.js, and changes.js;
      // previously an empty date was treated as "preserve", which made it
      // impossible to clear a project start/end date via the edit form.
      const resolvedStart = (start_date === undefined || start_date === null)
        ? existingProject.start_date
        : sStart;
      const resolvedEnd = (end_date === undefined || end_date === null)
        ? existingProject.end_date
        : sEnd;

      // Validate the date range against the RESOLVED values, not just the
      // submitted ones. A partial edit that moves start_date forward while
      // leaving end_date empty would otherwise pass the submitted-only check
      // above (submitted sEnd is null) yet persist end < start against the
      // preserved stored end date. Mirrors the resolved-value range checks in
      // vendors.js, changes.js, and licenses.js.
      if (resolvedStart && resolvedEnd && resolvedEnd < resolvedStart) {
        throw new Error('DATE_RANGE_INVALID');
      }

      // Present-but-non-string description (e.g. a JSON number) is rejected
      // rather than silently clearing the stored value — the fail-closed
      // sentinel contract honored by vendors.js/licenses.js/changes.js.
      const resolvedDescription = resolveOptionalField(rawDescription, description || null, MAX_DESC, existingProject.description);
      if (resolvedDescription && resolvedDescription.error) {
        throw new Error('INVALID_DESCRIPTION');
      }

      const result = _projectUpdateStmt.run(effectiveName, resolvedDescription, effectiveStatus, effectivePriority, resolvedStart, resolvedEnd,
        preservedBudget, preservedSpent, resolvedOwnerId, id);
      if (result.changes === 0) {
        throw new Error('NOT_FOUND');
      }
    });
    updateProject();

    // Recalculate project progress outside the transaction so SQLite's write
    // lock is not held across multiple sequential queries. The project data
    // was read as of the transaction's snapshot, so the recalc reflects the
    // post-update state correctly even though the queries execute after commit.
    try {
      recalcProjectProgress(db, id);
    } catch (err) {
      logError(`Progress recalculation error for project #${id}:`, err);
    }

    req.audit('update', 'project', id, `Updated project ${resolvedName}`);
    req.flash('success', 'Project updated successfully.');
    invalidateDashboardCache();
    return res.redirect(`/projects/${id}`);
  } catch (err) {
    if (err.message === 'NOT_FOUND') {
      req.flash('error', 'Project not found');
      return res.redirect('/projects');
    }
    if (err.message === 'OWNER_NOT_AVAILABLE') {
      req.flash('error', 'Selected owner is not available');
      return res.redirect(`/projects/${id}/edit`);
    }
    if ((err.message === 'INVALID_BUDGET' || err.message === 'INVALID_SPENT') && err.flash) {
      req.flash('error', err.flash);
      return res.redirect(`/projects/${id}/edit`);
    }
    if (err.message === 'DATE_RANGE_INVALID') {
      req.flash('error', 'End date must be on or after start date');
      return res.redirect(`/projects/${id}/edit`);
    }
    if (err.message === 'INVALID_DESCRIPTION') {
      req.flash('error', 'Invalid Description');
      return res.redirect(`/projects/${id}/edit`);
    }
    logError('Project update error:', err);
    req.flash('error', 'Error updating project. Please try again.');
    return res.redirect(`/projects/${id}/edit`);
  }
});

// Delete project (with tasks & members in transaction)
router.delete('/:id', requireAdminOrManager, projectWriteLimiter, (req, res) => {
  // Fail closed on HTTP parameter pollution: reject array payloads. Mirrors the
  // array-rejection guards on every other write route in the app.
  const hppErrors = rejectHppArrays(req, ['id']);
  if (hppErrors.length > 0) {
    req.flash('error', 'Invalid request parameters');
    return res.redirect('/projects');
  }

  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid project ID');
    return res.redirect('/projects');
  }

  try {
    const deleteProject = db.transaction(() => {
      const existing = _showProjectStmt.get(id);
      if (!existing) {
        return { changes: 0, name: null };
      }
      _deleteProjectTasksStmt.run(id);
      _deleteProjectMembersStmt.run(id);
      const changes = _deleteProjectStmt.run(id).changes;
      return { changes, name: existing.name };
    });
    const result = deleteProject();
    if (result.changes === 0) {
      req.flash('error', 'Project not found');
    } else {
      req.audit('delete', 'project', id, `Deleted project "${result.name}"`);
      req.flash('success', 'Project deleted.');
      invalidateDashboardCache();
    }
  } catch (err) {
    logError('Project delete error:', err);
    req.flash('error', 'Error deleting project.');
  }
  return res.redirect('/projects');
});

// Add task to project
router.post('/:id/tasks', requireAdminOrManager, projectWriteLimiter, (req, res) => {
  const projectId = safeId(req.params.id);
  if (!projectId) {
    req.flash('error', 'Invalid project ID');
    return res.redirect('/projects');
  }

  // Fail closed on HTTP parameter pollution: reject array payloads.
  const hppErrors = rejectHppArrays(req, ['title', 'description', 'status', 'priority', 'assigned_to', 'due_date']);
  if (hppErrors.length > 0) {
    req.flash('error', 'Invalid request parameters');
    return res.redirect(`/projects/${projectId}`);
  }

  const title = trim(safeQueryValue(req.body.title));
  const description = trim(safeQueryValue(req.body.description));
  // Fail closed on a present-but-non-string description (e.g. a JSON number):
  // trim() coerces it to '', which would silently store NULL with a success
  // flash — the same convention the task UPDATE route enforces via
  // resolveOptionalField's error sentinel and every other create route applies.
  // status/priority are included because the enum checks below are
  // validate-when-present: a non-string collapses to '' and would silently fall
  // back to the 'todo'/'medium' defaults with a success flash (the full-update
  // route already guards both).
  // The REQUIRED title is guarded too: without it a JSON number in `title`
  // collapsed to '' and was reported as a MISSING field ("Task title is
  // required"), while the matching update route reported the identical
  // submission as "Invalid Task Title" — a type error masquerading as an
  // absent one.
  const wrongTypeField = findNonStringField(req.body, ['title', 'description', 'status', 'priority']);
  if (wrongTypeField) {
    req.flash('error', 'Invalid request parameters');
    return res.redirect(`/projects/${projectId}`);
  }
  const assigned_to = safeQueryValue(req.body.assigned_to);
  const due_date = safeQueryValue(req.body.due_date);

  if (!title) {
    req.flash('error', 'Task title is required');
    return res.redirect(`/projects/${projectId}`);
  }
  if (title.length > MAX_MEDIUM_STR) {
    req.flash('error', `Task title must be at most ${MAX_MEDIUM_STR} characters`);
    return res.redirect(`/projects/${projectId}`);
  }
  if (description && description.length > MAX_DESC) {
    req.flash('error', `Description must be at most ${MAX_DESC} characters`);
    return res.redirect(`/projects/${projectId}`);
  }
  // A present-but-whitespace-only value is neither an ABSENT field ("not
  // submitted") nor an intentional empty string ("clear the column") — it is
  // an INVALID value. The matching task UPDATE route rejects the identical
  // value through resolveOptionalField's blank-value guard ("Invalid
  // Description"), so the create route must not accept it, store NULL and
  // flash success: the same column, two verdicts.
  const blankTaskDescription = findBlankTextField(req.body, ['description']);
  if (blankTaskDescription) {
    req.flash('error', `Invalid ${titleCase(blankTaskDescription)}`);
    return res.redirect(`/projects/${projectId}`);
  }
  // Enum resolution — a present-but-blank task status/priority (a whitespace-
  // only value) is an invalid value, not an omitted one: it used to trim to ''
  // and silently take the create default with a success flash. The task
  // `status` column is NOT NULL, so an EMPTY value has no valid meaning
  // either — the task update route rejects it, and the create route used to
  // accept it and silently default. `priority` is nullable with a meaningful
  // default, so an explicit empty value is still treated as "not submitted".
  const createTaskStatusEnum = resolveEnumField(req.body.status, VALID_TASK_STATUSES);
  const createTaskPriorityEnum = resolveEnumField(req.body.priority, VALID_TASK_PRIORITIES);
  if (createTaskStatusEnum.state === 'blank' || createTaskStatusEnum.state === 'invalid' || createTaskStatusEnum.state === 'empty') {
    req.flash('error', 'Invalid Task Status');
    return res.redirect(`/projects/${projectId}`);
  }
  if (createTaskPriorityEnum.state === 'blank' || createTaskPriorityEnum.state === 'invalid') {
    req.flash('error', 'Invalid Task Priority');
    return res.redirect(`/projects/${projectId}`);
  }

  // Fail closed on a present-but-malformed assignee id ("abc", "3.5", an HPP
  // array) instead of silently coercing it to NULL via safeId, which would
  // create the task unassigned with no user feedback. Absent/empty values
  // legitimately mean "unassigned" (mirrors the owner validation on this
  // resource and the assignee validation in tickets/changes/assets).
  if (isPresentInvalidId(assigned_to)) {
    req.flash('error', 'Invalid Assignee');
    return res.redirect(`/projects/${projectId}`);
  }

  try {
    const safeTaskAssignee = assigned_to ? safeId(assigned_to) : null;
    // Verify project still exists, validate assignee, and insert the task in a
    // single transaction to avoid TOCTOU races: the project could be deleted or
    // the assignee deactivated between the existence/active checks and the INSERT.
    const addTask = db.transaction(() => {
      if (!_projectExistsStmt.get(projectId)) {
        throw new Error('PROJECT_NOT_FOUND');
      }
      // Validate assignee is still active inside the transaction so a concurrent
      // deactivation between the check and the INSERT is not possible.
      if (safeTaskAssignee && !isActiveUser(db, safeTaskAssignee)) {
        throw new Error('ASSIGNEE_NOT_AVAILABLE');
      }
      const safeDueDate = safeDate(due_date);
      // Fail-closed: a present but malformed due_date must be rejected rather than
      // silently stored as NULL — consistent with ticket/project/asset date validation.
      if (due_date !== undefined && due_date !== null && due_date !== '' && safeDueDate === null) {
        throw new Error('INVALID_DUE_DATE');
      }
      const result = _taskInsertStmt.run(projectId, title.substring(0, MAX_MEDIUM_STR), (description || '').substring(0, MAX_DESC) || null,
        createTaskStatusEnum.state === 'valid' ? createTaskStatusEnum.value : 'todo',
        createTaskPriorityEnum.state === 'valid' ? createTaskPriorityEnum.value : 'medium',
        safeTaskAssignee, safeDueDate,
        // The completion timestamp is derived from the resolved status, so a
        // task created as 'done' carries one (the column is derived, never
        // taken from the request).
        createTaskStatusEnum.state === 'valid' ? createTaskStatusEnum.value : 'todo');

      return result.lastInsertRowid;
    });
    const taskId = addTask();

    // Recalculate project progress outside the transaction to avoid holding the
    // SQLite write lock across multiple queries.
    try {
      recalcProjectProgress(db, projectId);
    } catch (err) {
      logError(`Progress recalculation error for project #${projectId}:`, err);
    }

    req.audit('create', 'project_task', taskId, `Added task "${title}" to project #${projectId}`);
    req.flash('success', 'Task added.');
    invalidateDashboardCache();
  } catch (err) {
    if (err.message === 'PROJECT_NOT_FOUND') {
      req.flash('error', 'Project not found');
      return res.redirect('/projects');
    }
    if (err.message === 'ASSIGNEE_NOT_AVAILABLE') {
      req.flash('error', 'Selected assignee is not available');
      return res.redirect(`/projects/${projectId}`);
    }
    if (err.message === 'INVALID_DUE_DATE') {
      req.flash('error', 'Invalid Due Date');
      return res.redirect(`/projects/${projectId}`);
    }
    logError('Project task add error:', err);
    req.flash('error', 'Error adding task. Please try again.');
  }
  return res.redirect(`/projects/${projectId}`);
});

// Update task
router.put('/:projectId/tasks/:taskId', requireAdminOrManager, projectWriteLimiter, (req, res) => {
  const projectId = safeId(req.params.projectId);
  const taskId = safeId(req.params.taskId);
  if (!projectId || !taskId) {
    req.flash('error', 'Invalid task ID');
    return res.redirect('/projects');
  }

  // Fail closed on HTTP parameter pollution: reject array payloads. Covers both the
  // quick-status path (status/priority/assigned_to/due_date/_quick_status) and
  // the full-update path (also title/description).
  const hppErrors = rejectHppArrays(req, ['status', 'priority', 'assigned_to', 'due_date', '_quick_status', 'title', 'description']);
  if (hppErrors.length > 0) {
    req.flash('error', 'Invalid request parameters');
    return res.redirect(`/projects/${projectId}`);
  }

  const assigned_to = safeQueryValue(req.body.assigned_to);
  const due_date = safeQueryValue(req.body.due_date);

  // Defensive: handle quick-status-change forms that only send `status`.
  // Uses a dedicated `_quick_status` flag sent by the EJS template so a
  // client cannot force the quick path by omitting the title from a full edit.
  // Uses explicit '1' check to mirror the is_featured checkbox idiom in
  // knowledge.js — prevents accidental truthy matches on arbitrary strings.
  if (safeQueryValue(req.body._quick_status) === '1') {
    // Reject an invalid present status up front (mirrors the tickets.js
    // quick-status route) — previously it silently fell back to the stored
    // status and reported "Status unchanged", mislabeling invalid input as a
    // valid no-op. The quick path REQUIRES a status, so a missing or blank one
    // is rejected rather than preserved.
    //
    // A present-but-wrong-typed status (e.g. a JSON number) is a TYPE error,
    // not an invalid VALUE, so it is reported with the app-wide "Invalid
    // request parameters" — the same message the full-update branch of THIS
    // route (findNonStringField) and the task create route report for the
    // identical submission. The field-specific wording ("Invalid Task
    // Status") is reserved for a wrong VALUE (a string outside the
    // allowlist). The type test runs against the RAW submitted value because
    // trim() coerces a non-string to '' and the type information would be
    // lost.
    if (req.body.status !== undefined && req.body.status !== null && req.body.status !== '' && typeof req.body.status !== 'string') {
      req.flash('error', 'Invalid request parameters');
      return res.redirect(`/projects/${projectId}`);
    }
    const quickStatus = trim(safeQueryValue(req.body.status));
    if (!VALID_TASK_STATUSES.includes(quickStatus)) {
      req.flash('error', 'Invalid Task Status');
      return res.redirect(`/projects/${projectId}`);
    }
    const status = quickStatus;
    // Quick status update only — read current status and update atomically
    // inside a single transaction to avoid a TOCTOU where a concurrent change
    // between the read and the UPDATE is silently overwritten.
    try {
      const updateTask = db.transaction(() => {
        const existing = _taskExistsStmt.get(taskId, projectId);
        if (!existing) {
          throw new Error('NOT_FOUND');
        }
        if (existing.status === status) {
          return { unchanged: true };
        }
        const result = _taskQuickStatusStmt.run(status, status === 'done' ? 1 : 0, taskId, projectId);
        if (result.changes === 0) {
          throw new Error('NOT_FOUND');
        }
        return { unchanged: false, status: status };
      });
      const result = updateTask();

      if (result.unchanged) {
        req.flash('info', 'Status unchanged.');
      } else {
        // Recalculate project progress outside the transaction to avoid holding the
        // SQLite write lock across multiple queries. Runs only when the status
        // actually changed — a no-op submission must not bump the project's
        // updated_at (which would reorder it under "newest" sorting) or rewrite
        // progress when nothing changed.
        try {
          recalcProjectProgress(db, projectId);
        } catch (err) {
          logError(`Progress recalculation error for project #${projectId}:`, err);
        }
        // Audit the quick-status change — previously this path silently skipped
        // audit logging, so a task toggled to 'done' via the project page left
        // no trail even though the full edit route logged 'update' for the same
        // entity. The full-update branch below already audits; this mirrors it.
        req.audit('update', 'project_task', taskId, `Quick status change to ${result.status}`);
        req.flash('success', 'Task updated.');
        invalidateDashboardCache();
      }
      return res.redirect(`/projects/${projectId}`);
    } catch (err) {
      if (err.message === 'NOT_FOUND') {
        req.flash('error', 'Task not found');
      } else {
        logError('Project task quick-status error:', err);
        req.flash('error', 'Error updating task. Please try again.');
      }
      return res.redirect(`/projects/${projectId}`);
    }
  }

  const title = trim(safeQueryValue(req.body.title));
  const description = trim(safeQueryValue(req.body.description));
  // Raw (unprocessed) value needed for resolveOptionalField so it can detect
  // HPP arrays and present-but-non-string values. Mirrors the project-update
  // route above and the convention used by changes.js / licenses.js / vendors.js.
  const rawDescription = req.body.description;
  // Raw body value (NOT trimmed) so an ABSENT title can be told apart from an
  // explicit empty one — the task title is absent-preserving.
  const rawTitle = req.body.title;

  // Absent-vs-present marker for the task title. An ABSENT title in a partial
  // API submission preserves the stored value (resolved inside the transaction
  // from the re-read row) — the same contract every other field on this route
  // already follows (status, priority, assignee, due date, description). The
  // title was the sole exception: a partial PUT that only changed the
  // assignee was rejected outright with "Task title is required" even though
  // the stored title was perfectly valid. A PRESENT but empty title is still
  // rejected — the column is NOT NULL.
  const titleAbsent = rawTitle === undefined || rawTitle === null;
  if (rawTitle !== undefined && rawTitle !== null && rawTitle !== '' && typeof rawTitle !== 'string') {
    // The app-wide wording for a wrong-typed value. The task CREATE route in
    // this very module already reports the identical submission as "Invalid
    // request parameters", and the enum fields on this route do too — the
    // bespoke "Invalid Task Title" wording made the same type error read
    // differently depending on the verb.
    req.flash('error', 'Invalid request parameters');
    return res.redirect(`/projects/${projectId}`);
  }
  if (!titleAbsent && !title) {
    req.flash('error', 'Task title is required');
    return res.redirect(`/projects/${projectId}`);
  }
  if (!titleAbsent && title.length > MAX_MEDIUM_STR) {
    req.flash('error', `Task title must be at most ${MAX_MEDIUM_STR} characters`);
    return res.redirect(`/projects/${projectId}`);
  }
  if (description && description.length > MAX_DESC) {
    req.flash('error', `Description must be at most ${MAX_DESC} characters`);
    return res.redirect(`/projects/${projectId}`);
  }
  // Fail closed on a present-but-non-string enum value (e.g. a JSON number):
  // trim() coerces it to '', which would skip the enum checks below and leave
  // the field silently preserved with a success flash — inconsistent with the
  // fail-closed convention applied to every other present-but-invalid field
  // on this route. Absent/empty submissions are allowed (preserve stored value).
  // (The quick-status path above already rejects non-string status via a
  // dedicated typeof guard.)
  //
  // `description` is guarded here too: the task CREATE route rejects a
  // wrong-typed description with the app-wide "Invalid request parameters",
  // while the update route used to answer "Invalid Description" for the
  // identical submission — the same column, two messages, depending on the
  // verb. The field-specific wording is now reserved for a whitespace-only
  // VALUE.
  const wrongTypeField = findNonStringField(req.body, ['status', 'priority', 'description']);
  if (wrongTypeField) {
    req.flash('error', 'Invalid request parameters');
    return res.redirect(`/projects/${projectId}`);
  }
  // A present-but-invalid status is rejected; an absent field means
  // "keep what's stored" (resolved inside the transaction). Mirrors the
  // project-update route's status resolution and the absent-vs-empty
  // handling of priority/assignee/due_date/description on this same route —
  // previously an absent status failed validation, rejecting a perfectly valid
  // partial PUT that only renamed a task.
  //
  // The presence test runs against the RAW submitted value, so a
  // present-but-blank enum is rejected rather than silently ignored.
  // `status` is a NOT NULL column (an empty value has no valid meaning);
  // `priority` is nullable with a meaningful default, so an explicit empty
  // value is treated as "not submitted" and the stored priority is preserved.
  const taskStatusEnum = resolveEnumField(req.body.status, VALID_TASK_STATUSES);
  const taskPriorityEnum = resolveEnumField(req.body.priority, VALID_TASK_PRIORITIES);
  if (taskStatusEnum.state === 'blank' || taskStatusEnum.state === 'invalid' || taskStatusEnum.state === 'empty') {
    req.flash('error', 'Invalid Task Status');
    return res.redirect(`/projects/${projectId}`);
  }
  if (taskPriorityEnum.state === 'blank' || taskPriorityEnum.state === 'invalid') {
    req.flash('error', 'Invalid Task Priority');
    return res.redirect(`/projects/${projectId}`);
  }

  // Fail closed on a present-but-malformed assignee id ("abc", "3.5", an HPP
  // array) instead of silently coercing it to NULL via safeId, which would
  // wipe an existing assignment with no user feedback. Absent/empty values
  // legitimately mean "unassigned" (mirrors the owner validation on this
  // resource and the assignee validation in tickets/changes/assets).
  if (isPresentInvalidId(assigned_to)) {
    req.flash('error', 'Invalid Assignee');
    return res.redirect(`/projects/${projectId}`);
  }

  try {
    // Validate assignee inside the transaction so a concurrent deactivation
    // between the check and the UPDATE is not possible.
    // resolvedTaskTitle is hoisted out of the transaction so the audit entry
    // names the EFFECTIVE (resolved) task even when the request omitted it.
    let resolvedTaskTitle = title;
    const updateTask = db.transaction(() => {
      const existingTask = _taskExistsStmt.get(taskId, projectId);
      if (!existingTask) {
        throw new Error('NOT_FOUND');
      }
      // Resolve the assignee against the transaction-consistent re-fetch using the
      // same absent-vs-empty convention as due_date on this route: an ABSENT field
      // (partial API submission) preserves the stored assignee, while an explicit
      // empty string ("Unassigned" in the project page form) clears it (null).
      // Previously an absent field silently wiped the stored assignee —
      // effectiveDueDate preserved on absence, so a partial PUT could drop an
      // assignment by omission.
      const resolvedTaskAssignee = (assigned_to === undefined || assigned_to === null)
        ? (existingTask.assigned_to ?? null)
        : (assigned_to === '' ? null : safeId(assigned_to));
      // Preserve the current (possibly deactivated) assignee when unchanged, so
      // editing an unrelated field on a task whose assignee has since been
      // deactivated does not wipe the stored value (mirrors tickets/assets/changes).
      if (resolvedTaskAssignee && !isActiveUser(db, resolvedTaskAssignee) && Number(resolvedTaskAssignee) !== Number(existingTask.assigned_to)) {
        throw new Error('ASSIGNEE_NOT_AVAILABLE');
      }
      const safeDueDate = safeDate(due_date);
      // Fail-closed: a present but malformed due_date must be rejected rather than
      // silently stored as NULL — consistent with ticket/project/asset date validation.
      if (due_date !== undefined && due_date !== null && due_date !== '' && safeDueDate === null) {
        throw new Error('INVALID_DUE_DATE');
      }
      // Preserve the existing due date when ABSENT on a partial edit, so a
      // hand-crafted PUT that omits due_date cannot silently wipe a stored date.
      // An EMPTY submitted value ('' from a cleared <input type="date">) CLEARS
      // it (null), matching the absent-vs-empty convention used by tickets.js
      // / assets.js / vendors.js / licenses.js / changes.js. Previously empty
      // was treated as "preserve", which made it impossible to clear a task due
      // date via the project page form. Mirrors resolvedStart/resolvedEnd in
      // the project update route above.
      const effectiveDueDate = (due_date === undefined || due_date === null)
        ? existingTask.due_date
        : safeDueDate;
      // Preserve existing priority when absent instead of silently defaulting to
      // 'medium' — partial edits must not overwrite an existing stored priority.
      const effectivePriority = taskPriorityEnum.state === 'valid' ? taskPriorityEnum.value : existingTask.priority;
      // Absent-vs-empty convention for the task description: an explicit empty
      // string in the form wipes it, while an ABSENT field on a partial API
      // submission preserves the stored value. Previously a PUT that omitted
      // description silently nulled it — the inconsistent outlier on a route
      // where assignee, due_date, and priority all preserve on absence. Using
      // resolveOptionalField also rejects present-but-non-string values (e.g.
      // a JSON number) rather than silently clearing the stored value.
      const resolvedTaskDescription = resolveOptionalField(rawDescription, description || null, MAX_DESC, existingTask.description);
      if (resolvedTaskDescription && resolvedTaskDescription.error) {
        throw new Error('INVALID_DESCRIPTION');
      }
      // Preserve the existing status when absent on a partial edit (validated
      // above only when present) and drive the completed_at encoding from the
      // RESOLVED status so a partial edit cannot clobber the completion
      // timestamp of a stored 'done' task.
      const effectiveStatus = taskStatusEnum.state === 'valid' ? taskStatusEnum.value : existingTask.status;
      // The title follows the same absent-vs-present rule as every other field
      // on this route: an absent field preserves the CURRENT stored title
      // (read inside the transaction, so a concurrent rename cannot be
      // clobbered), a present field replaces it.
      const effectiveTitle = titleAbsent ? existingTask.title : title.substring(0, MAX_MEDIUM_STR);
      resolvedTaskTitle = effectiveTitle;
      const params = [effectiveTitle, resolvedTaskDescription, effectiveStatus, effectivePriority, resolvedTaskAssignee, effectiveDueDate, effectiveStatus === 'done' ? 1 : 0, taskId, projectId];
      const result = _taskFullUpdateStmt.run(...params);
      if (result.changes === 0) {
        throw new Error('NOT_FOUND');
      }
    });
    updateTask();

    // Recalculate project progress outside the transaction to avoid holding the
    // SQLite write lock across multiple queries.
    try {
      recalcProjectProgress(db, projectId);
    } catch (err) {
      logError(`Progress recalculation error for project #${projectId}:`, err);
    }

    req.audit('update', 'project_task', taskId, `Updated task "${resolvedTaskTitle}"`);
    req.flash('success', 'Task updated.');
    invalidateDashboardCache();
    return res.redirect(`/projects/${projectId}`);
  } catch (err) {
    if (err.message === 'NOT_FOUND') {
      req.flash('error', 'Task not found');
      return res.redirect(`/projects/${projectId}`);
    }
    if (err.message === 'ASSIGNEE_NOT_AVAILABLE') {
      req.flash('error', 'Selected assignee is not available');
      return res.redirect(`/projects/${projectId}`);
    }
    if (err.message === 'INVALID_DUE_DATE') {
      req.flash('error', 'Invalid Due Date');
      return res.redirect(`/projects/${projectId}`);
    }
    if (err.message === 'INVALID_DESCRIPTION') {
      req.flash('error', 'Invalid Description');
      return res.redirect(`/projects/${projectId}`);
    }
    logError('Project task update error:', err);
    req.flash('error', 'Error updating task. Please try again.');
    return res.redirect(`/projects/${projectId}`);
  }
});

// Delete task
router.delete('/:projectId/tasks/:taskId', requireAdminOrManager, projectWriteLimiter, (req, res) => {
  // Fail closed on HTTP parameter pollution: reject array payloads. Mirrors the
  // array-rejection guards on every other write route in the app.
  const hppErrors = rejectHppArrays(req, ['projectId', 'taskId']);
  if (hppErrors.length > 0) {
    req.flash('error', 'Invalid request parameters');
    return res.redirect('/projects');
  }

  const projectId = safeId(req.params.projectId);
  const taskId = safeId(req.params.taskId);
  if (!projectId || !taskId) {
    req.flash('error', 'Invalid task ID');
    return res.redirect('/projects');
  }

  try {
    const deleteTask = db.transaction(() => {
      const existing = _taskDeleteGetStmt.get(taskId, projectId);
      if (!existing) {
        return { changes: 0, title: null, affectedProject: null };
      }
      const result = _taskDeleteStmt.run(taskId, projectId);
      return { changes: result.changes, title: existing.title, affectedProject: result.changes > 0 ? projectId : null };
    });
    const result = deleteTask();
    // Recalculate project progress outside the transaction to avoid holding the
    // SQLite write lock across multiple sequential queries. Mirrors the pattern
    // used in the task-add and task-full-update routes above.
    if (result.changes > 0 && result.affectedProject != null) {
      try {
        recalcProjectProgress(db, result.affectedProject);
      } catch (err) {
        logError(`Progress recalculation error for project #${result.affectedProject}:`, err);
      }
    }

    if (result.changes === 0) {
      req.flash('error', 'Task not found');
    } else {
      req.audit('delete', 'project_task', taskId, `Deleted task "${result.title}"`);
      req.flash('success', 'Task deleted.');
      invalidateDashboardCache();
    }
    return res.redirect(`/projects/${projectId}`);
  } catch (err) {
    logError('Project task delete error:', err);
    req.flash('error', 'Error deleting task.');
    return res.redirect(`/projects/${projectId}`);
  }
});

// Add member to project
router.post('/:id/members', requireAdminOrManager, projectWriteLimiter, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid project ID');
    return res.redirect('/projects');
  }

  // Fail closed on HTTP parameter pollution: reject array payloads.
  const hppErrors = rejectHppArrays(req, ['user_id', 'role']);
  if (hppErrors.length > 0) {
    req.flash('error', 'Invalid request parameters');
    return res.redirect(`/projects/${id}`);
  }

  const user_id = safeQueryValue(req.body.user_id);
  // Fail closed on a present-but-malformed user id ("5abc", "10.0", a JSON
  // float) — safeId's parseInt coercion would silently target a DIFFERENT
  // valid user. Mirrors the owner/assignee guards everywhere else in the
  // codebase (tickets, assets, changes, and this file's owner/task routes).
  if (isPresentInvalidId(user_id)) {
    req.flash('error', 'Invalid User');
    return res.redirect(`/projects/${id}`);
  }
  try {
    const safeUserId = safeId(user_id);
    if (!safeUserId) {
      req.flash('error', 'Invalid User');
      return res.redirect(`/projects/${id}`);
    }
    // The role is a nullable column with the schema default 'member', so an
    // ABSENT field takes that default — exactly like every sibling create
    // route (a task's status, a change's status, an article's status, a
    // project's status/priority). The route used to REQUIRE the role, and
    // its stated rationale was inverted: it claimed a silent fallback to
    // 'member' "would let a client omit the role field and get a privileged
    // membership", but 'member' is the LEAST privileged of the three roles
    // (lead / member / stakeholder) — the fallback cannot escalate
    // anything. A present-but-blank or unknown role is still rejected: it is
    // neither an absent field nor an allowlisted value.
    // A present-but-non-string role is a TYPE error: it is reported with the
    // app-wide "Invalid request parameters" wording every other create route
    // uses for a wrong-typed body field, not with the enum-specific wording a
    // wrong VALUE gets.
    if (req.body.role !== undefined && req.body.role !== null && req.body.role !== '' && typeof req.body.role !== 'string') {
      req.flash('error', 'Invalid request parameters');
      return res.redirect(`/projects/${id}`);
    }
    const roleEnum = resolveEnumField(req.body.role, VALID_MEMBER_ROLES);
    if (roleEnum.state === 'blank' || roleEnum.state === 'invalid') {
      req.flash('error', 'Invalid Role');
      return res.redirect(`/projects/${id}`);
    }
    const role = roleEnum.state === 'valid' ? roleEnum.value : 'member';

    // Verify project still exists, validate user is active, and add member in a
    // single transaction to avoid TOCTOU races: the project could be deleted or
    // the user deactivated between the checks and the INSERT.
    const addMember = db.transaction(() => {
      if (!_projectExistsStmt.get(id)) {
        throw new Error('PROJECT_NOT_FOUND');
      }
      if (!isActiveUser(db, safeUserId)) {
        throw new Error('USER_NOT_AVAILABLE');
      }
      // Return the inserted row id so the audit log records the real
      // project_member entity id, matching the member-delete audit trail.
      const result = _memberInsertStmt.run(id, safeUserId, role);
      return { changes: result.changes, memberId: result.lastInsertRowid };
    });
    const { changes, memberId } = addMember();

    if (changes === 0) {
      req.flash('info', 'User is already a member of this project.');
    } else {
      req.audit('create', 'project_member', memberId, `Added member #${safeUserId} to project #${id}`);
      req.flash('success', 'Member added.');
      invalidateDashboardCache();
    }
  } catch (err) {
    if (err.message === 'PROJECT_NOT_FOUND') {
      req.flash('error', 'Project not found');
      return res.redirect('/projects');
    }
    if (err.message === 'USER_NOT_AVAILABLE') {
      req.flash('error', 'Selected user is not available');
      return res.redirect(`/projects/${id}`);
    }
    logError('Project member add error:', err);
    req.flash('error', 'Error adding member. Please try again.');
  }
  return res.redirect(`/projects/${id}`);
});

// Remove member from project
router.delete('/:id/members/:memberId', requireAdminOrManager, projectWriteLimiter, (req, res) => {
  // Fail closed on HTTP parameter pollution: reject array payloads. Mirrors the
  // array-rejection guards on every other write route in the app.
  const hppErrors = rejectHppArrays(req, ['id', 'memberId']);
  if (hppErrors.length > 0) {
    req.flash('error', 'Invalid request parameters');
    return res.redirect('/projects');
  }

  const id = safeId(req.params.id);
  const memberId = safeId(req.params.memberId);
  if (!id || !memberId) {
    req.flash('error', 'Invalid member ID');
    return res.redirect('/projects');
  }

  try {
    // Verify project still exists, prevent removing the last lead, and remove
    // member in a single transaction to avoid a TOCTOU race where the project
    // is deleted between the existence check and the DELETE (mirrors the
    // add-member pattern). Guard against removing the only lead member so a
    // project never becomes leaderless.
    const removeMember = db.transaction(() => {
      if (!_projectExistsStmt.get(id)) {
        throw new Error('PROJECT_NOT_FOUND');
      }
      // Check if the member being removed is the last lead. Fetch the member
      // directly (not via _showMembersStmt which has LIMIT) to guarantee the
      // lookup succeeds for any project size.
      const memberRow = _memberByIdStmt.get(memberId, id);
      if (memberRow && memberRow.role === 'lead') {
        const { lead_count } = _leadMemberCountStmt.get(id);
        if (lead_count <= 1) {
          throw new Error('LAST_LEAD');
        }
      }
      return _memberDeleteStmt.run(memberId, id).changes;
    });
    const changes = removeMember();

    if (changes === 0) {
      req.flash('error', 'Member not found');
    } else {
      req.audit('delete', 'project_member', memberId, `Removed member from project #${id}`);
      req.flash('success', 'Member removed.');
      invalidateDashboardCache();
    }
  } catch (err) {
    if (err.message === 'PROJECT_NOT_FOUND') {
      req.flash('error', 'Project not found');
      return res.redirect('/projects');
    }
    if (err.message === 'LAST_LEAD') {
      req.flash('error', 'Cannot remove the last lead member of the project.');
      return res.redirect(`/projects/${id}`);
    }
    logError('Project member remove error:', err);
    req.flash('error', 'Error removing member. Please try again.');
  }
  return res.redirect(`/projects/${id}`);
});

module.exports = router;
module.exports.resetCachedStatements = () => {};
