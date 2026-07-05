const db = require('../models/database');
const { requireAuth, requireAdminOrManager } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { paginate, paginationBaseUrl, addSearch, buildFilters, safeId, safeDateTimeLocal, trim, getActiveStaff, isActiveUser, countQuery, selectQuery, safeQueryValue } = require('../utils');
const { CHANGE_TYPES: VALID_CHANGE_TYPES, CHANGE_STATUSES: VALID_STATUSES, CHANGE_PRIORITIES: VALID_PRIORITIES, MAX_MEDIUM_STR, MAX_DESC, MAX_LONG_STR } = require('../constants');
const { invalidateDashboardCache } = require('./dashboard');

const rateLimit = require('express-rate-limit');

const changeWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: 'Too many change operations. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});

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

function _resolveDateTimeField(newValue, existingValue) {
  if (newValue === undefined) {
    return { value: existingValue };
  }
  if (newValue === '') {
    return { value: null };
  }
  const parsed = safeDateTimeLocal(newValue);
  if (parsed === null) {
    return { error: true };
  }
  return { value: parsed };
}
const _changeUpdateStmt = db.prepare(`
    UPDATE change_log SET title = ?, description = ?, change_type = ?, status = ?,
      priority = ?, scheduled_start = ?, scheduled_end = ?, actual_start = ?, actual_end = ?,
      impact = ?, assigned_to = ?, updated_at = datetime('now')
    WHERE id = ?
  `);

