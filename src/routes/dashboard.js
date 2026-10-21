const db = require('../models/database');
const { requireAuth } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { authKeyGenerator, logError, prefersJson, parseEnvInt, isPrivileged, capList } = require('../utils');
const { DASHBOARD_LIMITS } = require('../constants');
const rateLimit = require('express-rate-limit');

// Key rate-limiting by authenticated user id (per-account, shared utils helper)
// so one user's reloads cannot silence everyone behind the same NAT'd office IP
// — the dashboard is the landing page for ALL users, so IP-keying a tight 10/min
// limit would throttle whole offices sharing an egress address.

// Rate limit dashboard requests to prevent abuse of aggregation queries.
// Uses a plain 429 response (with a queued flash for the next page view)
// rather than the flash+redirect handler reports.js uses — every dashboard
// route passes through this limiter, so redirecting back to /dashboard would
// produce a redirect loop once the limit is tripped.
const dashboardLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  keyGenerator: authKeyGenerator,
  handler: (req, res) => {
    if (typeof req.flash === 'function') {
      req.flash('error', 'Too many dashboard requests. Please wait a moment and try again.');
    }
    const msg = 'Too many dashboard requests. Please wait a moment and try again.';
    if (prefersJson(req)) {
      return res.status(429).json({ error: msg });
    }
    res.status(429).send(msg);
  },
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
// the caps in one place instead of hunting through raw SQL literals. The
// values are shared with src/constants.js (DASHBOARD_LIMITS) so the template
// can disclose the truncation with an "(N+)" marker — the two can never drift.
//
// Every capped query fetches ONE ROW BEYOND its cap (the "+ 1" below). The
// extra row is the truncation probe: without it a list that happens to hold
// exactly `cap` rows is indistinguishable from a list that was cut off, and
// the template's "(N+)" marker would claim a truncation that does not exist.
// capList() turns the probe into an exact `truncated` flag.
const _DASH_RECENT_TICKETS_LIMIT = DASHBOARD_LIMITS.recentTickets;
// The "My Active Tickets" widget has its own cap: it is a per-viewer query
// and the template compares the rendered row count against
// DASHBOARD_LIMITS.myTickets to decide whether to show the "(N+)" truncation
// marker. It used to reuse DASHBOARD_LIMITS.recentTickets, which made the
// marker threshold and the query limit two independent numbers — changing
// only myTickets in constants.js would have produced a list that is
// truncated but never says so. Reading the knob the template reads keeps the
// two in lockstep (the property the constants comment promises).
const _DASH_MY_TICKETS_LIMIT = DASHBOARD_LIMITS.myTickets;
const _DASH_WARRANTY_LIMIT = DASHBOARD_LIMITS.warrantyAlerts;
const _DASH_UPCOMING_CHANGES_LIMIT = DASHBOARD_LIMITS.upcomingChanges;
const _DASH_STAFF_WORKLOAD_LIMIT = DASHBOARD_LIMITS.staffWorkload;
const _DASH_LICENSE_ALERTS_LIMIT = DASHBOARD_LIMITS.licenseAlerts;

const _parsedDTTL = parseEnvInt(process.env.DASHBOARD_TTL_MS);
// Clamp TTL to [1s, 1h] so accidental 0 (cache-bust on every request) or
// astronomically large values (days/weeks of stale data) cannot occur.
const DASHBOARD_TTL_MS = Number.isFinite(_parsedDTTL) ? Math.max(1_000, Math.min(3_600_000, _parsedDTTL)) : 30_000;
let dashboardCache = { timestamp: 0, data: null };

