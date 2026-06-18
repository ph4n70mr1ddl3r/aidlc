const db = require('../models/database');
const { requireAuth, requireAdminOrManager } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { paginate, paginationBaseUrl, addSearch, buildFilters, safeId, safeDateTimeLocal, trim, getActiveStaff, isActiveUser, countQuery } = require('../utils');
const { CHANGE_TYPES: VALID_CHANGE_TYPES, CHANGE_STATUSES: VALID_STATUSES, CHANGE_PRIORITIES: VALID_PRIORITIES, MAX_MEDIUM_STR, MAX_DESC, MAX_LONG_STR } = require('../constants');
const { invalidateDashboardCache } = require('./dashboard');

const router = require('express').Router();
router.use(requireAuth, auditMiddleware);

// Cached prepared statements for show/edit routes (static SQL).
const _showChangeStmt = db.prepare(`
    SELECT c.*, u.first_name || ' ' || u.last_name as assigned_name
    FROM change_log c
    LEFT JOIN users u ON c.assigned_to = u.id
    WHERE c.id = ?
  `);
const _editChangeStmt = db.prepare('SELECT * FROM change_log WHERE id = ?');
const _deleteChangeStmt = db.prepare('DELETE FROM change_log WHERE id = ?');

// Cached prepared statements for create/update routes
const _changeInsertStmt = db.prepare(`
    INSERT INTO change_log (title, description, change_type, status, priority, scheduled_start, scheduled_end, impact, assigned_to)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
const _changeUpdateStmt = db.prepare(`
    UPDATE change_log SET title = ?, description = ?, change_type = ?, status = ?,
      priority = ?, scheduled_start = ?, scheduled_end = ?, actual_start = ?, actual_end = ?,
      impact = ?, assigned_to = ?, updated_at = datetime('now')
    WHERE id = ?
  `);

// List changes (paginated)
router.get('/', (req, res) => {
  const { page, limit, offset } = paginate(req);

  const filters = buildFilters({
    'c.status': { value: VALID_STATUSES.includes(req.query.status) ? req.query.status : '' },
    'c.change_type': { value: VALID_CHANGE_TYPES.includes(req.query.change_type) ? req.query.change_type : '' },
    'c.priority': { value: VALID_PRIORITIES.includes(req.query.priority) ? req.query.priority : '' }
  }, ['c.status', 'c.change_type', 'c.priority']);

  const where = [...filters.where];
  const params = [...filters.params];
  addSearch(where, params, req.query.search, ['c.title', 'c.description']);

  const whereClause = where.length ? where.join(' AND ') : '1=1';

  const total = countQuery(db, 'change_log', 'c', whereClause, params);
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
    page, limit, totalPages, total,
    baseUrl: paginationBaseUrl(req)
  });
});

// New change
router.get('/new', requireAdminOrManager, (req, res) => {
  const staff = getActiveStaff(db);
  res.render('pages/changes/form', { title: 'New Change', change: {}, staff, isEdit: false });
});

// Create change
router.post('/', requireAdminOrManager, (req, res) => {
  const title = trim(req.body.title);
  const description = trim(req.body.description);
  const { change_type, status, priority, scheduled_start, scheduled_end } = req.body;
  const impact = trim(req.body.impact);
  const { assigned_to } = req.body;

  if (!title || !change_type) {
    req.flash('error', 'Title and change type are required');
    return res.redirect('/changes/new');
  }
  if (title.length > MAX_MEDIUM_STR) {
    req.flash('error', `Title must be at most ${MAX_MEDIUM_STR} characters`);
    return res.redirect('/changes/new');
  }
  if (description && description.length > MAX_DESC) {
    req.flash('error', `Description must be at most ${MAX_DESC} characters`);
    return res.redirect('/changes/new');
  }
  if (impact && impact.length > MAX_LONG_STR) {
    req.flash('error', `Impact must be at most ${MAX_LONG_STR} characters`);
    return res.redirect('/changes/new');
  }

  if (!VALID_CHANGE_TYPES.includes(change_type)) {
    req.flash('error', 'Invalid change type');
    return res.redirect('/changes/new');
  }
  if (!status || !VALID_STATUSES.includes(status)) {
    req.flash('error', 'Invalid status');
    return res.redirect('/changes/new');
  }
  if (priority && !VALID_PRIORITIES.includes(priority)) {
    req.flash('error', 'Invalid priority');
    return res.redirect('/changes/new');
  }
  const safePriority = priority || 'medium';

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
    const result = _changeInsertStmt.run(title.substring(0, MAX_MEDIUM_STR), (description || '').substring(0, MAX_DESC) || null, change_type, status, safePriority,
      sStart, sEnd, (impact || '').substring(0, MAX_LONG_STR) || null, safeAssignee);

    req.audit('create', 'change', result.lastInsertRowid, `Created change "${title}"`);
    req.flash('success', 'Change record created');
    invalidateDashboardCache();
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
  if (!id) {
    req.flash('error', 'Invalid change ID');
    return res.redirect('/changes');
  }

  const change = _showChangeStmt.get(id);

  if (!change) {
    req.flash('error', 'Change not found');
    return res.redirect('/changes');
  }
  res.render('pages/changes/show', { title: change.title, change });
});

// Edit change
router.get('/:id/edit', requireAdminOrManager, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid change ID');
    return res.redirect('/changes');
  }

  const change = _editChangeStmt.get(id);
  if (!change) {
    req.flash('error', 'Change not found');
    return res.redirect('/changes');
  }
  const staff = getActiveStaff(db);
  res.render('pages/changes/form', { title: 'Edit Change', change, staff, isEdit: true });
});

// Update change
router.put('/:id', requireAdminOrManager, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid change ID');
    return res.redirect('/changes');
  }

  const title = trim(req.body.title);
  const description = trim(req.body.description);
  const { change_type, status, priority, scheduled_start, scheduled_end, actual_start, actual_end } = req.body;
  const impact = trim(req.body.impact);
  const { assigned_to } = req.body;

  if (!title) {
    req.flash('error', 'Title is required');
    return res.redirect(`/changes/${id}/edit`);
  }
  if (title.length > MAX_MEDIUM_STR) {
    req.flash('error', `Title must be at most ${MAX_MEDIUM_STR} characters`);
    return res.redirect(`/changes/${id}/edit`);
  }
  if (description && description.length > MAX_DESC) {
    req.flash('error', `Description must be at most ${MAX_DESC} characters`);
    return res.redirect(`/changes/${id}/edit`);
  }
  if (impact && impact.length > MAX_LONG_STR) {
    req.flash('error', `Impact must be at most ${MAX_LONG_STR} characters`);
    return res.redirect(`/changes/${id}/edit`);
  }
  if (!VALID_CHANGE_TYPES.includes(change_type)) {
    req.flash('error', 'Invalid change type');
    return res.redirect(`/changes/${id}/edit`);
  }
  if (!status || !VALID_STATUSES.includes(status)) {
    req.flash('error', 'Invalid status');
    return res.redirect(`/changes/${id}/edit`);
  }
  if (priority && !VALID_PRIORITIES.includes(priority)) {
    req.flash('error', 'Invalid priority');
    return res.redirect(`/changes/${id}/edit`);
  }

  // Fetch existing record to preserve unchanged fields
  const existingChange = _editChangeStmt.get(id);
  if (!existingChange) {
    req.flash('error', 'Change not found');
    return res.redirect('/changes');
  }

  const safePriority = priority && VALID_PRIORITIES.includes(priority) ? priority : existingChange.priority;

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
    _changeUpdateStmt.run(title.substring(0, MAX_MEDIUM_STR), (description || '').substring(0, MAX_DESC) || null, change_type, status, safePriority,
      sSchedStart, sSchedEnd, sActStart, sActEnd,
      (impact || '').substring(0, MAX_LONG_STR) || null, safeAssignee, id);

    req.audit('update', 'change', id, `Updated change "${title}" (status: ${status})`);
    req.flash('success', 'Change updated');
    invalidateDashboardCache();
    res.redirect(`/changes/${id}`);
  } catch (err) {
    console.error('Change update error:', err.message);
    req.flash('error', 'Error updating change. Please try again.');
    res.redirect(`/changes/${id}/edit`);
  }
});

// Delete change
router.delete('/:id', requireAdminOrManager, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid change ID');
    return res.redirect('/changes');
  }

  try {
    const result = _deleteChangeStmt.run(id);
    if (result.changes === 0) {
      req.flash('error', 'Change not found');
    } else {
      req.audit('delete', 'change', id, 'Deleted change record');
      req.flash('success', 'Change deleted');
      invalidateDashboardCache();
    }
  } catch (err) {
    console.error('Change delete error:', err.message);
    req.flash('error', 'Error deleting change');
  }
  res.redirect('/changes');
});

module.exports = router;
