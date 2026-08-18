const db = require('../models/database');
const { requireAuth, requireAdminOrManager, canAccessResource } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { paginate, paginationBaseUrl, addSearch, buildFilters, safeId, isPresentInvalidId, safePositiveFloat, trim, safeDate, getActiveStaff, isActiveUser, ensureAssigneeInList, recalcProjectProgress, countQuery, selectQuery, safeQueryValue, safeFilters, safeSort, rejectHppArrays, resolveOptionalField, authKeyGenerator } = require('../utils');
const {
  PROJECT_STATUSES: VALID_STATUSES,
  PROJECT_PRIORITIES: VALID_PRIORITIES,
  TASK_STATUSES: VALID_TASK_STATUSES,
  TASK_PRIORITIES: VALID_TASK_PRIORITIES,
  MEMBER_ROLES: VALID_MEMBER_ROLES,
  MAX_MEDIUM_STR, MAX_DESC
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
const _TASK_SHOW_LIMIT = 200;
const _showTasksStmt = db.prepare(`
    SELECT pt.id, pt.title, pt.status, pt.priority, pt.due_date,
      u.first_name || ' ' || u.last_name as assigned_name
    FROM project_tasks pt
    LEFT JOIN users u ON pt.assigned_to = u.id
    WHERE pt.project_id = ?
    ORDER BY CASE pt.status WHEN 'in_progress' THEN 1 WHEN 'todo' THEN 2 WHEN 'review' THEN 3 WHEN 'done' THEN 4 END, CASE pt.priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END, pt.due_date ASC
    LIMIT ${_TASK_SHOW_LIMIT}
  `);
const _showMembersStmt = db.prepare(`
    SELECT pm.id, pm.role, u.first_name || ' ' || u.last_name as member_name
    FROM project_members pm
    JOIN users u ON pm.user_id = u.id
    WHERE pm.project_id = ?
    ORDER BY pm.id ASC
    LIMIT 100
  `);
// Loads the full set of columns the update transaction preserves on partial
// submissions (budget/spent plus status/priority/dates/owner/description).
const _projectUpdateBaseStmt = db.prepare('SELECT budget, spent, status, priority, start_date, end_date, owner_id, description FROM projects WHERE id = ?');
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
const _taskInsertStmt = db.prepare(`
    INSERT INTO project_tasks (project_id, title, description, status, priority, assigned_to, due_date)
    VALUES (?, ?, ?, ?, ?, ?, ?)
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
const _leadMemberCountStmt = db.prepare("SELECT COUNT(*) as lead_count FROM project_members WHERE project_id = ? AND role = 'lead'");

// Cached prepared statement for project select by ID (used in edit route)
const _selectProjectByIdStmt = db.prepare('SELECT id, name, description, status, priority, start_date, end_date, budget, spent, progress, owner_id, created_at, updated_at FROM projects WHERE id = ?');

const _projectInsertStmt = db.prepare(`
    INSERT INTO projects (name, description, status, priority, start_date, end_date, budget, owner_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

// Sort options for the projects list route. Mirrors the pattern used in
// tickets.js / assets.js / audit.js — safeSort validates the key against
// the map and falls back to 'default' if unknown.
const SORT_MAP = Object.freeze({
  newest: 'p.updated_at DESC',
  oldest: 'p.updated_at ASC',
  name: 'p.name ASC',
  priority: "CASE p.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 END, p.updated_at DESC",
  default: 'p.updated_at DESC'
});

// List projects (paginated)
router.get('/', (req, res) => {
  const { page: requestedPage, limit } = paginate(req);

  const qStatus = safeQueryValue(req.query.status);
  const qPriority = safeQueryValue(req.query.priority);
  const filters = buildFilters({
    'p.status': { value: VALID_STATUSES.includes(qStatus) ? qStatus : '' },
    'p.priority': { value: VALID_PRIORITIES.includes(qPriority) ? qPriority : '' }
  }, ['p.status', 'p.priority']);

  const where = [...filters.where];
  const params = [...filters.params];
  addSearch(where, params, safeQueryValue(req.query.search), ['p.name', 'p.description']);

  const whereClause = where.length ? where.join(' AND ') : '1=1';
  const orderBy = safeSort(safeQueryValue(req.query.sort), SORT_MAP, 'default');

  const total = countQuery(db, 'projects', 'p', whereClause, params);
  const totalPages = Math.ceil(total / limit) || 1;
  // Clamp the requested page to the actual page count so a page beyond the
  // last one (e.g. ?page=999) renders the final page instead of an empty list
  // with a broken "Showing N–M" range (M < N) in the pagination partial.
  const page = Math.min(requestedPage, totalPages);
  const offset = (page - 1) * limit;

  // Use LEFT JOIN with conditional aggregation instead of correlated subqueries
  // for task counts — avoids N+1 query pattern on large project lists.
  const projects = selectQuery(db, `
    SELECT p.id, p.name, p.description, p.status, p.priority, p.start_date, p.end_date,
      p.budget, p.spent, p.progress, p.created_at, p.updated_at,
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

  res.render('pages/projects/index', {
    title: 'Projects', projects,
    filters: safeFilters(req.query, ['search', 'status', 'priority']),
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
  const hppErrors = rejectHppArrays(req, ['name', 'description', 'status', 'priority', 'start_date', 'end_date', 'budget', 'owner_id']);
  if (hppErrors.length > 0) {
    req.flash('error', 'Invalid request parameters');
    return res.redirect('/projects/new');
  }

  const name = trim(safeQueryValue(req.body.name));
  const description = trim(safeQueryValue(req.body.description));
  const status = trim(safeQueryValue(req.body.status));
  const priority = trim(safeQueryValue(req.body.priority));
  const start_date = safeQueryValue(req.body.start_date);
  const end_date = safeQueryValue(req.body.end_date);
  const budget = safeQueryValue(req.body.budget);
  const owner_id = safeQueryValue(req.body.owner_id);

  if (!name) {
    req.flash('error', 'Project name is required');
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

  if (!status || !VALID_STATUSES.includes(status)) {
    req.flash('error', 'Invalid status');
    return res.redirect('/projects/new');
  }
  if (!priority || !VALID_PRIORITIES.includes(priority)) {
    req.flash('error', 'Invalid priority');
    return res.redirect('/projects/new');
  }

  const sStart = safeDate(start_date);
  const sEnd = safeDate(end_date);
  // Reject malformed (non-empty, non-parseable) dates instead of silently
  // storing NULL. Empty input is allowed (falls back to NULL); only a present
  // value that fails to parse is an error. Mirrors the strict date validation
  // in changes.js (_resolveDateTimeField) and licenses.js.
  if (start_date !== undefined && start_date !== null && start_date !== '' && sStart === null) {
    req.flash('error', 'Invalid start date');
    return res.redirect('/projects/new');
  }
  if (end_date !== undefined && end_date !== null && end_date !== '' && sEnd === null) {
    req.flash('error', 'Invalid end date');
    return res.redirect('/projects/new');
  }
  if (sStart && sEnd && sEnd < sStart) {
    req.flash('error', 'End date must be on or after start date');
    return res.redirect('/projects/new');
  }

  // Fail closed on malformed budget (LOW). A present, non-empty budget that
  // fails to parse must be rejected rather than silently coerced to 0, which
  // would drop a legitimate budget on a typo'd submission. An empty/omitted
  // budget is allowed (falls back to 0, consistent with the update path's
  // Infinity-sentinel handling). Mirrors the projects UPDATE path (2nd pass).
  let safeBudget;
  if (budget === undefined || budget === null || budget === '') {
    safeBudget = 0;
  } else {
    safeBudget = safePositiveFloat(budget, Infinity);
    if (!Number.isFinite(safeBudget)) {
      req.flash('error', 'Invalid budget amount');
      return res.redirect('/projects/new');
    }
  }

  // Validate owner is an active user
  // Fail closed on a present-but-malformed owner id ("abc", "3.5", an HPP
  // array) instead of silently coercing it to NULL via safeId, which would
  // store the project unassigned with no user feedback. Absent/empty values
  // legitimately mean "no owner".
  if (isPresentInvalidId(owner_id)) {
    req.flash('error', 'Invalid owner');
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
      return _projectInsertStmt.run(name.substring(0, MAX_MEDIUM_STR), (description || '').substring(0, MAX_DESC) || null, status, priority,
        sStart, sEnd, safeBudget, safeOwnerId);
    });
    const result = createProject();

    req.audit('create', 'project', result.lastInsertRowid, `Created project ${name}`);
    req.flash('success', 'Project created successfully');
    invalidateDashboardCache();
    return res.redirect(`/projects/${result.lastInsertRowid}`);
  } catch (err) {
    if (err.message === 'OWNER_NOT_AVAILABLE') {
      req.flash('error', 'Selected owner is not available');
      return res.redirect('/projects/new');
    }
    console.error('Project create error:', err.message);
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
    req.flash('error', 'You do not have permission to view this project');
    return res.redirect('/projects');
  }

  req.audit('read', 'project', id, `Viewed project: ${project.name}`);

  const tasks = _showTasksStmt.all(id);

  const members = _showMembersStmt.all(id);

  const staff = getActiveStaff(db);

  res.render('pages/projects/show', { title: project.name, project, tasks, members, staff });
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
  const status = trim(safeQueryValue(req.body.status));
  const priority = trim(safeQueryValue(req.body.priority));
  const start_date = safeQueryValue(req.body.start_date);
  const end_date = safeQueryValue(req.body.end_date);
  const budget = safeQueryValue(req.body.budget);
  const spent = safeQueryValue(req.body.spent);
  const owner_id = safeQueryValue(req.body.owner_id);

  if (!name) {
    req.flash('error', 'Project name is required');
    return res.redirect(`/projects/${id}/edit`);
  }
  if (name.length > MAX_MEDIUM_STR) {
    req.flash('error', `Project name must be at most ${MAX_MEDIUM_STR} characters`);
    return res.redirect(`/projects/${id}/edit`);
  }
  // Allow empty status to preserve the existing value inside the transaction.
  // A present-but-invalid status is rejected; an absent field means "keep what's stored."
  const statusProvided = !!status;
  if (statusProvided && !VALID_STATUSES.includes(status)) {
    req.flash('error', 'Invalid status');
    return res.redirect(`/projects/${id}/edit`);
  }
  if (priority && !VALID_PRIORITIES.includes(priority)) {
    req.flash('error', 'Invalid priority');
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
      req.flash('error', 'Invalid start date');
      return res.redirect(`/projects/${id}/edit`);
    }
    if (end_date !== undefined && end_date !== null && end_date !== '' && sEnd === null) {
      req.flash('error', 'Invalid end date');
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
      req.flash('error', 'Invalid owner');
      return res.redirect(`/projects/${id}/edit`);
    }

    // Verify project exists, validate owner, and update in a single transaction
    // to avoid TOCTOU races: the project could be deleted or the owner deactivated
    // between the checks and the UPDATE.
    const updateProject = db.transaction(() => {
      // Fetch existing budget/spent/status/priority inside the transaction to
      // preserve values when the submitted fields are absent, eliminating a
      // TOCTOU race where these fields are modified between the SELECT and the
      // UPDATE.
      const existingProject = _projectUpdateBaseStmt.get(id);
      if (!existingProject) {
        throw new Error('NOT_FOUND');
      }
      const effectiveStatus = statusProvided ? status : existingProject.status;
      const effectivePriority = priority || existingProject.priority;

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

      // Distinguish "field not submitted" (preserve stored value) from
      // "field submitted with an invalid/empty value" (fail closed — reject
      // rather than silently keep the old value). Using Infinity as the
      // fallback sentinel lets safePositiveFloat signal invalid input without
      // masking it as a legitimate 0, so an empty budget/spent can no longer
      // be silently ignored and a typo'd value is surfaced to the user.
      let preservedSpent;
      if (spent === undefined || spent === null || spent === '') {
        // Preserve existing value (including NULL) rather than defaulting to 0.
        // Using ?? null ensures that a stored NULL stays NULL on partial edits.
        // See similar patterns in assets.js, vendors.js, licenses.js.
        preservedSpent = existingProject.spent ?? null;
      } else {
        preservedSpent = safePositiveFloat(spent, Infinity);
        if (!Number.isFinite(preservedSpent)) {
          throw Object.assign(new Error('INVALID_SPENT'), { flash: 'Invalid amount spent' });
        }
      }
      let preservedBudget;
      if (budget === undefined || budget === null || budget === '') {
        // Preserve existing value (including NULL) rather than defaulting to 0.
        // Using ?? null ensures that a stored NULL stays NULL on partial edits.
        preservedBudget = existingProject.budget ?? null;
      } else {
        preservedBudget = safePositiveFloat(budget, Infinity);
        if (!Number.isFinite(preservedBudget)) {
          throw Object.assign(new Error('INVALID_BUDGET'), { flash: 'Invalid budget amount' });
        }
      }

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

      const result = _projectUpdateStmt.run(name.substring(0, MAX_MEDIUM_STR), resolvedDescription, effectiveStatus, effectivePriority, resolvedStart, resolvedEnd,
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
      console.error(`Progress recalculation error for project #${id}:`, err.message);
    }

    req.audit('update', 'project', id, `Updated project ${name}`);
    req.flash('success', 'Project updated successfully');
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
      req.flash('error', 'Invalid description');
      return res.redirect(`/projects/${id}/edit`);
    }
    console.error('Project update error:', err.message);
    req.flash('error', 'Error updating project. Please try again.');
    return res.redirect(`/projects/${id}/edit`);
  }
});

// Delete project (with tasks & members in transaction)
router.delete('/:id', requireAdminOrManager, projectWriteLimiter, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid project ID');
    return res.redirect('/projects');
  }

  try {
    const deleteProject = db.transaction(() => {
      const existing = _showProjectStmt.get(id);
      _deleteProjectTasksStmt.run(id);
      _deleteProjectMembersStmt.run(id);
      const changes = _deleteProjectStmt.run(id).changes;
      return { changes, name: existing ? existing.name : null };
    });
    const result = deleteProject();
    if (result.changes === 0) {
      req.flash('error', 'Project not found');
    } else {
      req.audit('delete', 'project', id, `Deleted project "${result.name}"`);
      req.flash('success', 'Project deleted');
      invalidateDashboardCache();
    }
  } catch (err) {
    console.error('Project delete error:', err.message);
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
  const status = safeQueryValue(req.body.status);
  const priority = safeQueryValue(req.body.priority);
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
  if (status && !VALID_TASK_STATUSES.includes(status)) {
    req.flash('error', 'Invalid task status');
    return res.redirect(`/projects/${projectId}`);
  }
  if (priority && !VALID_TASK_PRIORITIES.includes(priority)) {
    req.flash('error', 'Invalid task priority');
    return res.redirect(`/projects/${projectId}`);
  }

  // Fail closed on a present-but-malformed assignee id ("abc", "3.5", an HPP
  // array) instead of silently coercing it to NULL via safeId, which would
  // create the task unassigned with no user feedback. Absent/empty values
  // legitimately mean "unassigned" (mirrors the owner validation on this
  // resource and the assignee validation in tickets/changes/assets).
  if (isPresentInvalidId(assigned_to)) {
    req.flash('error', 'Invalid assignee');
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
      const result = _taskInsertStmt.run(projectId, title.substring(0, MAX_MEDIUM_STR), (description || '').substring(0, MAX_DESC) || null, status || 'todo', priority || 'medium', safeTaskAssignee, safeDueDate);

      return result.lastInsertRowid;
    });
    const taskId = addTask();

    // Recalculate project progress outside the transaction to avoid holding the
    // SQLite write lock across multiple queries.
    try {
      recalcProjectProgress(db, projectId);
    } catch (err) {
      console.error(`Progress recalculation error for project #${projectId}:`, err.message);
    }

    req.audit('create', 'project_task', taskId, `Added task "${title}" to project #${projectId}`);
    req.flash('success', 'Task added');
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
      req.flash('error', 'Invalid due date');
      return res.redirect(`/projects/${projectId}`);
    }
    console.error('Project task add error:', err.message);
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

  const status = safeQueryValue(req.body.status);
  const priority = safeQueryValue(req.body.priority);
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
    // valid no-op.
    if (typeof status !== 'string' || !VALID_TASK_STATUSES.includes(status)) {
      req.flash('error', 'Invalid task status');
      return res.redirect(`/projects/${projectId}`);
    }
    // Quick status update only — read current status and update atomically
    // inside a single transaction to avoid a TOCTOU where a concurrent change
    // between the read and the UPDATE is silently overwritten.
    try {
      const updateTask = db.transaction(() => {
        const existing = _taskExistsStmt.get(taskId, projectId);
        if (!existing) {
          throw new Error('NOT_FOUND');
        }
        const safeStatus = VALID_TASK_STATUSES.includes(status) ? status : existing.status;
        if (safeStatus === existing.status) {
          return { unchanged: true };
        }
        const result = _taskQuickStatusStmt.run(safeStatus, safeStatus === 'done' ? 1 : 0, taskId, projectId);
        if (result.changes === 0) {
          throw new Error('NOT_FOUND');
        }
        return { unchanged: false, status: safeStatus };
      });
      const result = updateTask();

      if (result.unchanged) {
        req.flash('info', 'Status unchanged');
      } else {
        // Recalculate project progress outside the transaction to avoid holding the
        // SQLite write lock across multiple queries. Runs only when the status
        // actually changed — a no-op submission must not bump the project's
        // updated_at (which would reorder it under "newest" sorting) or rewrite
        // progress when nothing changed.
        try {
          recalcProjectProgress(db, projectId);
        } catch (err) {
          console.error(`Progress recalculation error for project #${projectId}:`, err.message);
        }
        // Audit the quick-status change — previously this path silently skipped
        // audit logging, so a task toggled to 'done' via the project page left
        // no trail even though the full edit route logged 'update' for the same
        // entity. The full-update branch below already audits; this mirrors it.
        req.audit('update', 'project_task', taskId, `Quick status change to ${result.status}`);
        req.flash('success', 'Task updated');
        invalidateDashboardCache();
      }
      return res.redirect(`/projects/${projectId}`);
    } catch (err) {
      if (err.message === 'NOT_FOUND') {
        req.flash('error', 'Task not found');
      } else {
        console.error('Project task quick-status error:', err.message);
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
  if (!VALID_TASK_STATUSES.includes(status)) {
    req.flash('error', 'Invalid task status');
    return res.redirect(`/projects/${projectId}`);
  }
  if (priority && !VALID_TASK_PRIORITIES.includes(priority)) {
    req.flash('error', 'Invalid task priority');
    return res.redirect(`/projects/${projectId}`);
  }

  // Fail closed on a present-but-malformed assignee id ("abc", "3.5", an HPP
  // array) instead of silently coercing it to NULL via safeId, which would
  // wipe an existing assignment with no user feedback. Absent/empty values
  // legitimately mean "unassigned" (mirrors the owner validation on this
  // resource and the assignee validation in tickets/changes/assets).
  if (isPresentInvalidId(assigned_to)) {
    req.flash('error', 'Invalid assignee');
    return res.redirect(`/projects/${projectId}`);
  }

  try {
    // Validate assignee inside the transaction so a concurrent deactivation
    // between the check and the UPDATE is not possible.
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
      const effectivePriority = priority || existingTask.priority;
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
      const params = [title.substring(0, MAX_MEDIUM_STR), resolvedTaskDescription, status, effectivePriority, resolvedTaskAssignee, effectiveDueDate, status === 'done' ? 1 : 0, taskId, projectId];
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
      console.error(`Progress recalculation error for project #${projectId}:`, err.message);
    }

    req.audit('update', 'project_task', taskId, `Updated task "${title}"`);
    req.flash('success', 'Task updated');
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
      req.flash('error', 'Invalid due date');
      return res.redirect(`/projects/${projectId}`);
    }
    if (err.message === 'INVALID_DESCRIPTION') {
      req.flash('error', 'Invalid description');
      return res.redirect(`/projects/${projectId}`);
    }
    console.error('Project task update error:', err.message);
    req.flash('error', 'Error updating task. Please try again.');
    return res.redirect(`/projects/${projectId}`);
  }
});