// Defensive defaults — used when the cache is empty (e.g. first-request DB failure)
// so the template doesn't crash on property access like ticketStats.open.
const EMPTY_DEFAULTS = {
  ticketStats: { total: 0, open: 0, in_progress: 0, waiting: 0, resolved: 0, closed: 0, critical_open: 0 },
  assetStats: { total: 0, in_use: 0, in_storage: 0, in_repair: 0, reserved: 0 },
  projectStats: { total: 0, in_progress: 0, planning: 0, completed: 0, on_hold: 0 },
  staffCount: { total: 0 },
  recentTickets: [],
  recentTicketsTruncated: false,
  expiringWarranties: [],
  expiringWarrantiesCount: 0,
  expiringWarrantiesTruncated: false,
  upcomingChanges: [],
  upcomingChangesTruncated: false,
  ticketsByCategory: [],
  staffWorkload: [],
  staffWorkloadTruncated: false,
  myTickets: [],
  myTicketsTruncated: false,
  licenseAlerts: [],
  licenseAlertsCount: 0,
  licenseAlertsTruncated: false
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
      COALESCE(SUM(CASE WHEN priority = 'critical' AND status IN ('open','in_progress','waiting') THEN 1 ELSE 0 END), 0) as critical_open
    FROM tickets
  `),
  // Exclude disposed assets so the total matches the "Active Assets" stat card
  // label in the dashboard template and the reports page's "Active Assets" card.
  // Mirrors the disposed-asset exclusion in reports.js assetsByCategory and
  // assetsTotalValue. The four subtotals (in_use/in_storage/in_repair/reserved)
  // cover every non-disposed status, so they always sum exactly to the total.
  assetStats: db.prepare(`
    SELECT
      COUNT(*) as total,
      COALESCE(SUM(CASE WHEN status = 'in_use' THEN 1 ELSE 0 END), 0) as in_use,
      COALESCE(SUM(CASE WHEN status = 'in_storage' THEN 1 ELSE 0 END), 0) as in_storage,
      COALESCE(SUM(CASE WHEN status = 'in_repair' THEN 1 ELSE 0 END), 0) as in_repair,
      COALESCE(SUM(CASE WHEN status = 'reserved' THEN 1 ELSE 0 END), 0) as reserved
    FROM assets WHERE status != 'disposed'
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
    SELECT t.id, t.ticket_number, t.title, t.category, t.priority, t.status, t.assigned_to, t.created_at,
            u.first_name || ' ' || u.last_name as assigned_name
    FROM tickets t
    LEFT JOIN users u ON t.assigned_to = u.id
    WHERE t.status NOT IN ('closed', 'resolved')
    ORDER BY t.updated_at DESC, t.id DESC LIMIT ${_DASH_RECENT_TICKETS_LIMIT + 1}
  `),
  // Include already-expired warranties — they are more urgent than expiring-soon.
  // Must use `<=` instead of `BETWEEN` because BETWEEN excludes dates before today.
  // Exclude disposed assets: their warranties are no longer actionable, so showing
  // them here would produce misleading "expiring soon" alerts. Same disposed-asset
  // and expired-inclusive semantics as the reports warrantyExpiring query, but a
  // 30-day glance horizon (vs the report's 90 days) and a tighter list cap —
  // do NOT treat the two queries as interchangeable when changing either.
  //
  // The query fetches ONE ROW BEYOND the cap (the "+ 1" below): the extra row
  // is the truncation probe, so the "(N+)" marker the list card renders is
  // exact and self-contained. The marker used to be derived from a SECOND
  // query (the uncapped count below) — but the list and the count were not
  // always read from the same place: this list lives in the shared TTL cache
  // while the licence list (below) is fetched per request, so the two could
  // disagree and the marker could claim a truncation that did not exist (or
  // hide one that did). The probe removes the cross-query dependency
  // entirely; the uncapped count is now used ONLY by the alert card.
  expiringWarranties: db.prepare(`
    SELECT id, name, asset_tag, warranty_expiry FROM assets
    WHERE warranty_expiry IS NOT NULL AND warranty_expiry <= date('now', '+30 days')
      AND status != 'disposed'
    ORDER BY warranty_expiry ASC, id ASC
    LIMIT ${_DASH_WARRANTY_LIMIT + 1}
  `),
  // Uncapped COUNT for the alert card number. The list query above is capped
  // (LIMIT cap + 1) to bound the cached payload, so expiringWarranties.length
  // would undercount when more than the cap qualify — the exact bug class
  // reports.js fixed by splitting warrantyExpiringCount from warrantyExpiring.
  // The count is NOT used to derive the list's truncation marker (the probe
  // above does that) — it is the number the alert card reports.
  expiringWarrantiesCount: db.prepare(`
    SELECT COUNT(*) as c FROM assets
    WHERE warranty_expiry IS NOT NULL AND warranty_expiry <= date('now', '+30 days')
      AND status != 'disposed'
  `),
  // Upcoming changes are VIEWER-SCOPED, so this query is deliberately NOT part
  // of the shared cached payload below: the change-log module scopes its list
  // to `assigned_to = user.id` for non-privileged viewers and denies them the
  // detail route, so listing every scheduled change here leaked the titles of
  // records the viewer is refused (the same content-oracle class the change
  // list was closed for). Both variants are queried per request, exactly like
  // myTickets below.
  // The comparison is against the LOCAL wall clock, not SQLite's UTC one.
  // `scheduled_start` is written from a datetime-local input, so it holds a
  // LOCAL timestamp ("2026-10-21 22:00" means 10pm where the user is), and
  // formatDateTime() renders it back as local time. SQLite's 'now' is UTC, so
  // the two were different clocks: in a UTC+8 deployment every change
  // scheduled within the next 8 hours was silently dropped from "Upcoming
  // Changes", and a change that had already started was still listed as
  // upcoming. The 'localtime' modifier converts the current instant into the
  // same wall clock the stored value uses, so the widget and the change-log
  // page agree.
  upcomingChangesAll: db.prepare(`
    SELECT id, title, scheduled_start FROM change_log
    WHERE status = 'scheduled' AND scheduled_start >= strftime('%Y-%m-%d %H:%M', 'now', 'localtime')
    ORDER BY scheduled_start ASC, id ASC LIMIT ${_DASH_UPCOMING_CHANGES_LIMIT + 1}
  `),
  upcomingChangesOwned: db.prepare(`
    SELECT id, title, scheduled_start FROM change_log
    WHERE status = 'scheduled' AND scheduled_start >= strftime('%Y-%m-%d %H:%M', 'now', 'localtime')
      AND assigned_to = ?
    ORDER BY scheduled_start ASC, id ASC LIMIT ${_DASH_UPCOMING_CHANGES_LIMIT + 1}
  `),
  ticketsByCategory: db.prepare(`
    SELECT category, COUNT(*) as count FROM tickets
    WHERE status IN ('open','in_progress','waiting')
    GROUP BY category ORDER BY count DESC, category ASC
  `),
  staffWorkload: db.prepare(`
    SELECT u.id, u.first_name || ' ' || u.last_name as name, u.role,
      COUNT(t.id) as open_tickets
    FROM users u
    LEFT JOIN tickets t ON t.assigned_to = u.id AND t.status IN ('open','in_progress','waiting')
    WHERE u.is_active = 1
    GROUP BY u.id
    ORDER BY open_tickets DESC, u.id ASC
    LIMIT ${_DASH_STAFF_WORKLOAD_LIMIT + 1}
  `),
  // Only select the columns the dashboard template renders (expiry_date for
  // ordering/display). Avoid SELECT * so the sensitive license_key column is
  // never loaded into the shared/rendered data object — defense-in-depth that
  // shrinks the credential-exposure surface of the cached dashboard payload.
  //
  // VIEWER-SCOPED: the licenses module is admin/manager-only (its list and
  // show routes are requireAdminOrManager because license cost/seat data is
  // business-sensitive), so the software names must not be handed to a regular
  // staff member's dashboard. This list is therefore queried PER REQUEST for
  // privileged viewers only and is deliberately NOT part of the shared cached
  // payload below — the same pattern the Upcoming Changes widget uses. Only
  // the COUNT (no names) stays in the shared cache, because the alert card
  // reports a number to every viewer.
  //
  // Like the warranty list above, the query fetches ONE ROW BEYOND the cap
  // (the truncation probe) so the list card's "(N+)" marker is exact and does
  // not depend on the separately-cached count — the licence list is read per
  // request while licenseAlertsCount comes from the shared cache, so deriving
  // the marker from the count could claim a truncation that did not exist (or
  // hide one that did).
  licenseAlerts: db.prepare(`
    SELECT id, software_name, vendor, expiry_date FROM licenses
    WHERE expiry_date IS NOT NULL AND expiry_date <= date('now', '+30 days')
    ORDER BY expiry_date ASC, id ASC
    LIMIT ${_DASH_LICENSE_ALERTS_LIMIT + 1}
  `),
  // Uncapped COUNT for the alert card number — licenseAlerts.length would
  // undercount past the list cap, exactly like expiringWarranties above.
  // It is NOT used to derive the list's truncation marker (the probe above
  // does that) — it is the number the alert card reports.
  licenseAlertsCount: db.prepare(`
    SELECT COUNT(*) as c FROM licenses
    WHERE expiry_date IS NOT NULL AND expiry_date <= date('now', '+30 days')
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
    ORDER BY CASE t.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END, t.created_at ASC, t.id ASC LIMIT ${_DASH_MY_TICKETS_LIMIT + 1}
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
        expiringWarrantiesCount: stmts.expiringWarrantiesCount.get().c,
        ticketsByCategory: stmts.ticketsByCategory.all(),
        staffWorkload: stmts.staffWorkload.all(),
        licenseAlertsCount: stmts.licenseAlertsCount.get().c
      };

      dashboardCache = { timestamp: now, data: shared };
    } catch (err) {
      logError('Dashboard cache refresh error:', err);
      // On DB error, re-use previous cache if available (stale data is better
      // than an empty/broken dashboard). Only fall back to EMPTY_DEFAULTS if
      // there is no prior cache at all (first-request failure).
      // Do NOT update the timestamp so the next request retries immediately
      // instead of waiting for the full TTL before refreshing.
      shared = dashboardCache.data || EMPTY_DEFAULTS;
    }
  }

  // Per-user tickets — always queried fresh (single indexed query)
  let myTickets = [];
  try {
    myTickets = stmts.myTickets.all(user.id);
  } catch (err) {
    logError('Dashboard myTickets query error:', err);
  }

  // Upcoming changes — viewer-scoped, so queried fresh per request (never
  // served from the shared TTL cache). Privileged viewers see every scheduled
  // change; a regular staff member sees only the changes assigned to them,
  // matching the change-log list route and its show-route access gate.
  let upcomingChanges = [];
  try {
    upcomingChanges = isPrivileged(user)
      ? stmts.upcomingChangesAll.all()
      : stmts.upcomingChangesOwned.all(user.id);
  } catch (err) {
    logError('Dashboard upcomingChanges query error:', err);
  }

  // Expiring licenses — viewer-scoped for the same reason as the upcoming
  // changes above: the licenses module is admin/manager-only, so the software
  // names are only ever fetched for a privileged viewer. A regular staff
  // member receives an empty list (the alert card still shows the count,
  // which carries no license identity).
  let licenseAlerts = [];
  if (isPrivileged(user)) {
    try {
      licenseAlerts = stmts.licenseAlerts.all();
    } catch (err) {
      logError('Dashboard licenseAlerts query error:', err);
    }
  }

  // Deep-merge defaults to avoid shared nested object references between cache
  // and rendered data.  Object.assign only copies one level deep, so mutating a
  // nested object in a template (e.g. ticketStats.open) would corrupt the cache.
  //
  // The capped lists are sliced to their cap here and carry an EXACT
  // `truncated` flag, computed from the one-row-beyond-the-cap probe the
  // queries fetch (see capList). The template's "(N+)" marker therefore
  // appears only when rows were really dropped — a list that happens to hold
  // exactly as many rows as the cap is complete and is not marked. (The
  // warranty/license alert lists below use the same probe: their uncapped
  // counts feed the ALERT CARDS, which report a number, and are deliberately
  // not used to derive the list markers — the licence list is read per
  // request while its count comes from the shared cache, so a count-derived
  // marker could disagree with the list it describes.)
  const recentTicketsCap = capList(shared.recentTickets || [], DASHBOARD_LIMITS.recentTickets);
  const staffWorkloadCap = capList(shared.staffWorkload || [], DASHBOARD_LIMITS.staffWorkload);
  const myTicketsCap = capList(myTickets, DASHBOARD_LIMITS.myTickets);
  const upcomingChangesCap = capList(upcomingChanges, DASHBOARD_LIMITS.upcomingChanges);
  const expiringWarrantiesCap = capList(shared.expiringWarranties || [], DASHBOARD_LIMITS.warrantyAlerts);
  const licenseAlertsCap = capList(licenseAlerts, DASHBOARD_LIMITS.licenseAlerts);
  const result = {
    ticketStats: { ...EMPTY_DEFAULTS.ticketStats, ...(shared.ticketStats || {}) },
    assetStats: { ...EMPTY_DEFAULTS.assetStats, ...(shared.assetStats || {}) },
    projectStats: { ...EMPTY_DEFAULTS.projectStats, ...(shared.projectStats || {}) },
    staffCount: { ...EMPTY_DEFAULTS.staffCount, ...(shared.staffCount || {}) },
    recentTickets: recentTicketsCap.rows.map(r => ({ ...r })),
    recentTicketsTruncated: recentTicketsCap.truncated,
    expiringWarranties: expiringWarrantiesCap.rows.map(r => ({ ...r })),
    expiringWarrantiesCount: shared.expiringWarrantiesCount ?? EMPTY_DEFAULTS.expiringWarrantiesCount,
    expiringWarrantiesTruncated: expiringWarrantiesCap.truncated,
    upcomingChanges: upcomingChangesCap.rows.map(r => ({ ...r })),
    upcomingChangesTruncated: upcomingChangesCap.truncated,
    ticketsByCategory: (shared.ticketsByCategory || EMPTY_DEFAULTS.ticketsByCategory).map(r => ({ ...r })),
    staffWorkload: staffWorkloadCap.rows.map(r => ({ ...r })),
    staffWorkloadTruncated: staffWorkloadCap.truncated,
    licenseAlerts: licenseAlertsCap.rows.map(r => ({ ...r })),
    licenseAlertsCount: shared.licenseAlertsCount ?? EMPTY_DEFAULTS.licenseAlertsCount,
    licenseAlertsTruncated: licenseAlertsCap.truncated,
    myTickets: myTicketsCap.rows.map(r => ({ ...r })),
    myTicketsTruncated: myTicketsCap.truncated
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
  req.audit('read', 'dashboard', null, 'Viewed dashboard');
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
