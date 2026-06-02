const db = require('../models/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { paginate, paginationBaseUrl, addSearch, buildFilters, safeId, safePositiveFloat, safeInt, trim, safeDate, getActiveStaff } = require('../utils');
const {
  PROJECT_STATUSES: VALID_STATUSES,
  PROJECT_PRIORITIES: VALID_PRIORITIES,
  TASK_STATUSES: VALID_TASK_STATUSES,
  TASK_PRIORITIES: VALID_TASK_PRIORITIES,
  MEMBER_ROLES: VALID_MEMBER_ROLES,
} = require('../constants');

const router = require('express').Router();
router.use(requireAuth, auditMiddleware);

/**
 * Recalculate and persist project progress from task completion ratio
 */
function recalcProjectProgress(projectId) {
  const total = db.prepare('SELECT COUNT(*) as c FROM project_tasks WHERE project_id = ?').get(projectId).c;
  const done = db.prepare("SELECT COUNT(*) as c FROM project_tasks WHERE project_id = ? AND status = 'done'").get(projectId).c;
  const progress = total > 0 ? Math.round((done / total) * 100) : 0;
  db.prepare('UPDATE projects SET progress = ?, updated_at = datetime(\'now\') WHERE id = ?').run(progress, projectId);
}

// List projects (paginated)
router.get('/', (req, res) => {
  const { page, limit, offset } = paginate(req);

  const filters = buildFilters({
    'p.status': { value: VALID_STATUSES.includes(req.query.status) ? req.query.status : '' },
    'p.priority': { value: VALID_PRIORITIES.includes(req.query.priority) ? req.query.priority : '' },
  });

  const where = [...filters.where];
  const params = [...filters.params];
  addSearch(where, params, req.query.search, ['p.name', 'p.description']);

  const whereClause = where.length ? where.join(' AND ') : '1=1';

  const total = db.prepare(`SELECT COUNT(*) as c FROM projects p WHERE ${whereClause}`).get(...params).c;
  const totalPages = Math.ceil(total / limit) || 1;

  const projects = db.prepare(`
    SELECT p.*, u.first_name || ' ' || u.last_name as owner_name,
      (SELECT COUNT(*) FROM project_tasks WHERE project_id = p.id) as task_count,
      (SELECT COUNT(*) FROM project_tasks WHERE project_id = p.id AND status = 'done') as done_count
    FROM projects p
    LEFT JOIN users u ON p.owner_id = u.id
    WHERE ${whereClause}
    ORDER BY p.updated_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  res.render('pages/projects/index', {
    title: 'Projects', projects, filters: req.query,
    page, totalPages, total,
    baseUrl: paginationBaseUrl(req),
  });
});

// New project form
router.get('/new', requireRole('admin', 'manager'), (req, res) => {
  const staff = getActiveStaff(db);
  res.render('pages/projects/form', { title: 'New Project', project: {}, staff, isEdit: false });
});

// Create project
router.post('/', requireRole('admin', 'manager'), (req, res) => {
  const name = trim(req.body.name);
  const description = trim(req.body.description);
  const { status, priority, start_date, end_date, budget, owner_id } = req.body;

  if (!name) {
    req.flash('error', 'Project name is required');
    return res.redirect('/projects/new');
  }

  const safeStatus = VALID_STATUSES.includes(status) ? status : 'planning';
  const safePriority = VALID_PRIORITIES.includes(priority) ? priority : 'medium';

  const sStart = safeDate(start_date);
  const sEnd = safeDate(end_date);
  if (sStart && sEnd && sEnd < sStart) {
    req.flash('error', 'End date must be on or after start date');
    return res.redirect('/projects/new');
  }

  try {
    const result = db.prepare(`
      INSERT INTO projects (name, description, status, priority, start_date, end_date, budget, owner_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name.substring(0, 200), (description || '').substring(0, 5000) || null, safeStatus, safePriority,
      sStart, sEnd, budget ? safePositiveFloat(budget, 0) : 0, owner_id ? safeId(owner_id) : null);

    req.audit('create', 'project', result.lastInsertRowid, `Created project ${name}`);
    req.flash('success', 'Project created successfully');
    res.redirect(`/projects/${result.lastInsertRowid}`);
  } catch (err) {
    req.flash('error', 'Error creating project. Please try again.');
    res.redirect('/projects/new');
  }
});

// Show project
router.get('/:id', (req, res) => {
  const id = safeId(req.params.id);
  if (!id) { req.flash('error', 'Invalid project ID'); return res.redirect('/projects'); }

  const project = db.prepare(`
    SELECT p.*, u.first_name || ' ' || u.last_name as owner_name
    FROM projects p
    LEFT JOIN users u ON p.owner_id = u.id
    WHERE p.id = ?
  `).get(id);

  if (!project) {
    req.flash('error', 'Project not found');
    return res.redirect('/projects');
  }

  const tasks = db.prepare(`
    SELECT pt.*, u.first_name || ' ' || u.last_name as assigned_name
    FROM project_tasks pt
    LEFT JOIN users u ON pt.assigned_to = u.id
    WHERE pt.project_id = ?
    ORDER BY CASE pt.status WHEN 'in_progress' THEN 1 WHEN 'todo' THEN 2 WHEN 'review' THEN 3 WHEN 'done' THEN 4 END, CASE pt.priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END, pt.due_date ASC
  `).all(id);

  const members = db.prepare(`
    SELECT pm.*, u.first_name || ' ' || u.last_name as member_name, u.email, u.role as user_role
    FROM project_members pm
    JOIN users u ON pm.user_id = u.id
    WHERE pm.project_id = ?
  `).all(id);

  const staff = getActiveStaff(db);

  res.render('pages/projects/show', { title: project.name, project, tasks, members, staff });
});

// Update project
router.put('/:id', requireRole('admin', 'manager'), (req, res) => {
  const id = safeId(req.params.id);
  if (!id) { req.flash('error', 'Invalid project ID'); return res.redirect('/projects'); }

  const name = trim(req.body.name);
  const description = trim(req.body.description);
  const { status, priority, start_date, end_date, budget, spent, progress, owner_id } = req.body;

  const safeStatus = VALID_STATUSES.includes(status) ? status : null;
  const safePriority = VALID_PRIORITIES.includes(priority) ? priority : null;

  if (!name || !safeStatus || !safePriority) {
    req.flash('error', 'Valid name, status, and priority are required');
    return res.redirect(`/projects/${id}`);
  }

  try {
    // Preserve existing spent/progress when not provided in form data
    const existingProject = db.prepare('SELECT spent, progress FROM projects WHERE id = ?').get(id);
    const safeSpent = spent !== undefined && spent !== '' ? safePositiveFloat(spent, 0) : (existingProject ? existingProject.spent : 0);
    const safeProgress = progress !== undefined && progress !== '' ? Math.max(0, Math.min(100, safeInt(progress, 0))) : (existingProject ? existingProject.progress : 0);

    const sStart = safeDate(start_date);
    const sEnd = safeDate(end_date);
    if (sStart && sEnd && sEnd < sStart) {
      req.flash('error', 'End date must be on or after start date');
      return res.redirect(`/projects/${id}`);
    }

    db.prepare(`
      UPDATE projects SET name = ?, description = ?, status = ?, priority = ?,
        start_date = ?, end_date = ?, budget = ?, spent = ?, progress = ?, owner_id = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(name.substring(0, 200), (description || '').substring(0, 5000) || null, safeStatus, safePriority, sStart, sEnd,
      budget ? safePositiveFloat(budget, 0) : 0, safeSpent, safeProgress, owner_id ? safeId(owner_id) : null, id);

    req.audit('update', 'project', id, `Updated project ${name}`);
    req.flash('success', 'Project updated successfully');
  } catch (err) {
    req.flash('error', 'Error updating project. Please try again.');
  }
  res.redirect(`/projects/${id}`);
});

// Delete project (with tasks & members in transaction)
router.delete('/:id', requireRole('admin', 'manager'), (req, res) => {
  const id = safeId(req.params.id);
  if (!id) { req.flash('error', 'Invalid project ID'); return res.redirect('/projects'); }

  try {
    const deleteProject = db.transaction(() => {
      db.prepare('DELETE FROM project_tasks WHERE project_id = ?').run(id);
      db.prepare('DELETE FROM project_members WHERE project_id = ?').run(id);
      db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    });
    deleteProject();
    req.audit('delete', 'project', id, 'Deleted project and related tasks/members');
    req.flash('success', 'Project deleted');
  } catch (err) {
    req.flash('error', 'Error deleting project');
  }
  res.redirect('/projects');
});

// Add task to project
router.post('/:id/tasks', requireRole('admin', 'manager'), (req, res) => {
  const projectId = safeId(req.params.id);
  if (!projectId) { req.flash('error', 'Invalid project ID'); return res.redirect('/projects'); }

  const title = trim(req.body.title);
  const description = trim(req.body.description);
  const { status, priority, assigned_to, due_date } = req.body;

  if (!title) {
    req.flash('error', 'Task title is required');
    return res.redirect(`/projects/${projectId}`);
  }

  try {
    const addTask = db.transaction(() => {
      db.prepare(`
        INSERT INTO project_tasks (project_id, title, description, status, priority, assigned_to, due_date)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(projectId, title.substring(0, 200), description.substring(0, 5000) || null, VALID_TASK_STATUSES.includes(status) ? status : 'todo', VALID_TASK_PRIORITIES.includes(priority) ? priority : 'medium', assigned_to ? safeId(assigned_to) : null, safeDate(due_date));

      recalcProjectProgress(projectId);
    });
    addTask();

    req.audit('create', 'project_task', null, `Added task "${title}" to project #${projectId}`);
    req.flash('success', 'Task added');
  } catch (err) {
    req.flash('error', 'Error adding task. Please try again.');
  }
  res.redirect(`/projects/${projectId}`);
});

