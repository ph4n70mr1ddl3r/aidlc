const db = require('../models/database');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = require('express').Router();
router.use(requireAuth);

// List projects
router.get('/', (req, res) => {
  const { status, priority } = req.query;
  let where = ['1=1'];
  let params = [];
  
  if (status) { where.push('p.status = ?'); params.push(status); }
  if (priority) { where.push('p.priority = ?'); params.push(priority); }
  
  const projects = db.prepare(`
    SELECT p.*, u.first_name || ' ' || u.last_name as owner_name,
      (SELECT COUNT(*) FROM project_tasks WHERE project_id = p.id) as task_count,
      (SELECT COUNT(*) FROM project_tasks WHERE project_id = p.id AND status = 'done') as done_count
    FROM projects p
    LEFT JOIN users u ON p.owner_id = u.id
    WHERE ${where.join(' AND ')}
    ORDER BY p.updated_at DESC
  `).all(...params);

  res.render('pages/projects/index', { title: 'Projects', projects, filters: req.query });
});

// New project form
router.get('/new', (req, res) => {
  const staff = db.prepare('SELECT id, first_name, last_name FROM users WHERE is_active = 1 ORDER BY first_name').all();
  res.render('pages/projects/form', { title: 'New Project', project: {}, staff, isEdit: false });
});

// Create project
router.post('/', (req, res) => {
  const { name, description, status, priority, start_date, end_date, budget, owner_id } = req.body;
  
  try {
    const result = db.prepare(`
      INSERT INTO projects (name, description, status, priority, start_date, end_date, budget, owner_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, description, status, priority, start_date || null, end_date || null, budget || 0, owner_id || null);
    
    req.flash('success', 'Project created successfully');
    res.redirect(`/projects/${result.lastInsertRowid}`);
  } catch (err) {
    req.flash('error', 'Error creating project: ' + err.message);
    res.redirect('/projects/new');
  }
});

// Show project
router.get('/:id', (req, res) => {
  const project = db.prepare(`
    SELECT p.*, u.first_name || ' ' || u.last_name as owner_name
    FROM projects p
    LEFT JOIN users u ON p.owner_id = u.id
    WHERE p.id = ?
  `).get(req.params.id);
  
  if (!project) {
    req.flash('error', 'Project not found');
    return res.redirect('/projects');
  }

  const tasks = db.prepare(`
    SELECT pt.*, u.first_name || ' ' || u.last_name as assigned_name
    FROM project_tasks pt
    LEFT JOIN users u ON pt.assigned_to = u.id
    WHERE pt.project_id = ?
    ORDER BY pt.status ASC, pt.priority DESC, pt.due_date ASC
  `).all(req.params.id);

  const members = db.prepare(`
    SELECT pm.*, u.first_name || ' ' || u.last_name as member_name, u.email, u.role as user_role
    FROM project_members pm
    JOIN users u ON pm.user_id = u.id
    WHERE pm.project_id = ?
  `).all(req.params.id);

  const staff = db.prepare('SELECT id, first_name, last_name FROM users WHERE is_active = 1 ORDER BY first_name').all();
  
  res.render('pages/projects/show', { title: project.name, project, tasks, members, staff });
});

// Update project
router.put('/:id', (req, res) => {
  const { name, description, status, priority, start_date, end_date, budget, spent, progress, owner_id } = req.body;
  
  try {
    db.prepare(`
      UPDATE projects SET name = ?, description = ?, status = ?, priority = ?,
        start_date = ?, end_date = ?, budget = ?, spent = ?, progress = ?, owner_id = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(name, description, status, priority, start_date || null, end_date || null,
      budget || 0, spent || 0, progress || 0, owner_id || null, req.params.id);
    
    req.flash('success', 'Project updated successfully');
  } catch (err) {
    req.flash('error', 'Error updating project: ' + err.message);
  }
  res.redirect(`/projects/${req.params.id}`);
});

// Delete project
router.delete('/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
    req.flash('success', 'Project deleted');
  } catch (err) {
    req.flash('error', 'Error deleting project');
  }
  res.redirect('/projects');
});

