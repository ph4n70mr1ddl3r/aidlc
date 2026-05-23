const db = require('../models/database');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = require('express').Router();
router.use(requireAuth);

// List changes
router.get('/', (req, res) => {
  const { status, change_type, priority } = req.query;
  let where = ['1=1'];
  let params = [];
  
  if (status) { where.push('c.status = ?'); params.push(status); }
  if (change_type) { where.push('c.change_type = ?'); params.push(change_type); }
  if (priority) { where.push('c.priority = ?'); params.push(priority); }
  
  const changes = db.prepare(`
    SELECT c.*, u.first_name || ' ' || u.last_name as assigned_name
    FROM change_log c
    LEFT JOIN users u ON c.assigned_to = u.id
    WHERE ${where.join(' AND ')}
    ORDER BY c.scheduled_start DESC
  `).all(...params);

  res.render('pages/changes/index', { title: 'Change Log', changes, filters: req.query });
});

// New change
router.get('/new', requireRole('admin', 'manager'), (req, res) => {
  const staff = db.prepare('SELECT id, first_name, last_name FROM users WHERE is_active = 1 ORDER BY first_name').all();
  res.render('pages/changes/form', { title: 'New Change', change: {}, staff, isEdit: false });
});

// Create change
router.post('/', requireRole('admin', 'manager'), (req, res) => {
  const { title, description, change_type, status, priority, scheduled_start, scheduled_end, impact, assigned_to } = req.body;
  
  if (!title || !change_type) {
    req.flash('error', 'Title and change type are required');
    return res.redirect('/changes/new');
  }

  try {
    db.prepare(`
      INSERT INTO change_log (title, description, change_type, status, priority, scheduled_start, scheduled_end, impact, assigned_to)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(title, description || null, change_type, status || 'scheduled', priority || 'medium',
      scheduled_start || null, scheduled_end || null, impact || null, assigned_to || null);
    
    req.flash('success', 'Change record created');
    res.redirect('/changes');
  } catch (err) {
    req.flash('error', 'Error creating change. Please try again.');
    res.redirect('/changes/new');
  }
});

// Show change
router.get('/:id', (req, res) => {
  const change = db.prepare(`
    SELECT c.*, u.first_name || ' ' || u.last_name as assigned_name
    FROM change_log c
    LEFT JOIN users u ON c.assigned_to = u.id
    WHERE c.id = ?
  `).get(req.params.id);
  
  if (!change) {
    req.flash('error', 'Change not found');
    return res.redirect('/changes');
  }
  res.render('pages/changes/show', { title: change.title, change });
});

// Edit change
router.get('/:id/edit', requireRole('admin', 'manager'), (req, res) => {
  const change = db.prepare('SELECT * FROM change_log WHERE id = ?').get(req.params.id);
  if (!change) {
    req.flash('error', 'Change not found');
    return res.redirect('/changes');
  }
  const staff = db.prepare('SELECT id, first_name, last_name FROM users WHERE is_active = 1 ORDER BY first_name').all();
  res.render('pages/changes/form', { title: 'Edit Change', change, staff, isEdit: true });
});

// Update change
router.put('/:id', requireRole('admin', 'manager'), (req, res) => {
  const { title, description, change_type, status, priority, scheduled_start, scheduled_end, actual_start, actual_end, impact, assigned_to } = req.body;
  
  try {
    db.prepare(`
      UPDATE change_log SET title = ?, description = ?, change_type = ?, status = ?,
        priority = ?, scheduled_start = ?, scheduled_end = ?, actual_start = ?, actual_end = ?,
        impact = ?, assigned_to = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(title, description || null, change_type, status, priority,
      scheduled_start || null, scheduled_end || null, actual_start || null, actual_end || null,
      impact || null, assigned_to || null, req.params.id);
    
    req.flash('success', 'Change updated');
    res.redirect(`/changes/${req.params.id}`);
  } catch (err) {
    req.flash('error', 'Error updating change. Please try again.');
    res.redirect(`/changes/${req.params.id}/edit`);
  }
});

// Delete change
router.delete('/:id', requireRole('admin', 'manager'), (req, res) => {
  try {
    db.prepare('DELETE FROM change_log WHERE id = ?').run(req.params.id);
    req.flash('success', 'Change deleted');
  } catch (err) {
    req.flash('error', 'Error deleting change');
  }
  res.redirect('/changes');
});

module.exports = router;
