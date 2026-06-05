const db = require('../models/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { paginate, paginationBaseUrl, addSearch, buildFilters, safeId, safeDate, safeDateTimeLocal, trim, getActiveStaff, isActiveUser } = require('../utils');
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

  const total = db.prepare(`SELECT COUNT(*) as c FROM change_log c WHERE ${whereClause}`).get(...params).c;
  const totalPages = Math.ceil(total / limit) || 1;

  const changes = db.prepare(`
    SELECT c.*, u.first_name || ' ' || u.last_name as assigned_name
    FROM change_log c
    LEFT JOIN users u ON c.assigned_to = u.id
    WHERE ${whereClause}
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
  const staff = getActiveStaff(db);
  res.render('pages/changes/form', { title: 'New Change', change: {}, staff, isEdit: false });
});

// Create change
router.post('/', requireRole('admin', 'manager'), (req, res) => {
  const title = trim(req.body.title);
  const description = trim(req.body.description);
  const { change_type, status, priority, scheduled_start, scheduled_end } = req.body;
  const impact = trim(req.body.impact);
  const { assigned_to } = req.body;

  if (!title || !change_type) {
    req.flash('error', 'Title and change type are required');
    return res.redirect('/changes/new');
  }
  if (title.length > 200) {
    req.flash('error', 'Title must be at most 200 characters');
    return res.redirect('/changes/new');
  }

  if (!VALID_CHANGE_TYPES.includes(change_type)) {
    req.flash('error', 'Invalid change type');
    return res.redirect('/changes/new');
  }
  const safeStatus = VALID_STATUSES.includes(status) ? status : 'scheduled';
  const safePriority = VALID_PRIORITIES.includes(priority) ? priority : 'medium';

  const sStart = safeDateTimeLocal(scheduled_start);
  const sEnd = safeDateTimeLocal(scheduled_end);
  if (sStart && sEnd && sEnd < sStart) {
    req.flash('error', 'Scheduled end must be on or after scheduled start');
    return res.redirect('/changes/new');
  }

  // Validate assignee is an active user
  const safeAssignee = assigned_to ? safeId(assigned_to) : null;
  if (safeAssignee && !isActiveUser(db, safeAssignee)) {
    req.flash('error', 'Selected assignee is not available');
    return res.redirect('/changes/new');
  }

  try {
    const result = db.prepare(`
      INSERT INTO change_log (title, description, change_type, status, priority, scheduled_start, scheduled_end, impact, assigned_to)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(title.substring(0, 200), (description || '').substring(0, 5000) || null, change_type, safeStatus, safePriority,
      sStart, sEnd, (impact || '').substring(0, 500) || null, safeAssignee);

    req.audit('create', 'change', result.lastInsertRowid, `Created change "${title}"`);
    req.flash('success', 'Change record created');
    res.redirect('/changes');
  } catch (err) {
    console.error('Change create error:', err.message);
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
  const staff = getActiveStaff(db);
  res.render('pages/changes/form', { title: 'Edit Change', change, staff, isEdit: true });
});

// Update change
router.put('/:id', requireRole('admin', 'manager'), (req, res) => {
  const id = safeId(req.params.id);
  if (!id) { req.flash('error', 'Invalid change ID'); return res.redirect('/changes'); }

  const title = trim(req.body.title);
  const description = trim(req.body.description);
  const { change_type, status, priority, scheduled_start, scheduled_end, actual_start, actual_end } = req.body;
  const impact = trim(req.body.impact);
  const { assigned_to } = req.body;

  if (!title) {
    req.flash('error', 'Title is required');
    return res.redirect(`/changes/${id}/edit`);
  }
  if (title.length > 200) {
    req.flash('error', 'Title must be at most 200 characters');
    return res.redirect(`/changes/${id}/edit`);
  }
  if (!VALID_CHANGE_TYPES.includes(change_type) || !VALID_STATUSES.includes(status) || !VALID_PRIORITIES.includes(priority)) {
    req.flash('error', 'Invalid change type, status, or priority');
    return res.redirect(`/changes/${id}/edit`);
  }

  const sSchedStart = safeDateTimeLocal(scheduled_start);
  const sSchedEnd = safeDateTimeLocal(scheduled_end);
  if (sSchedStart && sSchedEnd && sSchedEnd < sSchedStart) {
    req.flash('error', 'Scheduled end must be on or after scheduled start');
    return res.redirect(`/changes/${id}/edit`);
  }
  const sActStart = safeDateTimeLocal(actual_start);
  const sActEnd = safeDateTimeLocal(actual_end);
  if (sActStart && sActEnd && sActEnd < sActStart) {
    req.flash('error', 'Actual end must be on or after actual start');
    return res.redirect(`/changes/${id}/edit`);
  }

  // Validate assignee is an active user
  const safeAssignee = assigned_to ? safeId(assigned_to) : null;
  if (safeAssignee && !isActiveUser(db, safeAssignee)) {
    req.flash('error', 'Selected assignee is not available');
    return res.redirect(`/changes/${id}/edit`);
  }

  try {
    // Verify change exists before updating
    const existing = db.prepare('SELECT id FROM change_log WHERE id = ?').get(id);
    if (!existing) { req.flash('error', 'Change not found'); return res.redirect('/changes'); }

    db.prepare(`
      UPDATE change_log SET title = ?, description = ?, change_type = ?, status = ?,
        priority = ?, scheduled_start = ?, scheduled_end = ?, actual_start = ?, actual_end = ?,
        impact = ?, assigned_to = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(title.substring(0, 200), (description || '').substring(0, 5000) || null, change_type, status, priority,
      sSchedStart, sSchedEnd, sActStart, sActEnd,
      (impact || '').substring(0, 500) || null, safeAssignee, id);

    req.audit('update', 'change', id, `Updated change "${title}" (status: ${status})`);
    req.flash('success', 'Change updated');
    res.redirect(`/changes/${id}`);
  } catch (err) {
    console.error('Change update error:', err.message);
    req.flash('error', 'Error updating change. Please try again.');
    res.redirect(`/changes/${id}/edit`);
  }
});

// Delete change
router.delete('/:id', requireRole('admin', 'manager'), (req, res) => {
  const id = safeId(req.params.id);
  if (!id) { req.flash('error', 'Invalid change ID'); return res.redirect('/changes'); }

  try {
    const result = db.prepare('DELETE FROM change_log WHERE id = ?').run(id);
    if (result.changes === 0) {
      req.flash('error', 'Change not found');
    } else {
      req.audit('delete', 'change', id, 'Deleted change record');
      req.flash('success', 'Change deleted');
    }
  } catch (err) {
    console.error('Change delete error:', err.message);
    req.flash('error', 'Error deleting change');
  }
  res.redirect('/changes');
});

module.exports = router;