// Delete task
router.delete('/:projectId/tasks/:taskId', requireAdminOrManager, projectWriteLimiter, (req, res) => {
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
    // Recalculate project progress outside the transaction so SQLite's write
    // lock is not held across multiple sequential queries. Mirrors the pattern
    // used in the task-add and task-full-update routes below.
    if (result.changes > 0 && result.affectedProject != null) {
      try {
        recalcProjectProgress(db, result.affectedProject);
      } catch (err) {
        console.error(`Progress recalculation error for project #${result.affectedProject}:`, err.message);
      }
    }

    if (result.changes === 0) {
      req.flash('error', 'Task not found');
    } else {
      req.audit('delete', 'project_task', taskId, `Deleted task "${result.title}"`);
      req.flash('success', 'Task deleted');
      invalidateDashboardCache();
    }
    return res.redirect(`/projects/${projectId}`);
  } catch (err) {
    console.error('Project task delete error:', err.message);
    req.flash('error', 'Error deleting task. Please try again.');
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
  const role = safeQueryValue(req.body.role);
  // Fail closed on a present-but-malformed user id ("5abc", "10.0", a JSON
  // float) — safeId's parseInt coercion would silently target a DIFFERENT
  // valid user. Mirrors the owner/assignee guards everywhere else in the
  // codebase (tickets, assets, changes, and this file's owner/task routes).
  if (isPresentInvalidId(user_id)) {
    req.flash('error', 'Invalid user');
    return res.redirect(`/projects/${id}`);
  }
  try {
    const safeUserId = safeId(user_id);
    if (!safeUserId) {
      req.flash('error', 'Invalid user');
      return res.redirect(`/projects/${id}`);
    }
    // Fail closed on absent or invalid role — silent fallback to 'member' would
    // let a client omit the role field and get a privileged membership without
    // explicit intent. Consistent with the fail-closed enum pattern used everywhere
    // else in the route (e.g. task priority, ticket status, staff role).
    if (!role || !VALID_MEMBER_ROLES.includes(role)) {
      req.flash('error', 'Invalid role');
      return res.redirect(`/projects/${id}`);
    }

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
      req.flash('info', 'User is already a member of this project');
    } else {
      req.audit('create', 'project_member', memberId, `Added member #${safeUserId} to project #${id}`);
      req.flash('success', 'Member added');
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
    console.error('Project member add error:', err.message);
    req.flash('error', 'Error adding member. Please try again.');
  }
  return res.redirect(`/projects/${id}`);
});

// Remove member from project
router.delete('/:id/members/:memberId', requireAdminOrManager, projectWriteLimiter, (req, res) => {
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
      req.flash('success', 'Member removed');
      invalidateDashboardCache();
    }
  } catch (err) {
    if (err.message === 'PROJECT_NOT_FOUND') {
      req.flash('error', 'Project not found');
      return res.redirect('/projects');
    }
    if (err.message === 'LAST_LEAD') {
      req.flash('error', 'Cannot remove the last lead member of the project');
      return res.redirect(`/projects/${id}`);
    }
    console.error('Project member remove error:', err.message);
    req.flash('error', 'Error removing member. Please try again.');
  }
  return res.redirect(`/projects/${id}`);
});

/**
 * Reset module-level cached prepared statements (test use only).
 * Ensures test isolation when using mock db instances — consistent with
 * the same-named export in middleware/auth.js, audit.js, utils.js, etc.
 */
function resetCachedStatements() {
  // All cached statements are module-level const bindings from db.prepare(),
  // so there is no lazy-init to null out — the cache is unused when
  // the db mock is swapped. This function exists for API consistency
  // across all route modules.
}

module.exports = router;
module.exports.resetCachedStatements = resetCachedStatements;
