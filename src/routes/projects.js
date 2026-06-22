const db = require('../models/database');
const { requireAuth, requireAdminOrManager } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { paginate, paginationBaseUrl, addSearch, buildFilters, safeId, safePositiveFloat, trim, safeDate, getActiveStaff, isActiveUser, recalcProjectProgress, countQuery } = require('../utils');
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
  message: 'Too many project operations. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});

const router = require('express').Router();
router.use(requireAuth, auditMiddleware);

// Cached prepared statements for show/edit routes (static SQL).
const _showProjectStmt = db.prepare(`
    SELECT p.*, u.first_name || ' ' || u.last_name as owner_name
    FROM projects p
    LEFT JOIN users u ON p.owner_id = u.id
    WHERE p.id = ?
  `);
const _showTasksStmt = db.prepare(`
    SELECT pt.*, u.first_name || ' ' || u.last_name as assigned_name
    FROM project_tasks pt
    LEFT JOIN users u ON pt.assigned_to = u.id
    WHERE pt.project_id = ?
    ORDER BY CASE pt.status WHEN 'in_progress' THEN 1 WHEN 'todo' THEN 2 WHEN 'review' THEN 3 WHEN 'done' THEN 4 END, CASE pt.priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END, pt.due_date ASC
  `);
const _showMembersStmt = db.prepare(`
    SELECT pm.*, u.first_name || ' ' || u.last_name as member_name, u.email, u.role as user_role
    FROM project_members pm
    JOIN users u ON pm.user_id = u.id
    WHERE pm.project_id = ?
  `);