// Add task to project
router.post('/:id/tasks', (req, res) => {
  const { title, description, status, priority, assigned_to, due_date } = req.body;
  
  try {
    db.prepare(`
      INSERT INTO project_tasks (project_id, title, description, status, priority, assigned_to, due_date)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(req.params.id, title, description, status || 'todo', priority, assigned_to || null, due_date || null);
    
    // Update project progress
    const total = db.prepare('SELECT COUNT(*) as c FROM project_tasks WHERE project_id = ?').get(req.params.id).c;
    const done = db.prepare("SELECT COUNT(*) as c FROM project_tasks WHERE project_id = ? AND status = 'done'").get(req.params.id).c;
    const progress = total > 0 ? Math.round((done / total) * 100) : 0;
    db.prepare(`UPDATE projects SET progress = ?, updated_at = datetime('now') WHERE id = ?`).run(progress, req.params.id);
    
    req.flash('success', 'Task added');
  } catch (err) {
    req.flash('error', 'Error adding task: ' + err.message);
  }
  res.redirect(`/projects/${req.params.id}`);
});

// Update task
router.put('/:projectId/tasks/:taskId', (req, res) => {
  const { title, description, status, priority, assigned_to, due_date } = req.body;
  
  try {
    let query = `
      UPDATE project_tasks SET title = ?, description = ?, status = ?, priority = ?,
        assigned_to = ?, due_date = ?,
        updated_at = datetime('now')`;
    if (status === 'done') {
      query += `, completed_at = datetime('now')`;
    }
    query += ` WHERE id = ? AND project_id = ?`;
    db.prepare(query).run(title, description, status, priority, assigned_to || null, due_date || null, req.params.taskId, req.params.projectId);
    
    // Update project progress
    const total = db.prepare('SELECT COUNT(*) as c FROM project_tasks WHERE project_id = ?').get(req.params.projectId).c;
    const done = db.prepare("SELECT COUNT(*) as c FROM project_tasks WHERE project_id = ? AND status = 'done'").get(req.params.projectId).c;
    const progress = total > 0 ? Math.round((done / total) * 100) : 0;
    db.prepare(`UPDATE projects SET progress = ?, updated_at = datetime('now') WHERE id = ?`).run(progress, req.params.projectId);
    
    req.flash('success', 'Task updated');
  } catch (err) {
    req.flash('error', 'Error updating task');
  }
  res.redirect(`/projects/${req.params.projectId}`);
});

// Delete task
router.delete('/:projectId/tasks/:taskId', (req, res) => {
  try {
    db.prepare('DELETE FROM project_tasks WHERE id = ? AND project_id = ?')
      .run(req.params.taskId, req.params.projectId);
    req.flash('success', 'Task deleted');
  } catch (err) {
    req.flash('error', 'Error deleting task');
  }
  res.redirect(`/projects/${req.params.projectId}`);
});

// Add member to project
router.post('/:id/members', (req, res) => {
  const { user_id, role } = req.body;
  try {
    db.prepare('INSERT OR IGNORE INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)')
      .run(req.params.id, user_id, role || 'member');
    req.flash('success', 'Member added');
  } catch (err) {
    req.flash('error', 'Error adding member');
  }
  res.redirect(`/projects/${req.params.id}`);
});

// Remove member from project
router.delete('/:id/members/:memberId', (req, res) => {
  try {
    db.prepare('DELETE FROM project_members WHERE id = ? AND project_id = ?')
      .run(req.params.memberId, req.params.id);
    req.flash('success', 'Member removed');
  } catch (err) {
    req.flash('error', 'Error removing member');
  }
  res.redirect(`/projects/${req.params.id}`);
});

module.exports = router;
