const db = require('../models/database');
const { requireAuth, requireAdminOrManager } = require('../middleware/auth');
const { paginate, paginationBaseUrl, buildFilters, countQuery } = require('../utils');

const router = require('express').Router();
router.use(requireAuth, requireAdminOrManager);

const SORT_MAP = {
  newest: 'a.created_at DESC',
  oldest: 'a.created_at ASC'
};

const ALLOWED_ACTIONS = ['create', 'update', 'delete', 'login', 'logout', 'login_failed', 'login_blocked', 'login_rate_limited', 'deactivate', 'reactivate', 'comment'];

router.get('/', (req, res) => {
  const { page, limit, offset } = paginate(req);

  const filters = buildFilters({
    'a.action': { value: ALLOWED_ACTIONS.includes(req.query.action) ? req.query.action : '' },
    'a.entity_type': { value: req.query.entity_type ? req.query.entity_type : '' }
  }, ['a.action', 'a.entity_type']);

  const where = [...filters.where];
  const params = [...filters.params];

  const whereClause = where.length ? where.join(' AND ') : '1=1';

  const total = countQuery(db, 'audit_log', 'a', whereClause, params);
  const totalPages = Math.ceil(total / limit) || 1;
  const orderBy = SORT_MAP[req.query.sort] || SORT_MAP.newest;

  const entries = db.prepare(`
    SELECT a.*, u.first_name || ' ' || u.last_name as user_name
    FROM audit_log a
    LEFT JOIN users u ON a.user_id = u.id
    WHERE ${whereClause}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  res.render('pages/audit/index', {
    title: 'Audit Log', entries, filters: req.query,
    page, limit, totalPages, total,
    baseUrl: paginationBaseUrl(req)
  });
});

module.exports = router;
