const db = require('../models/database');
const { requireAuth, requireAdminOrManager } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { paginate, paginationBaseUrl, buildFilters, countQuery, selectQuery, safeSort, safeQueryValue, safeFilters } = require('../utils');
const { ALLOWED_ACTIONS, ALLOWED_ENTITY_TYPES } = require('../constants');
const rateLimit = require('express-rate-limit');

const router = require('express').Router();
router.use(requireAuth, requireAdminOrManager, auditMiddleware);

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

const SORT_MAP = Object.freeze({
  newest: 'a.created_at DESC',
  oldest: 'a.created_at ASC',
  default: 'a.created_at DESC'
});

router.get('/', auditLimiter, (req, res) => {
  // Record that the audit trail was accessed — a compromised privileged
  // account reading the full audit log should leave a trace of its own.
  req.audit('read', 'audit_log', null, 'Viewed audit log');

  const { page, limit, offset } = paginate(req);

  const qAction = safeQueryValue(req.query.action);
  const qEntityType = safeQueryValue(req.query.entity_type);
  const filters = buildFilters({
    'a.action': { value: ALLOWED_ACTIONS.includes(qAction) ? qAction : '' },
    'a.entity_type': { value: ALLOWED_ENTITY_TYPES.includes(qEntityType) ? qEntityType : '' }
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
    title: 'Audit Log', entries,
    filters: safeFilters(req.query, ['action', 'entity_type', 'sort']),
    page, limit, totalPages, total,
    baseUrl: paginationBaseUrl(req)
  });
});

module.exports = router;
/**
 * Reset module-level cached prepared statements (test use only).
 * Ensures test isolation when using mock db instances — consistent with
 * the same-named export in all other route modules.
 */
function resetCachedStatements() {
  // No module-level cached statements — audit.js uses countQuery/selectQuery
  // from utils.js which has its own resetCachedStatements(). This function
  // exists for API consistency across all route modules.
}
module.exports.resetCachedStatements = resetCachedStatements;