const _projectExistStmt = db.prepare('SELECT spent, progress FROM projects WHERE id = ?');
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
const _taskExistStmt = db.prepare('SELECT * FROM project_tasks WHERE id = ? AND project_id = ?');
const _taskQuickStatusStmt = db.prepare(`
    UPDATE project_tasks SET status = ?,
      completed_at = CASE WHEN ? THEN datetime('now') ELSE NULL END,
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

// Cached prepared statements for member routes
const _memberInsertStmt = db.prepare('INSERT OR IGNORE INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)');
const _memberDeleteStmt = db.prepare('DELETE FROM project_members WHERE id = ? AND project_id = ?');

// Cached prepared statement for project select by ID (used in edit route)
const _selectProjectByIdStmt = db.prepare('SELECT * FROM projects WHERE id = ?');

const _projectInsertStmt = db.prepare(`
    INSERT INTO projects (name, description, status, priority, start_date, end_date, budget, owner_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

// List projects (paginated)
router.get('/', (req, res) => {
  const { page, limit, offset } = paginate(req);

  const filters = buildFilters({
    'p.status': { value: VALID_STATUSES.includes(req.query.status) ? req.query.status : '' },
    'p.priority': { value: VALID_PRIORITIES.includes(req.query.priority) ? req.query.priority : '' }
  }, ['p.status', 'p.priority']);

  const where = [...filters.where];
  const params = [...filters.params];
  addSearch(where, params, req.query.search, ['p.name', 'p.description']);

  const whereClause = where.length ? where.join(' AND ') : '1=1';

  const total = countQuery(db, 'projects', 'p', whereClause, params);
  const totalPages = Math.ceil(total / limit) || 1;

  // Use LEFT JOIN with conditional aggregation instead of correlated subqueries
  // for task counts — avoids N+1 query pattern on large project lists.
  const projects = db.prepare(`
    SELECT p.*, u.first_name || ' ' || u.last_name as owner_name,
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
    ORDER BY p.updated_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  res.render('pages/projects/index', {
    title: 'Projects', projects, filters: req.query,
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
  const name = trim(req.body.name);
  const description = trim(req.body.description);
  const { status, priority, start_date, end_date, budget, owner_id } = req.body;

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
  if (sStart && sEnd && sEnd < sStart) {
    req.flash('error', 'End date must be on or after start date');
    return res.redirect('/projects/new');
  }

  // Validate owner is an active user
  const safeOwnerId = owner_id ? safeId(owner_id) : null;
  if (safeOwnerId && !isActiveUser(db, safeOwnerId)) {
    req.flash('error', 'Selected owner is not available');
    return res.redirect('/projects/new');
  }

  try {
    const result = _projectInsertStmt.run(name.substring(0, MAX_MEDIUM_STR), (description || '').substring(0, MAX_DESC) || null, status, priority,
      sStart, sEnd, budget ? safePositiveFloat(budget, 0) : 0, safeOwnerId);

    req.audit('create', 'project', result.lastInsertRowid, `Created project ${name}`);
    req.flash('success', 'Project created successfully');
    invalidateDashboardCache();
    res.redirect(`/projects/${result.lastInsertRowid}`);
  } catch (err) {
    console.error('Project create error:', err.message);
    req.flash('error', 'Error creating project. Please try again.');
    res.redirect('/projects/new');
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
  const staff = getActiveStaff(db);
  res.render('pages/projects/form', { title: 'Edit Project', project, staff, isEdit: true });
});

// Update project
router.put('/:id', requireAdminOrManager, projectWriteLimiter, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid project ID');
    return res.redirect('/projects');
  }

  const name = trim(req.body.name);
  const description = trim(req.body.description);
  const { status, priority, start_date, end_date, budget, spent, owner_id } = req.body;

  if (!name) {
    req.flash('error', 'Project name is required');
    return res.redirect(`/projects/${id}/edit`);
  }
  if (name.length > MAX_MEDIUM_STR) {
    req.flash('error', `Project name must be at most ${MAX_MEDIUM_STR} characters`);
    return res.redirect(`/projects/${id}/edit`);
  }
  if (!VALID_STATUSES.includes(status)) {
    req.flash('error', 'Invalid status');
    return res.redirect(`/projects/${id}/edit`);
  }
  if (!VALID_PRIORITIES.includes(priority)) {
    req.flash('error', 'Invalid priority');
    return res.redirect(`/projects/${id}/edit`);
  }
  if (description && description.length > MAX_DESC) {
    req.flash('error', `Description must be at most ${MAX_DESC} characters`);
    return res.redirect(`/projects/${id}/edit`);
  }

  try {
    // Verify project exists before updating
    const existingProject = _projectExistStmt.get(id);
    if (!existingProject) {
      req.flash('error', 'Project not found');
      return res.redirect('/projects');
    }
    const safeSpent = spent !== undefined && spent !== '' ? safePositiveFloat(spent, 0) : existingProject.spent;

    const sStart = safeDate(start_date);
    const sEnd = safeDate(end_date);
    if (sStart && sEnd && sEnd < sStart) {
      req.flash('error', 'End date must be on or after start date');
      return res.redirect(`/projects/${id}/edit`);
    }

    // Validate owner is an active user
    const safeOwnerId = owner_id ? safeId(owner_id) : null;
    if (safeOwnerId && !isActiveUser(db, safeOwnerId)) {
      req.flash('error', 'Selected owner is not available');
      return res.redirect(`/projects/${id}/edit`);
    }

    const updateProject = db.transaction(() => {
      const result = _projectUpdateStmt.run(name.substring(0, MAX_MEDIUM_STR), (description || '').substring(0, MAX_DESC) || null, status, priority, sStart, sEnd,
        budget ? safePositiveFloat(budget, 0) : 0, safeSpent, safeOwnerId, id);
      if (result.changes === 0) {
        throw new Error('NOT_FOUND');
      }
      recalcProjectProgress(db, id);
    });
    updateProject();

    req.audit('update', 'project', id, `Updated project ${name}`);
    req.flash('success', 'Project updated successfully');
    invalidateDashboardCache();
  } catch (err) {
    if (err.message === 'NOT_FOUND') {
      req.flash('error', 'Project not found');
      return res.redirect('/projects');
    }
    console.error('Project update error:', err.message);
    req.flash('error', 'Error updating project. Please try again.');
  }
  res.redirect(`/projects/${id}`);
});

// Delete project (with tasks & members in transaction)
router.delete('/:id', requireAdminOrManager, projectWriteLimiter, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid project ID');
    return res.redirect('/projects');
  }

  try {
    let changes = 0;
    const deleteProject = db.transaction(() => {
      _deleteProjectTasksStmt.run(id);
      _deleteProjectMembersStmt.run(id);
      const result = _deleteProjectStmt.run(id);
      changes = result.changes;
    });
    deleteProject();
    if (changes === 0) {
      req.flash('error', 'Project not found');
    } else {
      req.audit('delete', 'project', id, 'Deleted project and related tasks/members');
      req.flash('success', 'Project deleted');
      invalidateDashboardCache();
    }
  } catch (err) {
    console.error('Project delete error:', err.message);
    req.flash('error', 'Error deleting project');
  }
  res.redirect('/projects');
});

// Add task to project
router.post('/:id/tasks', requireAdminOrManager, projectWriteLimiter, (req, res) => {
  const projectId = safeId(req.params.id);
  if (!projectId) {
    req.flash('error', 'Invalid project ID');
    return res.redirect('/projects');
  }

  // Verify the project exists before inserting a task
  const projectExists = _projectExistStmt.get(projectId);
  if (!projectExists) {
    req.flash('error', 'Project not found');
    return res.redirect('/projects');
  }

  const title = trim(req.body.title);
  const description = trim(req.body.description);
  const { status, priority, assigned_to, due_date } = req.body;

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

  try {
    const safeTaskAssignee = assigned_to ? safeId(assigned_to) : null;
    if (safeTaskAssignee && !isActiveUser(db, safeTaskAssignee)) {
      req.flash('error', 'Selected assignee is not available');
      return res.redirect(`/projects/${projectId}`);
    }
    const addTask = db.transaction(() => {
      const result = _taskInsertStmt.run(projectId, title.substring(0, MAX_MEDIUM_STR), (description || '').substring(0, MAX_DESC) || null, VALID_TASK_STATUSES.includes(status) ? status : 'todo', VALID_TASK_PRIORITIES.includes(priority) ? priority : 'medium', safeTaskAssignee, safeDate(due_date));

      recalcProjectProgress(db, projectId);
      return result.lastInsertRowid;
    });
    const taskId = addTask();

    req.audit('create', 'project_task', taskId, `Added task "${title}" to project #${projectId}`);
    req.flash('success', 'Task added');
    invalidateDashboardCache();
  } catch (err) {
    console.error('Project task add error:', err.message);
    req.flash('error', 'Error adding task. Please try again.');
  }
  res.redirect(`/projects/${projectId}`);
});

// Update task
router.put('/:projectId/tasks/:taskId', requireAdminOrManager, projectWriteLimiter, (req, res) => {
  const projectId = safeId(req.params.projectId);
  const taskId = safeId(req.params.taskId);
  if (!projectId || !taskId) {
    req.flash('error', 'Invalid ID');
    return res.redirect('/projects');
  }

  const title = trim(req.body.title);
  const description = trim(req.body.description);
  const { status, priority, assigned_to, due_date } = req.body;

  // Defensive: handle quick-status-change forms that only send `status`.
  // Uses a dedicated `_quick_status` flag sent by the EJS template so a
  // client cannot force the quick path by omitting the title from a full edit.
  if (req.body._quick_status) {
    // Quick status update only — preserve existing values
    try {
      const existing = _taskExistStmt.get(taskId, projectId);
      if (!existing) {
        req.flash('error', 'Task not found');
        return res.redirect(`/projects/${projectId}`);
      }
      const safeStatus = VALID_TASK_STATUSES.includes(status) ? status : existing.status;
      if (safeStatus === existing.status) {
        req.flash('info', 'Status unchanged');
        return res.redirect(`/projects/${projectId}`);
      }
      const updateTask = db.transaction(() => {
        _taskQuickStatusStmt.run(safeStatus, safeStatus === 'done' ? 1 : 0, taskId, projectId);
        recalcProjectProgress(db, projectId);
      });
      updateTask();
      req.flash('success', 'Task updated');
    } catch (err) {
      console.error('Project task quick-status error:', err.message);
      req.flash('error', 'Error updating task');
    }
    return res.redirect(`/projects/${projectId}`);
  }

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

  try {
    const safeTaskAssignee = assigned_to ? safeId(assigned_to) : null;
    if (safeTaskAssignee && !isActiveUser(db, safeTaskAssignee)) {
      req.flash('error', 'Selected assignee is not available');
      return res.redirect(`/projects/${projectId}`);
    }
    const updateTask = db.transaction(() => {
      const params = [title.substring(0, MAX_MEDIUM_STR), description.substring(0, MAX_DESC) || null, status, priority || 'medium', safeTaskAssignee, safeDate(due_date), status === 'done' ? 1 : 0, taskId, projectId];
      const result = _taskFullUpdateStmt.run(...params);
      if (result.changes === 0) {
        throw new Error('NOT_FOUND');
      }
      recalcProjectProgress(db, projectId);
    });
    updateTask();

    req.audit('update', 'project_task', taskId, `Updated task "${title}"`);
    req.flash('success', 'Task updated');
    invalidateDashboardCache();
  } catch (err) {
    if (err.message === 'NOT_FOUND') {
      req.flash('error', 'Task not found');
      return res.redirect(`/projects/${projectId}`);
    }
    console.error('Project task update error:', err.message);
    req.flash('error', 'Error updating task');
  }
  res.redirect(`/projects/${projectId}`);
});

// Delete task
router.delete('/:projectId/tasks/:taskId', requireAdminOrManager, projectWriteLimiter, (req, res) => {
  const projectId = safeId(req.params.projectId);
  const taskId = safeId(req.params.taskId);
  if (!projectId || !taskId) {
    req.flash('error', 'Invalid ID');
    return res.redirect('/projects');
  }

  try {
    let changes = 0;
    const deleteTask = db.transaction(() => {
      const result = _taskDeleteStmt.run(taskId, projectId);
      changes = result.changes;
      if (changes > 0) {
        recalcProjectProgress(db, projectId);
      }
    });
    deleteTask();

    if (changes === 0) {
      req.flash('error', 'Task not found');
    } else {
      req.audit('delete', 'project_task', taskId, 'Deleted task');
      req.flash('success', 'Task deleted');
      invalidateDashboardCache();
    }
  } catch (err) {
    console.error('Project task delete error:', err.message);
    req.flash('error', 'Error deleting task');
  }
  res.redirect(`/projects/${projectId}`);
});

// Add member to project
router.post('/:id/members', requireAdminOrManager, projectWriteLimiter, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid project ID');
    return res.redirect('/projects');
  }
  const { user_id, role } = req.body;
  try {
    const safeUserId = safeId(user_id);
    if (!safeUserId) {
      req.flash('error', 'Invalid user');
      return res.redirect(`/projects/${id}`);
    }
    if (!isActiveUser(db, safeUserId)) {
      req.flash('error', 'Selected user is not available');
      return res.redirect(`/projects/${id}`);
    }
    const safeRole = VALID_MEMBER_ROLES.includes(role) ? role : 'member';
    const result = _memberInsertStmt.run(id, safeUserId, safeRole);
    if (result.changes === 0) {
      req.flash('info', 'User is already a member of this project');
    } else {
      req.audit('create', 'project_member', null, `Added member #${user_id} to project #${id}`);
      req.flash('success', 'Member added');
    }
  } catch (err) {
    console.error('Project member add error:', err.message);
    req.flash('error', 'Error adding member');
  }
  res.redirect(`/projects/${id}`);
});

// Remove member from project
router.delete('/:id/members/:memberId', requireAdminOrManager, projectWriteLimiter, (req, res) => {
  const id = safeId(req.params.id);
  const memberId = safeId(req.params.memberId);
  if (!id || !memberId) {
    req.flash('error', 'Invalid ID');
    return res.redirect('/projects');
  }

  try {
    const result = _memberDeleteStmt.run(memberId, id);
    if (result.changes === 0) {
      req.flash('error', 'Member not found');
    } else {
      req.audit('delete', 'project_member', memberId, `Removed member from project #${id}`);
      req.flash('success', 'Member removed');
    }
  } catch (err) {
    console.error('Project member remove error:', err.message);
    req.flash('error', 'Error removing member');
  }
  res.redirect(`/projects/${id}`);
});

module.exports = router;
