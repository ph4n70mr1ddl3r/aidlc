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
let dashboardCache = { ts: 0, data: null };

// Defensive defaults — used when the cache is empty (e.g. first-request DB failure)
// so the template doesn't crash on property access like ticketStats.open.
const EMPTY_DEFAULTS = Object.freeze({
  ticketStats: { total: 0, open: 0, in_progress: 0, waiting: 0, resolved: 0, closed: 0, critical_open: 0 },
  assetStats: { total: 0, in_use: 0, in_storage: 0, in_repair: 0 },
  projectStats: { total: 0, in_progress: 0, planning: 0, completed: 0, on_hold: 0 },
  staffCount: { total: 0 },
  recentTickets: [],
  expiringWarranties: [],
  upcomingChanges: [],
  ticketsByCategory: [],
  staffWorkload: [],
  licenseAlerts: [],
});

function getDashboardData(user) {
  const now = Date.now();
  let shared;

  if (dashboardCache.data && (now - dashboardCache.ts) < DASHBOARD_TTL_MS) {
    shared = dashboardCache.data;
  } else {
    try {
      const ticketStats = db.prepare(`
        SELECT
          COUNT(*) as total,
          COALESCE(SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END), 0) as open,
          COALESCE(SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END), 0) as in_progress,
          COALESCE(SUM(CASE WHEN status = 'waiting' THEN 1 ELSE 0 END), 0) as waiting,
          COALESCE(SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END), 0) as resolved,
          COALESCE(SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END), 0) as closed,
          COALESCE(SUM(CASE WHEN priority = 'critical' AND status IN ('open','in_progress') THEN 1 ELSE 0 END), 0) as critical_open
        FROM tickets
      `).get();

      const assetStats = db.prepare(`
        SELECT
          COUNT(*) as total,
          COALESCE(SUM(CASE WHEN status = 'in_use' THEN 1 ELSE 0 END), 0) as in_use,
          COALESCE(SUM(CASE WHEN status = 'in_storage' THEN 1 ELSE 0 END), 0) as in_storage,
          COALESCE(SUM(CASE WHEN status = 'in_repair' THEN 1 ELSE 0 END), 0) as in_repair
        FROM assets
      `).get();

      const projectStats = db.prepare(`
        SELECT
          COUNT(*) as total,
          COALESCE(SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END), 0) as in_progress,
          COALESCE(SUM(CASE WHEN status = 'planning' THEN 1 ELSE 0 END), 0) as planning,
          COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) as completed,
          COALESCE(SUM(CASE WHEN status = 'on_hold' THEN 1 ELSE 0 END), 0) as on_hold
        FROM projects
      `).get();

      const staffCount = db.prepare('SELECT COUNT(*) as total FROM users WHERE is_active = 1').get();

      const recentTickets = db.prepare(`
        SELECT t.*, u.first_name || ' ' || u.last_name as assigned_name
        FROM tickets t
        LEFT JOIN users u ON t.assigned_to = u.id
        WHERE t.status NOT IN ('closed', 'resolved')
        ORDER BY t.updated_at DESC LIMIT 10
      `).all();

      const expiringWarranties = db.prepare(`
        SELECT * FROM assets
        WHERE warranty_expiry BETWEEN date('now') AND date('now', '+30 days')
        ORDER BY warranty_expiry ASC
      `).all();

      const upcomingChanges = db.prepare(`
        SELECT * FROM change_log
        WHERE status = 'scheduled' AND scheduled_start >= date('now')
        ORDER BY scheduled_start ASC LIMIT 5
      `).all();

      const ticketsByCategory = db.prepare(`
        SELECT category, COUNT(*) as count FROM tickets
        WHERE status IN ('open','in_progress','waiting')
        GROUP BY category ORDER BY count DESC
      `).all();

      const staffWorkload = db.prepare(`
        SELECT u.id, u.first_name || ' ' || u.last_name as name, u.role,
          COUNT(t.id) as open_tickets
        FROM users u
        LEFT JOIN tickets t ON t.assigned_to = u.id AND t.status IN ('open','in_progress','waiting')
        WHERE u.is_active = 1
        GROUP BY u.id
        ORDER BY open_tickets DESC
        LIMIT 8
      `).all();

      const licenseAlerts = db.prepare(`
        SELECT * FROM licenses
        WHERE expiry_date BETWEEN date('now') AND date('now', '+30 days')
        ORDER BY expiry_date ASC
      `).all();

      shared = {
        ticketStats, assetStats, projectStats, staffCount, recentTickets,
        expiringWarranties, upcomingChanges, ticketsByCategory, staffWorkload, licenseAlerts,
      };

      dashboardCache = { ts: now, data: shared };
    } catch (err) {
      console.error('Dashboard cache refresh error:', err.message);
      shared = dashboardCache.data || {};
    }
  }

  // Defensive defaults — if the shared cache is empty (e.g. first-request DB
  // failure), fill in stub objects so the template doesn't crash on property
  // access like ticketStats.open.
  const defaults = EMPTY_DEFAULTS;

  // Per-user tickets — always queried fresh (single indexed query)
  let myTickets = [];
  try {
    myTickets = db.prepare(`
      SELECT * FROM tickets 
      WHERE assigned_to = ? AND status IN ('open', 'in_progress', 'waiting')
      ORDER BY CASE priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 END, created_at ASC LIMIT 10
    `).all(user.id);
  } catch (err) {
    console.error('Dashboard myTickets query error:', err.message);
  }

  return { ...defaults, ...shared, myTickets };
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
    licenseAlerts: data.licenseAlerts,
  });
});

module.exports = router;
