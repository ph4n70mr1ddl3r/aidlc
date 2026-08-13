const db = require('../models/database');
const { requireAuth, requireAdminOrManager } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { paginate, paginationBaseUrl, buildFilters, countQuery, selectQuery, safeSort, safeQueryValue, safeFilters, rejectHppArrays } = require('../utils');
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
  // Fail closed on HTTP parameter pollution: reject array payloads on query
  // params. The "simple" query parser turns duplicate keys (?action=a&action=b)
  // into arrays; buildFilters/safeQueryValue collapse them safely, but the
  // audit log is the single read-only surface where a filter value is echoed
  // back into the rendered page (safeFilters) — so arrays are rejected here to
  // keep the response deterministic. rejectHppArrays inspects both req.query
  // and req.body, matching the fail-closed behavior of every write route.
  const hppQueryErrors = rejectHppArrays(req, ['action', 'entity_type', 'sort']);
  if (hppQueryErrors.length > 0) {
    req.flash('error', 'Invalid request parameters');
    return res.redirect('/audit');
  }

  // Record that the audit trail was accessed — a compromised privileged
  // account reading the full audit log should leave a trace of its own.
  req.audit('read', 'audit_log', null, 'Viewed audit log');

  const { page: requestedPage, limit } = paginate(req);

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
  // Clamp the requested page to the actual page count so a page beyond the
  // last one (e.g. ?page=999) renders the final page instead of an empty list
  // with a broken "Showing N–M" range (M < N) in the pagination partial.
  const page = Math.min(requestedPage, totalPages);
  const offset = (page - 1) * limit;
  const orderBy = safeSort(safeQueryValue(req.query.sort), SORT_MAP, 'default');

  const entries = selectQuery(db, `
    SELECT a.action, a.entity_type, a.entity_id, a.ip_address, a.details, a.created_at,
      u.first_name || ' ' || u.last_name as user_name
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
module.exports = router;
module.exports.resetCachedStatements = resetCachedStatements;
