const db = require('../models/database');
const { requireAuth } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { safeInt } = require('../utils');

const router = require('express').Router();
router.use(requireAuth, auditMiddleware);

// Reports dashboard
router.get('/', (req, res) => {
  res.render('pages/reports/index', { title: 'Reports' });
});

// Ticket Analytics
router.get('/tickets', (req, res) => {
  const period = Math.max(1, Math.min(365, safeInt(req.query.period, 30)));
  
  // Tickets over time (by day)
  const ticketsByDay = db.prepare(`
    SELECT date(created_at) as date, COUNT(*) as count
    FROM tickets
    WHERE created_at >= date('now', '-' || ? || ' days')
    GROUP BY date(created_at)
    ORDER BY date ASC
  `).all(period);

  // By category
  const byCategory = db.prepare(`
    SELECT category, COUNT(*) as count FROM tickets
    WHERE created_at >= date('now', '-' || ? || ' days')
    GROUP BY category ORDER BY count DESC
  `).all(period);

  // By priority
  const byPriority = db.prepare(`
    SELECT priority, COUNT(*) as count FROM tickets
    WHERE created_at >= date('now', '-' || ? || ' days')
    GROUP BY priority ORDER BY count DESC
  `).all(period);

  // Avg resolution time
  const avgResolution = db.prepare(`
    SELECT AVG(julianday(resolved_at) - julianday(created_at)) as avg_days
    FROM tickets
    WHERE resolved_at IS NOT NULL AND created_at >= date('now', '-' || ? || ' days')
  `).get(period);

  // SLA stats
  const slaStats = db.prepare(`
    SELECT
      COUNT(*) as total_resolved,
      SUM(CASE WHEN julianday(resolved_at) - julianday(created_at) <= 1 THEN 1 ELSE 0 END) as within_1d,
      SUM(CASE WHEN julianday(resolved_at) - julianday(created_at) <= 3 THEN 1 ELSE 0 END) as within_3d,
      SUM(CASE WHEN julianday(resolved_at) - julianday(created_at) <= 7 THEN 1 ELSE 0 END) as within_7d
    FROM tickets
    WHERE resolved_at IS NOT NULL AND created_at >= date('now', '-' || ? || ' days')
  `).get(period);

  // Top resolvers
  const topResolvers = db.prepare(`
    SELECT u.first_name || ' ' || u.last_name as name, COUNT(*) as resolved
    FROM tickets t
    JOIN users u ON t.assigned_to = u.id
    WHERE t.resolved_at IS NOT NULL AND t.created_at >= date('now', '-' || ? || ' days')
    GROUP BY t.assigned_to
    ORDER BY resolved DESC LIMIT 10
  `).all(period);

  res.render('pages/reports/tickets', {
    title: 'Ticket Analytics', ticketsByDay, byCategory, byPriority,
    avgResolution, slaStats, topResolvers, period
  });
});

// Asset Report
router.get('/assets', (req, res) => {
  const byCategory = db.prepare(`
    SELECT category, COUNT(*) as count, SUM(purchase_price) as total_value
    FROM assets GROUP BY category ORDER BY count DESC
  `).all();

  const byStatus = db.prepare(`
    SELECT status, COUNT(*) as count FROM assets GROUP BY status ORDER BY count DESC
  `).all();

  const byCondition = db.prepare(`
    SELECT condition_rating, COUNT(*) as count FROM assets GROUP BY condition_rating ORDER BY count DESC
  `).all();

  const totalValue = db.prepare('SELECT SUM(purchase_price) as total FROM assets').get();
  const warrantyExpiring = db.prepare(`
    SELECT * FROM assets WHERE warranty_expiry BETWEEN date('now') AND date('now', '+90 days')
    ORDER BY warranty_expiry ASC
  `).all();

  const ageDistribution = db.prepare(`
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
  `).all();

  res.render('pages/reports/assets', {
    title: 'Asset Report', byCategory, byStatus, byCondition,
    totalValue, warrantyExpiring, ageDistribution
  });
});

// Staff Performance
router.get('/staff', (req, res) => {
  const period = Math.max(1, Math.min(365, safeInt(req.query.period, 30)));
  
  const performance = db.prepare(`
    SELECT u.id, u.first_name || ' ' || u.last_name as name, u.role,
      (SELECT COUNT(*) FROM tickets WHERE assigned_to = u.id AND status IN ('open','in_progress','waiting')) as open_tickets,
      (SELECT COUNT(*) FROM tickets WHERE assigned_to = u.id AND resolved_at IS NOT NULL 
        AND resolved_at >= date('now', '-' || ? || ' days')) as resolved_tickets,
      (SELECT AVG(julianday(resolved_at) - julianday(created_at)) 
        FROM tickets WHERE assigned_to = u.id AND resolved_at IS NOT NULL
        AND resolved_at >= date('now', '-' || ? || ' days')) as avg_resolution_days,
      (SELECT COUNT(*) FROM project_tasks WHERE assigned_to = u.id AND status = 'done'
        AND completed_at >= date('now', '-' || ? || ' days')) as completed_tasks
    FROM users u
    WHERE u.is_active = 1
    ORDER BY resolved_tickets DESC
  `).all(period, period, period);

  res.render('pages/reports/staff', { title: 'Staff Performance', performance, period });
});

module.exports = router;