// Update task
router.put('/:projectId/tasks/:taskId', requireRole('admin', 'manager'), (req, res) => {
  const projectId = safeId(req.params.projectId);
  const taskId = safeId(req.params.taskId);
  if (!projectId || !taskId) { req.flash('error', 'Invalid ID'); return res.redirect('/projects'); }

  const rawTitle = req.body.title;
  const description = trim(req.body.description);
  const { status, priority, assigned_to, due_date } = req.body;

  // Defensive: handle quick-status-change forms that only send `status`
  if (!rawTitle) {
    // Quick status update only — preserve existing values
    try {
      const existing = db.prepare('SELECT * FROM project_tasks WHERE id = ? AND project_id = ?').get(taskId, projectId);
      if (!existing) { req.flash('error', 'Task not found'); return res.redirect(`/projects/${projectId}`); }
      const updateTask = db.transaction(() => {
        let q = `UPDATE project_tasks SET status = ?, updated_at = datetime('now')`;
        if (status === 'done') {
          q += `, completed_at = datetime('now')`;
        } else {
          q += `, completed_at = NULL`;
        }
        q += ` WHERE id = ? AND project_id = ?`;
        db.prepare(q)
          .run(VALID_TASK_STATUSES.includes(status) ? status : existing.status, taskId, projectId);
        recalcProjectProgress(projectId);
      });
      updateTask();
      req.flash('success', 'Task updated');
    } catch (err) { req.flash('error', 'Error updating task'); }
    return res.redirect(`/projects/${projectId}`);
  }

  try {
    const title = trim(rawTitle);
    const updateTask = db.transaction(() => {
      let query = `
        UPDATE project_tasks SET title = ?, description = ?, status = ?, priority = ?,
          assigned_to = ?, due_date = ?,
          updated_at = datetime('now')`;
      if (status === 'done') {
        query += `, completed_at = COALESCE(completed_at, datetime('now'))`;
      } else {
        query += `, completed_at = NULL`;
      }
      query += ` WHERE id = ? AND project_id = ?`;
      db.prepare(query).run(title.substring(0, 200), description.substring(0, 5000) || null, VALID_TASK_STATUSES.includes(status) ? status : 'todo', VALID_TASK_PRIORITIES.includes(priority) ? priority : 'medium', assigned_to ? safeId(assigned_to) : null, safeDate(due_date), taskId, projectId);

      recalcProjectProgress(projectId);
    });
    updateTask();

    req.audit('update', 'project_task', taskId, `Updated task "${title}"`);
    req.flash('success', 'Task updated');
  } catch (err) {
    req.flash('error', 'Error updating task');
  }
  res.redirect(`/projects/${projectId}`);
});

