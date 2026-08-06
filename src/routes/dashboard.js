const db = require('../models/database');
const { requireAuth } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const rateLimit = require('express-rate-limit');

// Rate limit dashboard requests to prevent abuse of aggregation queries
const dashboardLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  message: 'Too many dashboard requests. Please wait.',
  standardHeaders: true,
  legacyHeaders: false
});

const router = require('express').Router();
router.use(requireAuth, auditMiddleware, dashboardLimiter); // Added dashboardLimiter here

// ---------------------------------------------------------------------------
// Simple in-memory dashboard cache (30 s TTL).
// Only shared aggregation queries are cached — per-user data ("my tickets")
// is queried fresh each request so it stays accurate without inflating the
// cache to O(staff_count) size.
//
// NOTE: Because better-sqlite3 is synchronous, there is no opportunity for
// concurrent requests to hit the cache simultaneously — Node.js processes
// one request at a time. An async DB driver would need a "refreshing" lock
// to avoid stampede, but here a simple TTL check is sufficient.
// ---------------------------------------------------------------------------
// Named limits keep the query strings readable and make it trivial to tune
// the caps in one place instead of hunting through raw SQL literals.
const _DASH_RECENT_TICKETS_LIMIT = 10;
const _DASH_WARRANTY_LIMIT = 20;
const _DASH_UPCOMING_CHANGES_LIMIT = 5;
const _DASH_STAFF_WORKLOAD_LIMIT = 8;
const _DASH_LICENSE_ALERTS_LIMIT = 20;

const _parsedDTTL = parseInt(process.env.DASHBOARD_TTL_MS, 10);
// Clamp TTL to [1s, 1h] so accidental 0 (cache-bust on every request) or
// astronomically large values (days/weeks of stale data) cannot occur.
const DASHBOARD_TTL_MS = Number.isFinite(_parsedDTTL) ? Math.max(1_000, Math.min(3_600_000, _parsedDTTL)) : 30_000;
let dashboardCache = { timestamp: 0, data: null };
// Flag to prevent cache stampede — when a refresh is already in progress,
// in-flight requests serve the previous cache (or EMPTY_DEFAULTS) instead of
// all hitting the DB at once when the TTL expires. Safer than a bare TTL when
// multiple requests can arrive concurrently (e.g. browser tab reloads, health
// probes that hit the dashboard). The comment above notes better-sqlite3 is
// single-threaded, but a stampede can still fire from different processes or
// when the cache is explicitly invalidated multiple times in quick succession.
let _dashboardRefreshing = false;

// Defensive defaults — used when the cache is empty (e.g. first-request DB failure)
// so the template doesn't crash on property access like ticketStats.open.
const EMPTY_DEFAULTS = {
  ticketStats: { total: 0, open: 0, in_progress: 0, waiting: 0, resolved: 0, closed: 0, critical_open: 0 },
  assetStats: { total: 0, in_use: 0, in_storage: 0, in_repair: 0 },
  projectStats: { total: 0, in_progress: 0, planning: 0, completed: 0, on_hold: 0 },
  staffCount: { total: 0 },
  recentTickets: [],
  expiringWarranties: [],
  upcomingChanges: [],
  ticketsByCategory: [],
  staffWorkload: [],
  licenseAlerts: []
};