// List changes (paginated)
router.get('/', (req, res) => {
  const { page, limit, offset } = paginate(req);

  const qStatus = safeQueryValue(req.query.status);
  const qChangeType = safeQueryValue(req.query.change_type);
  const qPriority = safeQueryValue(req.query.priority);
  const filters = buildFilters({
    'c.status': { value: VALID_STATUSES.includes(qStatus) ? qStatus : '' },
    'c.change_type': { value: VALID_CHANGE_TYPES.includes(qChangeType) ? qChangeType : '' },
    'c.priority': { value: VALID_PRIORITIES.includes(qPriority) ? qPriority : '' }
  }, ['c.status', 'c.change_type', 'c.priority']);

  const where = [...filters.where];
  const params = [...filters.params];
  addSearch(where, params, safeQueryValue(req.query.search), ['c.title', 'c.description']);

  const whereClause = where.length ? where.join(' AND ') : '1=1';

  const total = countQuery(db, 'change_log', 'c', whereClause, params);
  const totalPages = Math.ceil(total / limit) || 1;

  const changes = selectQuery(db, `
    SELECT c.*, u.first_name || ' ' || u.last_name as assigned_name
    FROM change_log c
    LEFT JOIN users u ON c.assigned_to = u.id
    WHERE ${whereClause}
    ORDER BY c.scheduled_start DESC
    LIMIT ? OFFSET ?
  `, [...params, limit, offset]);

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
router.post('/', requireAdminOrManager, changeWriteLimiter, (req, res) => {
  const title = trim(safeQueryValue(req.body.title));
  const description = trim(safeQueryValue(req.body.description));
  const change_type = trim(safeQueryValue(req.body.change_type));
  const status = trim(safeQueryValue(req.body.status));
  const priority = trim(safeQueryValue(req.body.priority));
  const scheduled_start = safeQueryValue(req.body.scheduled_start);
  const scheduled_end = safeQueryValue(req.body.scheduled_end);
  const impact = trim(safeQueryValue(req.body.impact));
  const assigned_to = safeQueryValue(req.body.assigned_to);

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

  try {
    // Validate assignee and insert in a single transaction to avoid a TOCTOU
    // race where the assignee is deactivated between the check and the INSERT.
    const createChange = db.transaction(() => {
      if (safeAssignee && !isActiveUser(db, safeAssignee)) {
        throw new Error('ASSIGNEE_NOT_AVAILABLE');
      }
      return _changeInsertStmt.run(title.substring(0, MAX_MEDIUM_STR), (description || '').substring(0, MAX_DESC) || null, change_type, status, safePriority,
        sStart, sEnd, (impact || '').substring(0, MAX_LONG_STR) || null, safeAssignee);
    });
    const result = createChange();

    req.audit('create', 'change', result.lastInsertRowid, `Created change "${title}"`);
    req.flash('success', 'Change record created');
    invalidateDashboardCache();
    res.redirect('/changes');
  } catch (err) {
    if (err.message === 'ASSIGNEE_NOT_AVAILABLE') {
      req.flash('error', 'Selected assignee is not available');
      return res.redirect('/changes/new');
    }
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
router.put('/:id', requireAdminOrManager, changeWriteLimiter, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid change ID');
    return res.redirect('/changes');
  }

  const title = trim(safeQueryValue(req.body.title));
  const description = trim(safeQueryValue(req.body.description));
  const change_type = trim(safeQueryValue(req.body.change_type));
  const status = trim(safeQueryValue(req.body.status));
  const priority = trim(safeQueryValue(req.body.priority));
  const scheduled_start = safeQueryValue(req.body.scheduled_start);
  const scheduled_end = safeQueryValue(req.body.scheduled_end);
  const actual_start = safeQueryValue(req.body.actual_start);
  const actual_end = safeQueryValue(req.body.actual_end);
  const impact = trim(safeQueryValue(req.body.impact));
  const assigned_to = safeQueryValue(req.body.assigned_to);

  if (!title || !change_type) {
    req.flash('error', 'Title and change type are required');
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

  // Validate assignee is an active user
  const safeAssignee = assigned_to ? safeId(assigned_to) : null;

  try {
    // Fetch existing record, validate assignee, and update in a single transaction
    // to avoid TOCTOU races: the change could be modified/deleted or the assignee
    // deactivated between the fetch/checks and the UPDATE.
    const updateChange = db.transaction(() => {
      const existingChange = _editChangeStmt.get(id);
      if (!existingChange) {
        throw new Error('NOT_FOUND');
      }

      if (safeAssignee && !isActiveUser(db, safeAssignee)) {
        throw new Error('ASSIGNEE_NOT_AVAILABLE');
      }

      // The earlier guard already redirected when priority is present-but-invalid,
      // so a truthy priority here is guaranteed valid; fall back to the existing
      // value when the field is absent (mirrors the create route's `priority || 'medium'`).
      const safePriority = priority || existingChange.priority;

      // --- scheduled_start ---
      const sSchedStart = _resolveDateTimeField(scheduled_start, existingChange.scheduled_start);
      if (sSchedStart.error) {
        return { error: 'Invalid scheduled start date', redirect: `/changes/${id}/edit` };
      }

      // --- scheduled_end ---
      const sSchedEnd = _resolveDateTimeField(scheduled_end, existingChange.scheduled_end);
      if (sSchedEnd.error) {
        return { error: 'Invalid scheduled end date', redirect: `/changes/${id}/edit` };
      }

      if (sSchedStart.value && sSchedEnd.value && sSchedEnd.value < sSchedStart.value) {
        return { error: 'Scheduled end must be on or after scheduled start', redirect: `/changes/${id}/edit` };
      }

      // --- actual_start ---
      const sActStart = _resolveDateTimeField(actual_start, existingChange.actual_start);
      if (sActStart.error) {
        return { error: 'Invalid actual start date', redirect: `/changes/${id}/edit` };
      }

      // --- actual_end ---
      const sActEnd = _resolveDateTimeField(actual_end, existingChange.actual_end);
      if (sActEnd.error) {
        return { error: 'Invalid actual end date', redirect: `/changes/${id}/edit` };
      }

      if (sActStart.value && sActEnd.value && sActEnd.value < sActStart.value) {
        return { error: 'Actual end must be on or after actual start', redirect: `/changes/${id}/edit` };
      }

      _changeUpdateStmt.run(title.substring(0, MAX_MEDIUM_STR), (description || '').substring(0, MAX_DESC) || null, change_type, status, safePriority,
        sSchedStart.value, sSchedEnd.value, sActStart.value, sActEnd.value,
        (impact || '').substring(0, MAX_LONG_STR) || null, safeAssignee, id);
      return null;
    });
    const errResult = updateChange();

    if (errResult) {
      req.flash('error', errResult.error);
      return res.redirect(errResult.redirect);
    }

    req.audit('update', 'change', id, `Updated change "${title}" (status: ${status})`);
    req.flash('success', 'Change updated');
    invalidateDashboardCache();
    res.redirect(`/changes/${id}`);
  } catch (err) {
    if (err.message === 'NOT_FOUND') {
      req.flash('error', 'Change not found');
      return res.redirect('/changes');
    }
    if (err.message === 'ASSIGNEE_NOT_AVAILABLE') {
      req.flash('error', 'Selected assignee is not available');
      return res.redirect(`/changes/${id}/edit`);
    }
    console.error('Change update error:', err.message);
    req.flash('error', 'Error updating change. Please try again.');
    res.redirect(`/changes/${id}/edit`);
  }
});

// Delete change
router.delete('/:id', requireAdminOrManager, changeWriteLimiter, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid change ID');
    return res.redirect('/changes');
  }

  try {
    // Verify change exists and delete in a single transaction to avoid a
    // TOCTOU race where the change is deleted between the earlier existence
    // check and the DELETE (mirrors the change update transaction pattern).
    const deleteChange = db.transaction(() => {
      const existing = _editChangeStmt.get(id);
      if (!existing) {
        return { changes: 0 };
      }
      return { changes: _deleteChangeStmt.run(id).changes };
    });
    const result = deleteChange();
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
