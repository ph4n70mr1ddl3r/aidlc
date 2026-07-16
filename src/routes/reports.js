const db = require('../models/database');
const { requireAuth, requireAdminOrManager } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { safeInt, safeQueryValue } = require('../utils');
const rateLimit = require('express-rate-limit');

const router = require('express').Router();
router.use(requireAuth, requireAdminOrManager, auditMiddleware);

// Rate limit report endpoints — aggregation queries are expensive and could
// be abused for DoS even behind admin/manager auth.
// Only apply to data endpoints, not the index landing page.
const reportLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 30,
  handler: (req, res) => {
    req.flash('error', 'Too many report requests. Please try again later.');
    res.redirect('/reports');
  },
  standardHeaders: true,
  legacyHeaders: false
});
router.use(['/tickets', '/assets', '/staff'], reportLimiter);

// ---------------------------------------------------------------------------
// Cached prepared statements for report queries.
// better-sqlite3 prepare() is relatively expensive; caching avoids re-parsing
// the SQL on every request.
// ---------------------------------------------------------------------------
const stmts = {
  // Ticket Analytics
  ticketsByDay: db.prepare(`
    SELECT date(created_at) as date, COUNT(*) as count
    FROM tickets
    WHERE created_at >= date('now', '-' || ? || ' days')
    GROUP BY date(created_at)
    ORDER BY date ASC
  `),
  ticketsByCategory: db.prepare(`
    SELECT category, COUNT(*) as count FROM tickets
    WHERE created_at >= date('now', '-' || ? || ' days')
    GROUP BY category ORDER BY count DESC
  `),
  ticketsByPriority: db.prepare(`
    SELECT priority, COUNT(*) as count FROM tickets
    WHERE created_at >= date('now', '-' || ? || ' days')
    GROUP BY priority ORDER BY count DESC
  `),
  avgResolution: db.prepare(`
    SELECT AVG(julianday(resolved_at) - julianday(created_at)) as avg_days
    FROM tickets
    WHERE resolved_at IS NOT NULL AND created_at >= date('now', '-' || ? || ' days')
  `),
  slaStats: db.prepare(`
    SELECT
      COUNT(*) as total_resolved,
      SUM(CASE WHEN julianday(resolved_at) - julianday(created_at) <= 1 THEN 1 ELSE 0 END) as within_1d,
      SUM(CASE WHEN julianday(resolved_at) - julianday(created_at) <= 3 THEN 1 ELSE 0 END) as within_3d,
      SUM(CASE WHEN julianday(resolved_at) - julianday(created_at) <= 7 THEN 1 ELSE 0 END) as within_7d
    FROM tickets
    WHERE resolved_at IS NOT NULL AND created_at >= date('now', '-' || ? || ' days')
  `),
  topResolvers: db.prepare(`
    SELECT u.first_name || ' ' || u.last_name as name, COUNT(*) as resolved
    FROM tickets t
    JOIN users u ON t.assigned_to = u.id
    WHERE t.resolved_at IS NOT NULL AND t.created_at >= date('now', '-' || ? || ' days')
    GROUP BY t.assigned_to
    ORDER BY resolved DESC LIMIT 10
  `),
  // Asset Report
  assetsByCategory: db.prepare(`
    SELECT category, COUNT(*) as count, SUM(purchase_price) as total_value
    FROM assets GROUP BY category ORDER BY count DESC
  `),
  assetsByStatus: db.prepare(`
    SELECT status, COUNT(*) as count FROM assets GROUP BY status ORDER BY count DESC
  `),
  assetsByCondition: db.prepare(`
    SELECT condition_rating, COUNT(*) as count FROM assets GROUP BY condition_rating ORDER BY count DESC
  `),
  assetsTotalValue: db.prepare('SELECT COALESCE(SUM(purchase_price), 0) as total FROM assets'),
  // Also include already-expired warranties — they are more urgent than expiring-soon.
  // Exclude disposed assets: a disposed asset's warranty is no longer actionable,
  // so surfacing it in the "expiring soon" alert/list is noise. Mirrors the
  // dashboard's expiringWarranties query.
  // Separate COUNT for the stat card — the list query below is capped (LIMIT)
  // to bound rendering cost on large inventories, so warrantyExpiring.length
  // would undercount. Mirrors the dashboard's defensive LIMIT 20.
  warrantyExpiringCount: db.prepare(`
    SELECT COUNT(*) as c FROM assets WHERE warranty_expiry IS NOT NULL AND warranty_expiry <= date('now', '+90 days') AND status != 'disposed'
  `),
  warrantyExpiring: db.prepare(`
    SELECT * FROM assets WHERE warranty_expiry IS NOT NULL AND warranty_expiry <= date('now', '+90 days') AND status != 'disposed'
    ORDER BY warranty_expiry ASC LIMIT 500
  `),
  // ORDER BY age_group sorts the buckets LEXICOGRAPHICALLY, which puts '< 1 year'
  // LAST (because '<' is ASCII 60, after the digits '1'..'4'). Use an explicit
  // CASE mapping so the buckets appear in natural age order (newest first).
  ageDistribution: db.prepare(`
    SELECT 
      CASE 
        WHEN julianday('now') - julianday(purchase_date) < 365 THEN '< 1 year'
        WHEN julianday('now') - julianday(purchase_date) < 730 THEN '1-2 years'
        WHEN julianday('now') - julianday(purchase_date) < 1095 THEN '2-3 years'
        WHEN julianday('now') - julianday(purchase_date) < 1460 THEN '3-4 years'
        ELSE '4+ years'
      END as age_group,
      COUNT(*) as count
    FROM assets WHERE purchase_date IS NOT NULL
    GROUP BY age_group
    ORDER BY CASE age_group
      WHEN '< 1 year' THEN 1
      WHEN '1-2 years' THEN 2
      WHEN '2-3 years' THEN 3
      WHEN '3-4 years' THEN 4
      WHEN '4+ years' THEN 5
      ELSE 99
    END
  `),
  // Staff Performance
  staffPerformance: db.prepare(`
    SELECT u.id, u.first_name || ' ' || u.last_name as name, u.role,
      COALESCE(tOpen.open_tickets, 0) as open_tickets,
      COALESCE(tResolved.resolved_tickets, 0) as resolved_tickets,
      tResolved.avg_resolution_days,
      COALESCE(ptDone.completed_tasks, 0) as completed_tasks
    FROM users u
    LEFT JOIN (
      SELECT assigned_to, COUNT(*) as open_tickets
      FROM tickets WHERE status IN ('open','in_progress','waiting')
      GROUP BY assigned_to
    ) tOpen ON tOpen.assigned_to = u.id
    LEFT JOIN (
      SELECT assigned_to, COUNT(*) as resolved_tickets,
        COALESCE(AVG(julianday(resolved_at) - julianday(created_at)), 0) as avg_resolution_days
      FROM tickets WHERE resolved_at IS NOT NULL
        AND resolved_at >= date('now', '-' || ? || ' days')
      GROUP BY assigned_to
    ) tResolved ON tResolved.assigned_to = u.id
    LEFT JOIN (
      SELECT assigned_to, COUNT(*) as completed_tasks
      FROM project_tasks WHERE status = 'done'
        AND COALESCE(completed_at, updated_at) >= date('now', '-' || ? || ' days')
      GROUP BY assigned_to
    ) ptDone ON ptDone.assigned_to = u.id
    WHERE u.is_active = 1
    ORDER BY resolved_tickets DESC
  `)
};