// ---------------------------------------------------------------------------
// Cached prepared statements for frequently-executed queries.
// better-sqlite3 prepare() is relatively expensive; caching avoids re-parsing
// the SQL on every request.
// ---------------------------------------------------------------------------
const stmts = {
  ticketStats: db.prepare(`
    SELECT
      COUNT(*) as total,
      COALESCE(SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END), 0) as open,
      COALESCE(SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END), 0) as in_progress,
      COALESCE(SUM(CASE WHEN status = 'waiting' THEN 1 ELSE 0 END), 0) as waiting,
      COALESCE(SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END), 0) as resolved,
      COALESCE(SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END), 0) as closed,
      COALESCE(SUM(CASE WHEN priority = 'critical' AND status IN ('open','in_progress') THEN 1 ELSE 0 END), 0) as critical_open
    FROM tickets
  `),
  assetStats: db.prepare(`
    SELECT
      COUNT(*) as total,
      COALESCE(SUM(CASE WHEN status = 'in_use' THEN 1 ELSE 0 END), 0) as in_use,
      COALESCE(SUM(CASE WHEN status = 'in_storage' THEN 1 ELSE 0 END), 0) as in_storage,
      COALESCE(SUM(CASE WHEN status = 'in_repair' THEN 1 ELSE 0 END), 0) as in_repair
    FROM assets
  `),
  projectStats: db.prepare(`
    SELECT
      COUNT(*) as total,
      COALESCE(SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END), 0) as in_progress,
      COALESCE(SUM(CASE WHEN status = 'planning' THEN 1 ELSE 0 END), 0) as planning,
      COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) as completed,
      COALESCE(SUM(CASE WHEN status = 'on_hold' THEN 1 ELSE 0 END), 0) as on_hold
    FROM projects
  `),
  staffCount: db.prepare('SELECT COUNT(*) as total FROM users WHERE is_active = 1'),
  recentTickets: db.prepare(`
    SELECT t.id, t.ticket_number, t.title, t.category, t.priority, t.status, t.created_at,
            u.first_name || ' ' || u.last_name as assigned_name
    FROM tickets t
    LEFT JOIN users u ON t.assigned_to = u.id
    WHERE t.status NOT IN ('closed', 'resolved')
    ORDER BY t.updated_at DESC LIMIT ${_DASH_RECENT_TICKETS_LIMIT}
  `),
  // Include already-expired warranties — they are more urgent than expiring-soon.
  // Must use `<=` instead of `BETWEEN` because BETWEEN excludes dates before today.
  // Exclude disposed assets: their warranties are no longer actionable, so showing
  // them here would produce misleading "expiring soon" alerts. Mirrors the
  // reports warrantyExpiring query.
  expiringWarranties: db.prepare(`
    SELECT id, name, asset_tag, warranty_expiry FROM assets
    WHERE warranty_expiry IS NOT NULL AND warranty_expiry <= date('now', '+30 days')
      AND status != 'disposed'
    ORDER BY warranty_expiry ASC
    LIMIT ${_DASH_WARRANTY_LIMIT}
  `),
  upcomingChanges: db.prepare(`
    SELECT id, title, scheduled_start FROM change_log
    WHERE status = 'scheduled' AND scheduled_start >= strftime('%Y-%m-%d %H:%M', 'now')
    ORDER BY scheduled_start ASC LIMIT ${_DASH_UPCOMING_CHANGES_LIMIT}
  `),
  ticketsByCategory: db.prepare(`
    SELECT category, COUNT(*) as count FROM tickets
    WHERE status IN ('open','in_progress','waiting')
    GROUP BY category ORDER BY count DESC
  `),
  staffWorkload: db.prepare(`
    SELECT u.id, u.first_name || ' ' || u.last_name as name, u.role,
      COUNT(t.id) as open_tickets
    FROM users u
    LEFT JOIN tickets t ON t.assigned_to = u.id AND t.status IN ('open','in_progress','waiting')
    WHERE u.is_active = 1
    GROUP BY u.id
    ORDER BY open_tickets DESC
    LIMIT ${_DASH_STAFF_WORKLOAD_LIMIT}
  `),
  // Only select the columns the dashboard template renders (expiry_date for
  // ordering/display). Avoid SELECT * so the sensitive license_key column is
  // never loaded into the shared/rendered data object — defense-in-depth that
  // shrinks the credential-exposure surface of the cached dashboard payload.
  licenseAlerts: db.prepare(`
    SELECT id, software_name, vendor, expiry_date FROM licenses
    WHERE expiry_date IS NOT NULL AND expiry_date <= date('now', '+30 days')
    ORDER BY expiry_date ASC
    LIMIT ${_DASH_LICENSE_ALERTS_LIMIT}
  `),
  // Only select the columns the dashboard template renders (mirrors recentTickets).
  // Avoid SELECT * so sensitive columns like requester_email/requester_phone are
  // never loaded into the shared data object — defense-in-depth that shrinks the
  // PII-exposure surface of any code that serializes or caches this result.
  myTickets: db.prepare(`
    SELECT t.id, t.ticket_number, t.title, t.category, t.priority, t.status, t.created_at,
            u.first_name || ' ' || u.last_name as assigned_name
    FROM tickets t
    LEFT JOIN users u ON t.assigned_to = u.id
    WHERE t.assigned_to = ? AND t.status IN ('open', 'in_progress', 'waiting')
    ORDER BY CASE t.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END, t.created_at ASC LIMIT ${_DASH_RECENT_TICKETS_LIMIT}
  `)
};

