const db = require('../models/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { paginate, paginationBaseUrl, addSearch, buildFilters, safeId } = require('../utils');
const { CHANGE_TYPES: VALID_CHANGE_TYPES, CHANGE_STATUSES: VALID_STATUSES, CHANGE_PRIORITIES: VALID_PRIORITIES } = require('../constants');

const router = require('express').Router();
router.use(requireAuth, auditMiddleware);

// List changes (paginated)
router.get('/', (req, res) => {
  const { page, limit, offset } = paginate(req);

  const filters = buildFilters({
    'c.status': { value: VALID_STATUSES.includes(req.query.status) ? req.query.status : '' },
    'c.change_type': { value: VALID_CHANGE_TYPES.includes(req.query.change_type) ? req.query.change_type : '' },
    'c.priority': { value: VALID_PRIORITIES.includes(req.query.priority) ? req.query.priority : '' },
  });

  const where = [...filters.where];
  const params = [...filters.params];
  addSearch(where, params, req.query.search, ['c.title', 'c.description']);

  const whereClause = where.length ? where.join(' AND ') : '1=1';

  const total = db.prepare(`SELECT COUNT(*) as c FROM change_log c WHERE ${where}`).get(...params).c;
  const totalPages = Math.ceil(total / limit) || 1;

  const changes = db.prepare(`
    SELECT c.*, u.first_name || ' ' || u.last_name as assigned_name
    FROM change_log c
    LEFT JOIN users u ON c.assigned_to = u.id
    WHERE ${where}
    ORDER BY c.scheduled_start DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  res.render('pages/changes/index', {
    title: 'Change Log', changes, filters: req.query,
    page, totalPages, total,
    baseUrl: paginationBaseUrl(req),
  });
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

  if (!VALID_CHANGE_TYPES.includes(change_type)) {
    req.flash('error', 'Invalid change type');
    return res.redirect('/changes/new');
  }
  const safeStatus = VALID_STATUSES.includes(status) ? status : 'scheduled';
  const safePriority = VALID_PRIORITIES.includes(priority) ? priority : 'medium';

  try {
    const result = db.prepare(`
      INSERT INTO change_log (title, description, change_type, status, priority, scheduled_start, scheduled_end, impact, assigned_to)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(title.substring(0, 200), (description || '').substring(0, 5000) || null, change_type, safeStatus, safePriority,
      scheduled_start || null, scheduled_end || null, (impact || '').substring(0, 500) || null, assigned_to ? safeId(assigned_to) : null);

    req.audit('create', 'change', result.lastInsertRowid, `Created change "${title}"`);
    req.flash('success', 'Change record created');
    res.redirect('/changes');
  } catch (err) {
    req.flash('error', 'Error creating change. Please try again.');
    res.redirect('/changes/new');
  }
});

// Show change
router.get('/:id', (req, res) => {
  const id = safeId(req.params.id);
  if (!id) { req.flash('error', 'Invalid change ID'); return res.redirect('/changes'); }

  const change = db.prepare(`
    SELECT c.*, u.first_name || ' ' || u.last_name as assigned_name
    FROM change_log c
    LEFT JOIN users u ON c.assigned_to = u.id
    WHERE c.id = ?
  `).get(id);

  if (!change) {
    req.flash('error', 'Change not found');
    return res.redirect('/changes');
  }
  res.render('pages/changes/show', { title: change.title, change });
});

// Edit change
router.get('/:id/edit', requireRole('admin', 'manager'), (req, res) => {
  const id = safeId(req.params.id);
  if (!id) { req.flash('error', 'Invalid change ID'); return res.redirect('/changes'); }

  const change = db.prepare('SELECT * FROM change_log WHERE id = ?').get(id);
  if (!change) {
    req.flash('error', 'Change not found');
    return res.redirect('/changes');
  }
  const staff = db.prepare('SELECT id, first_name, last_name FROM users WHERE is_active = 1 ORDER BY first_name').all();
  res.render('pages/changes/form', { title: 'Edit Change', change, staff, isEdit: true });
});

// Update change
router.put('/:id', requireRole('admin', 'manager'), (req, res) => {
  const id = safeId(req.params.id);
  if (!id) { req.flash('error', 'Invalid change ID'); return res.redirect('/changes'); }

  const { title, description, change_type, status, priority, scheduled_start, scheduled_end, actual_start, actual_end, impact, assigned_to } = req.body;

  if (!VALID_CHANGE_TYPES.includes(change_type) || !VALID_STATUSES.includes(status) || !VALID_PRIORITIES.includes(priority)) {
    req.flash('error', 'Invalid change type, status, or priority');
    return res.redirect(`/changes/${id}/edit`);
  }

  try {
    db.prepare(`
      UPDATE change_log SET title = ?, description = ?, change_type = ?, status = ?,
        priority = ?, scheduled_start = ?, scheduled_end = ?, actual_start = ?, actual_end = ?,
        impact = ?, assigned_to = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(title.substring(0, 200), (description || '').substring(0, 5000) || null, change_type, status, priority,
      scheduled_start || null, scheduled_end || null, actual_start || null, actual_end || null,
      (impact || '').substring(0, 500) || null, assigned_to ? safeId(assigned_to) : null, id);

    req.audit('update', 'change', id, `Updated change "${title}" (status: ${status})`);
    req.flash('success', 'Change updated');
    res.redirect(`/changes/${id}`);
  } catch (err) {
    req.flash('error', 'Error updating change. Please try again.');
    res.redirect(`/changes/${id}/edit`);
  }
});

// Delete change
router.delete('/:id', requireRole('admin', 'manager'), (req, res) => {
  const id = safeId(req.params.id);
  if (!id) { req.flash('error', 'Invalid change ID'); return res.redirect('/changes'); }

  try {
    db.prepare('DELETE FROM change_log WHERE id = ?').run(id);
    req.audit('delete', 'change', id, 'Deleted change record');
    req.flash('success', 'Change deleted');
  } catch (err) {
    req.flash('error', 'Error deleting change');
  }
  res.redirect('/changes');
});

module.exports = router;