// Reports dashboard
router.get('/', (req, res) => {
  res.render('pages/reports/index', { title: 'Reports' });
});

// Ticket Analytics
router.get('/tickets', (req, res) => {
  try {
    const period = Math.max(1, Math.min(365, safeInt(safeQueryValue(req.query.period), 30)));
    req.audit('read', 'ticket', null, 'Viewed ticket analytics report');

    const ticketsByDay = stmts.ticketsByDay.all(period);
    const byCategory = stmts.ticketsByCategory.all(period);
    const byPriority = stmts.ticketsByPriority.all(period);
    const avgResolution = stmts.avgResolution.get(period);
    const slaStats = stmts.slaStats.get(period);
    const topResolvers = stmts.topResolvers.all(period);

    res.render('pages/reports/tickets', {
      title: 'Ticket Analytics', ticketsByDay, byCategory, byPriority,
      avgResolution, slaStats, topResolvers, period
    });
  } catch (err) {
    console.error('Ticket report error:', err.message);
    req.flash('error', 'Error generating ticket report');
    res.redirect('/reports');
  }
});

// Asset Report
router.get('/assets', (req, res) => {
  try {
    req.audit('read', 'asset', null, 'Viewed asset report');
    const byCategory = stmts.assetsByCategory.all();
    const byStatus = stmts.assetsByStatus.all();
    const byCondition = stmts.assetsByCondition.all();
    const totalValue = stmts.assetsTotalValue.get();
    const warrantyCount = stmts.warrantyExpiringCount.get().c;
    const warrantyExpiring = stmts.warrantyExpiring.all();
    const ageDistribution = stmts.ageDistribution.all();

    res.render('pages/reports/assets', {
      title: 'Asset Report', byCategory, byStatus, byCondition,
      totalValue, warrantyCount, warrantyExpiring, ageDistribution
    });
  } catch (err) {
    console.error('Asset report error:', err.message);
    req.flash('error', 'Error generating asset report');
    res.redirect('/reports');
  }
});

// Staff Performance
router.get('/staff', (req, res) => {
  try {
    const period = Math.max(1, Math.min(365, safeInt(safeQueryValue(req.query.period), 30)));
    req.audit('read', 'user', null, 'Viewed staff performance report');
    // Two ? placeholders in the SQL: one for resolved_tickets period, one for completed_tasks period
    const performance = stmts.staffPerformance.all(period, period);

    res.render('pages/reports/staff', { title: 'Staff Performance', performance, period });
  } catch (err) {
    console.error('Staff report error:', err.message);
    req.flash('error', 'Error generating staff report');
    res.redirect('/reports');
  }
});

module.exports = router;
// Exposed for unit testing against a real in-memory DB (mirrors the test-export
// pattern in tickets.js / vendors.js / knowledge.js). Guards the age-bucket
// ordering and the disposed-asset warranty exclusion against regression.
module.exports.__stmts = stmts;