function getDashboardData(user) {
  const now = Date.now();
  let shared;

  if (dashboardCache.data && (now - dashboardCache.timestamp) < DASHBOARD_TTL_MS && !_dashboardRefreshing) {
    shared = dashboardCache.data;
  } else {
    // If a refresh is already in progress, serve the previous cache (or defaults)
    // to avoid a stampede where N concurrent requests all hit the DB simultaneously.
    if (_dashboardRefreshing) {
      shared = dashboardCache.data || EMPTY_DEFAULTS;
    } else {
      _dashboardRefreshing = true;
      try {
        shared = {
          ticketStats: stmts.ticketStats.get(),
          assetStats: stmts.assetStats.get(),
          projectStats: stmts.projectStats.get(),
          staffCount: stmts.staffCount.get(),
          recentTickets: stmts.recentTickets.all(),
          expiringWarranties: stmts.expiringWarranties.all(),
          upcomingChanges: stmts.upcomingChanges.all(),
          ticketsByCategory: stmts.ticketsByCategory.all(),
          staffWorkload: stmts.staffWorkload.all(),
          licenseAlerts: stmts.licenseAlerts.all()
        };

        dashboardCache = { timestamp: now, data: shared };
      } catch (err) {
        console.error('Dashboard cache refresh error:', err.message);
        // On DB error, re-use previous cache if available (stale data is better
        // than an empty/broken dashboard). Only fall back to EMPTY_DEFAULTS if
        // there is no prior cache at all (first-request failure).
        // Do NOT update the timestamp so the next request retries immediately
        // instead of waiting for the full TTL before refreshing.
        shared = dashboardCache.data || EMPTY_DEFAULTS;
      } finally {
        _dashboardRefreshing = false;
      }
    }
  }

  // Per-user tickets — always queried fresh (single indexed query)
  let myTickets = [];
  try {
    myTickets = stmts.myTickets.all(user.id);
  } catch (err) {
    console.error('Dashboard myTickets query error:', err.message);
  }

  // Deep-merge defaults to avoid shared nested object references between cache
  // and rendered data.  Object.assign only copies one level deep, so mutating a
  // nested object in a template (e.g. ticketStats.open) would corrupt the cache.
  const result = {
    ticketStats: { ...EMPTY_DEFAULTS.ticketStats, ...(shared.ticketStats || {}) },
    assetStats: { ...EMPTY_DEFAULTS.assetStats, ...(shared.assetStats || {}) },
    projectStats: { ...EMPTY_DEFAULTS.projectStats, ...(shared.projectStats || {}) },
    staffCount: { ...EMPTY_DEFAULTS.staffCount, ...(shared.staffCount || {}) },
    recentTickets: (shared.recentTickets || EMPTY_DEFAULTS.recentTickets).map(r => ({ ...r })),
    expiringWarranties: (shared.expiringWarranties || EMPTY_DEFAULTS.expiringWarranties).map(r => ({ ...r })),
    upcomingChanges: (shared.upcomingChanges || EMPTY_DEFAULTS.upcomingChanges).map(r => ({ ...r })),
    ticketsByCategory: (shared.ticketsByCategory || EMPTY_DEFAULTS.ticketsByCategory).map(r => ({ ...r })),
    staffWorkload: (shared.staffWorkload || EMPTY_DEFAULTS.staffWorkload).map(r => ({ ...r })),
    licenseAlerts: (shared.licenseAlerts || EMPTY_DEFAULTS.licenseAlerts).map(r => ({ ...r })),
    myTickets: myTickets.map(r => ({ ...r }))
  };
  return result;
}

/**
 * Invalidate the dashboard cache so the next request refreshes data.
 * Called after ticket/asset/project/staff writes to avoid stale dashboard stats.
 */
function invalidateDashboardCache() {
  dashboardCache = { timestamp: 0, data: null };
  // Reset the refreshing flag so a concurrent or subsequent invalidation
  // does not leave the cache in a half-refreshed state where the next
  // request serves EMPTY_DEFAULTS indefinitely instead of triggering a
  // fresh aggregation query.
  _dashboardRefreshing = false;
}

router.get('/', (req, res) => {
  const data = getDashboardData(req.session.user);

  res.render('pages/dashboard', { title: 'Dashboard', ...data });
});

/**
 * Reset the dashboard cache and module-level state (test use only).
 * Ensures test isolation when using mock db instances — consistent with
 * the same-named export in middleware/auth.js, audit.js, utils.js, etc.
 * Resets the TTL cache to force a fresh query on the next request.
 */
function resetCachedStatements() {
  dashboardCache = { timestamp: 0, data: null };
  _dashboardRefreshing = false;
}

module.exports = router;
module.exports.invalidateDashboardCache = invalidateDashboardCache;
module.exports.resetCachedStatements = resetCachedStatements;
// Exposed for unit testing against a real in-memory DB (mirrors the test-export
// pattern in tickets.js / vendors.js). Unit tests in tests/dashboard.test.js use
// this export to assert statement shapes and verify the disposed-asset warranty
// exclusion; tests/reports.test.js also references dashboard.__stmts to verify
// the same disposed-asset exclusion pattern on the dashboard side.
module.exports.__stmts = stmts;
