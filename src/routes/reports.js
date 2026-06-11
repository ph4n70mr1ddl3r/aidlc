const db = require('../models/database');
const { requireAuth, requireAdminOrManager } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { safeInt } = require('../utils');
const rateLimit = require('express-rate-limit');

const router = require('express').Router();
router.use(requireAuth, requireAdminOrManager, auditMiddleware);

// Rate limit report endpoints — aggregation queries are expensive and could
// be abused for DoS even behind admin/manager auth.
const reportLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 30,
  message: 'Too many report requests. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});
router.use(reportLimiter);

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
  assetsTotalValue: db.prepare('SELECT SUM(purchase_price) as total FROM assets'),
  // Also include already-expired warranties — they are more urgent than expiring-soon
  warrantyExpiring: db.prepare(`
    SELECT * FROM assets WHERE warranty_expiry IS NOT NULL AND warranty_expiry <= date('now', '+90 days')
    ORDER BY warranty_expiry ASC
  `),
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
    GROUP BY age_group ORDER BY age_group
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
        AVG(julianday(resolved_at) - julianday(created_at)) as avg_resolution_days
      FROM tickets WHERE resolved_at IS NOT NULL
        AND resolved_at >= date('now', '-' || ? || ' days')
      GROUP BY assigned_to
    ) tResolved ON tResolved.assigned_to = u.id
    LEFT JOIN (
      SELECT assigned_to, COUNT(*) as completed_tasks
      FROM project_tasks WHERE status = 'done'
        AND completed_at >= date('now', '-' || ? || ' days')
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
    const period = Math.max(1, Math.min(365, safeInt(req.query.period, 30)));

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
    const byCategory = stmts.assetsByCategory.all();
    const byStatus = stmts.assetsByStatus.all();
    const byCondition = stmts.assetsByCondition.all();
    const totalValue = stmts.assetsTotalValue.get();
    const warrantyExpiring = stmts.warrantyExpiring.all();
    const ageDistribution = stmts.ageDistribution.all();

    res.render('pages/reports/assets', {
      title: 'Asset Report', byCategory, byStatus, byCondition,
      totalValue, warrantyExpiring, ageDistribution
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
    const period = Math.max(1, Math.min(365, safeInt(req.query.period, 30)));
    const performance = stmts.staffPerformance.all(period, period);

    res.render('pages/reports/staff', { title: 'Staff Performance', performance, period });
  } catch (err) {
    console.error('Staff report error:', err.message);
    req.flash('error', 'Error generating staff report');
    res.redirect('/reports');
  }
});

module.exports = router;
