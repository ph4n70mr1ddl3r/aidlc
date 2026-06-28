const db = require('../models/database');
const { requireAuth, requireAdminOrManager } = require('../middleware/auth');
const { paginate, paginationBaseUrl, buildFilters, countQuery, selectQuery, safeSort, safeQueryValue } = require('../utils');
const { ALLOWED_ACTIONS, ALLOWED_ENTITY_TYPES } = require('../constants');
const rateLimit = require('express-rate-limit');

const router = require('express').Router();
router.use(requireAuth, requireAdminOrManager);

// Rate limit the audit log endpoint — the LEFT JOIN over a fast-growing
// audit_log table is expensive and could be abused for DoS even behind
// admin/manager auth (e.g. a compromised privileged account). Mirrors the
// limiter applied to the /reports aggregation endpoints.
const auditLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 30,
  message: 'Too many audit log requests. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});

const SORT_MAP = {
  newest: 'a.created_at DESC',
  oldest: 'a.created_at ASC',
  default: 'a.created_at DESC'
};

router.get('/', auditLimiter, (req, res) => {
  const { page, limit, offset } = paginate(req);

  const filters = buildFilters({
    'a.action': { value: ALLOWED_ACTIONS.includes(safeQueryValue(req.query.action)) ? safeQueryValue(req.query.action) : '' },
    'a.entity_type': { value: ALLOWED_ENTITY_TYPES.includes(safeQueryValue(req.query.entity_type)) ? safeQueryValue(req.query.entity_type) : '' }
  }, ['a.action', 'a.entity_type']);

  const where = [...filters.where];
  const params = [...filters.params];

  const whereClause = where.length ? where.join(' AND ') : '1=1';

  const total = countQuery(db, 'audit_log', 'a', whereClause, params);
  const totalPages = Math.ceil(total / limit) || 1;
  const orderBy = safeSort(safeQueryValue(req.query.sort), SORT_MAP, 'default');

  const entries = selectQuery(db, `
    SELECT a.*, u.first_name || ' ' || u.last_name as user_name
    FROM audit_log a
    LEFT JOIN users u ON a.user_id = u.id
    WHERE ${whereClause}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `, [...params, limit, offset]);

  res.render('pages/audit/index', {
    title: 'Audit Log', entries, filters: req.query,
    page, limit, totalPages, total,
    baseUrl: paginationBaseUrl(req)
  });
});

module.exports = router;
