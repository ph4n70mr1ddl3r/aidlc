const db = require('../models/database');
const { requireAuth } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

const router = require('express').Router();
router.use(requireAuth, auditMiddleware);

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
const DASHBOARD_TTL_MS = 30_000;
let dashboardCache = { timestamp: 0, data: null };

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
    SELECT t.*, u.first_name || ' ' || u.last_name as assigned_name
    FROM tickets t
    LEFT JOIN users u ON t.assigned_to = u.id
    WHERE t.status NOT IN ('closed', 'resolved')
    ORDER BY t.updated_at DESC LIMIT 10
  `),
  // Include already-expired warranties — they are more urgent than expiring-soon.
  // Must use `<=` instead of `BETWEEN` because BETWEEN excludes dates before today.
  expiringWarranties: db.prepare(`
    SELECT * FROM assets
    WHERE warranty_expiry IS NOT NULL AND warranty_expiry <= date('now', '+30 days')
    ORDER BY warranty_expiry ASC
    LIMIT 20
  `),
  upcomingChanges: db.prepare(`
    SELECT * FROM change_log
    WHERE status = 'scheduled' AND scheduled_start >= datetime('now')
    ORDER BY scheduled_start ASC LIMIT 5
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
    LIMIT 8
  `),
  licenseAlerts: db.prepare(`
    SELECT * FROM licenses
    WHERE expiry_date IS NOT NULL AND expiry_date <= date('now', '+30 days')
    ORDER BY expiry_date ASC
    LIMIT 20
  `),
  myTickets: db.prepare(`
    SELECT * FROM tickets 
    WHERE assigned_to = ? AND status IN ('open', 'in_progress', 'waiting')
    ORDER BY CASE priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 END, created_at ASC LIMIT 10
  `)
};

function getDashboardData(user) {
  const now = Date.now();
  let shared;

  if (dashboardCache.data && (now - dashboardCache.timestamp) < DASHBOARD_TTL_MS) {
    shared = dashboardCache.data;
  } else {
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
      shared = dashboardCache.data || EMPTY_DEFAULTS;
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
    recentTickets: [...(shared.recentTickets || EMPTY_DEFAULTS.recentTickets)],
    expiringWarranties: [...(shared.expiringWarranties || EMPTY_DEFAULTS.expiringWarranties)],
    upcomingChanges: [...(shared.upcomingChanges || EMPTY_DEFAULTS.upcomingChanges)],
    ticketsByCategory: [...(shared.ticketsByCategory || EMPTY_DEFAULTS.ticketsByCategory)],
    staffWorkload: [...(shared.staffWorkload || EMPTY_DEFAULTS.staffWorkload)],
    licenseAlerts: [...(shared.licenseAlerts || EMPTY_DEFAULTS.licenseAlerts)],
    myTickets: [...myTickets]
  };
  return result;
}

/**
 * Invalidate the dashboard cache so the next request refreshes data.
 * Called after ticket/asset/project/staff writes to avoid stale dashboard stats.
 */
function invalidateDashboardCache() {
  dashboardCache = { timestamp: 0, data: null };
}

router.get('/', (req, res) => {
  const data = getDashboardData(req.session.user);

  res.render('pages/dashboard', {
    title: 'Dashboard',
    ticketStats: data.ticketStats,
    assetStats: data.assetStats,
    projectStats: data.projectStats,
    staffCount: data.staffCount,
    recentTickets: data.recentTickets,
    myTickets: data.myTickets,
    expiringWarranties: data.expiringWarranties,
    upcomingChanges: data.upcomingChanges,
    ticketsByCategory: data.ticketsByCategory,
    staffWorkload: data.staffWorkload,
    licenseAlerts: data.licenseAlerts
  });
});

module.exports = router;
module.exports.invalidateDashboardCache = invalidateDashboardCache;
