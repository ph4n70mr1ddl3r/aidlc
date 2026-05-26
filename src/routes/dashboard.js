const db = require('../models/database');
const { requireAuth } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

const router = require('express').Router();
router.use(requireAuth, auditMiddleware);

router.get('/', (req, res) => {
  // Ticket stats
  const ticketStats = db.prepare(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open,
      SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
      SUM(CASE WHEN status = 'waiting' THEN 1 ELSE 0 END) as waiting,
      SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) as resolved,
      SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed,
      SUM(CASE WHEN priority = 'critical' AND status IN ('open','in_progress') THEN 1 ELSE 0 END) as critical_open
    FROM tickets
  `).get();

  // Asset stats
  const assetStats = db.prepare(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN status = 'in_use' THEN 1 ELSE 0 END) as in_use,
      SUM(CASE WHEN status = 'in_storage' THEN 1 ELSE 0 END) as in_storage,
      SUM(CASE WHEN status = 'in_repair' THEN 1 ELSE 0 END) as in_repair,
      SUM(CASE WHEN warranty_expiry < date('now') THEN 1 ELSE 0 END) as warranty_expired
    FROM assets
  `).get();

  // Project stats
  const projectStats = db.prepare(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
      SUM(CASE WHEN status = 'planning' THEN 1 ELSE 0 END) as planning,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status = 'on_hold' THEN 1 ELSE 0 END) as on_hold
    FROM projects
  `).get();

  // Staff stats
  const staffCount = db.prepare('SELECT COUNT(*) as total FROM users WHERE is_active = 1').get();

  // Recent tickets
  const recentTickets = db.prepare(`
    SELECT t.*, u.first_name || ' ' || u.last_name as assigned_name
    FROM tickets t
    LEFT JOIN users u ON t.assigned_to = u.id
    ORDER BY t.created_at DESC LIMIT 10
  `).all();

  // My tickets (assigned to current user)
  const myTickets = db.prepare(`
    SELECT * FROM tickets 
    WHERE assigned_to = ? AND status IN ('open', 'in_progress', 'waiting')
    ORDER BY priority DESC, created_at ASC LIMIT 10
  `).all(req.session.user.id);

  // Expiring warranties (next 30 days)
  const expiringWarranties = db.prepare(`
    SELECT * FROM assets 
    WHERE warranty_expiry BETWEEN date('now') AND date('now', '+30 days')
    ORDER BY warranty_expiry ASC
  `).all();

  // Upcoming changes
  const upcomingChanges = db.prepare(`
    SELECT * FROM change_log 
    WHERE status = 'scheduled' AND scheduled_start >= date('now')
    ORDER BY scheduled_start ASC LIMIT 5
  `).all();

  // Tickets by category (for chart)
  const ticketsByCategory = db.prepare(`
    SELECT category, COUNT(*) as count FROM tickets 
    WHERE status IN ('open','in_progress','waiting')
    GROUP BY category ORDER BY count DESC
  `).all();

  // Staff workload
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

  // License alerts (expiring in 30 days)
  const licenseAlerts = db.prepare(`
    SELECT * FROM licenses 
    WHERE expiry_date BETWEEN date('now') AND date('now', '+30 days')
    ORDER BY expiry_date ASC
  `).all();

  res.render('pages/dashboard', {
    title: 'Dashboard',
    ticketStats,
    assetStats,
    projectStats,
    staffCount,
    recentTickets,
    myTickets,
    expiringWarranties,
    upcomingChanges,
    ticketsByCategory,
    staffWorkload,
    licenseAlerts
  });
});

module.exports = router;