// Delete task
router.delete('/:projectId/tasks/:taskId', requireRole('admin', 'manager'), (req, res) => {
  const projectId = safeId(req.params.projectId);
  const taskId = safeId(req.params.taskId);
  if (!projectId || !taskId) { req.flash('error', 'Invalid ID'); return res.redirect('/projects'); }

  try {
    const deleteTask = db.transaction(() => {
      db.prepare('DELETE FROM project_tasks WHERE id = ? AND project_id = ?')
        .run(taskId, projectId);

      recalcProjectProgress(projectId);
    });
    deleteTask();

    req.audit('delete', 'project_task', taskId, 'Deleted task');
    req.flash('success', 'Task deleted');
  } catch (err) {
    req.flash('error', 'Error deleting task');
  }
  res.redirect(`/projects/${projectId}`);
});

// Add member to project
router.post('/:id/members', requireRole('admin', 'manager'), (req, res) => {
  const id = safeId(req.params.id);
  if (!id) { req.flash('error', 'Invalid project ID'); return res.redirect('/projects'); }
  const { user_id, role } = req.body;
  try {
    const safeUserId = safeId(user_id);
    if (!safeUserId) { req.flash('error', 'Invalid user'); return res.redirect(`/projects/${id}`); }
    const safeRole = VALID_MEMBER_ROLES.includes(role) ? role : 'member';
    const result = db.prepare('INSERT OR IGNORE INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)')
      .run(id, safeUserId, safeRole);
    if (result.changes === 0) {
      req.flash('info', 'User is already a member of this project');
    } else {
      req.audit('create', 'project_member', null, `Added member #${user_id} to project #${id}`);
      req.flash('success', 'Member added');
    }
  } catch (err) {
    req.flash('error', 'Error adding member');
  }
  res.redirect(`/projects/${id}`);
});

// Remove member from project
router.delete('/:id/members/:memberId', requireRole('admin', 'manager'), (req, res) => {
  const id = safeId(req.params.id);
  const memberId = safeId(req.params.memberId);
  if (!id || !memberId) { req.flash('error', 'Invalid ID'); return res.redirect('/projects'); }

  try {
    db.prepare('DELETE FROM project_members WHERE id = ? AND project_id = ?')
      .run(memberId, id);
    req.audit('delete', 'project_member', memberId, `Removed member from project #${id}`);
    req.flash('success', 'Member removed');
  } catch (err) {
    req.flash('error', 'Error removing member');
  }
  res.redirect(`/projects/${id}`);
});

module.exports = router;
