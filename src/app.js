require('dotenv').config();
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const methodOverride = require('method-override');
const morgan = require('morgan');
const path = require('path');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const { doubleCsrf } = require('csrf-csrf');
const http = require('http');
const crypto = require('crypto');
// ---------------------------------------------------------------------------
// Normalize NODE_ENV early so every module (including constants.js which
// evaluates SESSION_COOKIE_OPTIONS.secure at require time) sees a consistent
// value. Default to 'development' when unset. dotenv runs first above and may
// have loaded a value from .env; this trims/lowercases whatever is present.
// ---------------------------------------------------------------------------
process.env.NODE_ENV = (!process.env.NODE_ENV ? 'development' : process.env.NODE_ENV.trim().toLowerCase());

const utilsModule = require('./utils');
const { prefersJson } = utilsModule;
const constantsModule = require('./constants');
const { SESSION_COOKIE, SESSION_COOKIE_OPTIONS, SESSION_MAX_AGE, CONDITION_BADGE, CHANGE_TYPE_BADGE, ROLE_BADGE } = constantsModule;
const { stopLoginFailureCleanup } = require('./routes/auth');

// ---------------------------------------------------------------------------
// Validate critical env vars in production
// ---------------------------------------------------------------------------
if (process.env.NODE_ENV === 'production') {
  const weak = [
    'change-me-to-a-random-string-in-production',
    'it-dept-manager-secret-change-in-production',
    'fallback-secret',
    'session-secret',
    'dev-session-secret-change-for-production',
    'dev-session-secret-not-for-production',
    'dev-csrf-secret-change-for-production',
    'CHANGE_ME_TO_A_RANDOM_STRING_AT_LEAST_32_CHARS',
    'CHANGE_ME_TO_A_RANDOM_STRING_AT_LEAST_32_CHARS_TOO'
  ];
  if (!process.env.SESSION_SECRET || weak.includes(process.env.SESSION_SECRET) || process.env.SESSION_SECRET.length < 32) {
    console.error('ERROR: SESSION_SECRET must be set to a strong random value (>= 32 chars) in production');
    process.exit(1);
  }
  if (!process.env.CSRF_SECRET || weak.includes(process.env.CSRF_SECRET) || process.env.CSRF_SECRET.length < 32) {
    console.error('ERROR: CSRF_SECRET must be set to a strong random value (>= 32 chars) in production');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Initialize database (schema creation)
// ---------------------------------------------------------------------------
const db = require('./models/database');

// Prune stale audit log entries on startup if PRUNE_AUDIT_DAYS is configured,
// and schedule periodic pruning to prevent unbounded growth between restarts.
// This prevents unbounded audit_log growth which degrades query performance
// over time. Set PRUNE_AUDIT_DAYS=365 in .env to auto-delete entries older
// than 1 year. Default interval is 24 hours; override with PRUNE_AUDIT_INTERVAL_MS.
const pruneDays = parseInt(process.env.PRUNE_AUDIT_DAYS, 10);
const _parsedInterval = parseInt(process.env.PRUNE_AUDIT_INTERVAL_MS, 10);
const pruneIntervalMs = Number.isFinite(_parsedInterval) ? _parsedInterval : 86_400_000; // 24h
let _pruneInterval = null;
function runAuditPrune() {
  if (Number.isFinite(pruneDays) && pruneDays > 0) {
    try {
      const pruned = utilsModule.pruneAuditLog(db, pruneDays);
      if (pruned > 0) {
        console.log(`Pruned ${pruned} audit log entries older than ${pruneDays} days`);
      }
    } catch (err) {
      console.error('Audit log pruning error:', err.message);
    }
    // Log a warning on first-run failure so a startup DB lock or transient error
    // is not silently swallowed — the periodic interval will retry automatically.
    if (!_pruneInterval) {
      console.warn('Initial audit log prune failed — will retry on next interval');
    }
  }
}
runAuditPrune();
if (Number.isFinite(pruneDays) && pruneDays > 0 && Number.isFinite(pruneIntervalMs) && pruneIntervalMs > 0) {
  _pruneInterval = setInterval(runAuditPrune, pruneIntervalMs);
  _pruneInterval.unref();
}

const app = express();

// ---------------------------------------------------------------------------
// Trust proxy (required for correct req.ip behind reverse proxy)
// Only enable when actually behind a proxy (set TRUST_PROXY=1 or =true in env)
// ---------------------------------------------------------------------------
if (process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

// ---------------------------------------------------------------------------
// Framework / protocol hardening (must be set before any middleware runs)
// ---------------------------------------------------------------------------
// Express sets "X-Powered-By: Express" by default, disclosing the framework to
// attackers. helmet() does NOT disable this unless hidePoweredBy is explicitly
// enabled, so disable it at the app level to avoid leaking framework info.
app.disable('x-powered-by');

// Use the built-in querystring parser instead of `qs`. qs historically suffered
// prototype-pollution CVEs (e.g. CVE-2022-24999) via bracket/array syntax
// (?__proto__[x]=y). The "simple" parser only produces flat key/value pairs and
// cannot build nested objects, eliminating that entire class of attack. The app
// never relies on nested query objects — every route reads scalar query params
// through safeQueryValue()/buildFilters() which already collapse/validate input.
app.set('query parser', 'simple');

// Reject TRACE/TRACK as the very first middleware so no downstream handler
// (static, parsers, CSRF, routes) ever processes them. These methods are rarely
// needed and have been associated with cross-protocol/cross-site tracing
// attacks; dropping them at the edge is cheap defense-in-depth.
const _DISALLOWED_METHODS = new Set(['TRACE', 'TRACK']);
const _ALLOWED_METHODS = 'GET, HEAD, POST, PUT, DELETE, PATCH';
const _WRITE_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);
app.use((req, res, next) => {
  if (_DISALLOWED_METHODS.has(req.method)) {
    return res.status(405).set('Allow', _ALLOWED_METHODS).end();
  }
  next();
});

// ---------------------------------------------------------------------------
// Security headers via Helmet
// ---------------------------------------------------------------------------
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com'],
      fontSrc: ["'self'", 'https://cdnjs.cloudflare.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      frameSrc: ["'none'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: { policy: 'same-origin' },
  crossOriginResourcePolicy: { policy: 'same-origin' },
  // Explicit referrer policy — only send origin to cross-origin targets
  referrerPolicy: { policy: ['strict-origin-when-cross-origin'] },
  // Restrict browser features to prevent fingerprinting / abuse
  permittedCrossDomainPolicies: { permittedPolicies: 'none' },
  // Enable HSTS in production (1 year, include subdomains, preload)
  hsts: process.env.NODE_ENV === 'production' ? {
    maxAge: 365 * 24 * 60 * 60,
    includeSubDomains: true,
    preload: true
  } : false,
  // Permissions-Policy: disable powerful browser features the app never uses
  // (camera, microphone, geolocation, USB, etc.). Even though this is a
  // server-rendered internal tool, restricting these reduces the impact of any
  // future XSS that attempted to leverage device APIs. Helmet does not set a
  // Permissions-Policy by default, so we add one explicitly.
  permissionsPolicy: {
    camera: [],
    microphone: [],
    geolocation: [],
    usb: [],
    bluetooth: [],
    payment: [],
    midi: [],
    gyroscope: [],
    accelerometer: [],
    magnetometer: []
  }
}));

// ---------------------------------------------------------------------------
// View engine
// ---------------------------------------------------------------------------
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.set('view cache', process.env.NODE_ENV === 'production');

// ---------------------------------------------------------------------------
// Core middleware
// ---------------------------------------------------------------------------
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
// Only honor method override from POST requests. Prefer the body `_method`
// field (the CSRF-safe channel used by the JSON/tests path), then fall back to
// the query string — every EJS form in the app encodes the override in the
// action URL (e.g. action="/licenses/1?_method=PUT"). A GET/HEAD request can
// never be upgraded to a state-changing method via the query string (the
// hardening that motivated the body-only restriction), and doubleCsrf runs
// after method-override so any overridden request still requires a valid CSRF
// token. Array values from HTTP parameter pollution are rejected (not a
// string → no override), failing closed to the POST route.
app.use(methodOverride((req) => {
  if (req.method === 'POST' && req.body && typeof req.body._method === 'string') {
    return req.body._method;
  }
  if (req.method === 'POST' && typeof req.query._method === 'string') {
    return req.query._method;
  }
  return undefined;
}));
// Static assets with cache-control in production
app.use(express.static(path.join(__dirname, '..', 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
  etag: true
}));

// ---------------------------------------------------------------------------
// Session configuration
// ---------------------------------------------------------------------------
let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  if (process.env.NODE_ENV === 'production') {
    console.error('ERROR: SESSION_SECRET is required in production');
    process.exit(1);
  }
  sessionSecret = crypto.randomBytes(32).toString('hex');
  console.warn('WARNING: No SESSION_SECRET set — using random ephemeral dev secret (sessions will not survive restart; do not use in production)');
}

// In production, MemoryStore is not suitable — load an external store.
// Set SESSION_STORE to the package name of a connect-compatible session store
// (e.g. SESSION_STORE=connect-sqlite3). The package must be installed separately.
// Only module names matching /^(connect-|@[\w-]+\/connect-)/ are accepted to
// prevent arbitrary code execution via a SESSION_STORE pointing to any module.
let sessionStore;
if (process.env.SESSION_STORE) {
  if (!/^(connect-|@[\w-]+\/connect-)/.test(process.env.SESSION_STORE) || /[\\/]/.test(process.env.SESSION_STORE)) {
    console.error(`ERROR: SESSION_STORE "${process.env.SESSION_STORE}" does not match expected pattern (must be connect-* or @scope/connect-*)`);
    process.exit(1);
  }
  try {
    const StoreModule = require(process.env.SESSION_STORE);
    const Store = typeof StoreModule === 'function' ? StoreModule(session) : StoreModule;
    sessionStore = new Store();
  } catch (err) {
    console.error(`ERROR: Failed to load session store "${process.env.SESSION_STORE}": ${err.message}`);
    process.exit(1);
  }
} else if (process.env.NODE_ENV === 'production') {
  console.warn('WARNING: No SESSION_STORE configured — using MemoryStore which is NOT suitable for production. Set SESSION_STORE to a persistent store (e.g. connect-sqlite3).');
}

// Cookie parser must come before session middleware — express-session does not
// depend on it, but downstream middleware (CSRF) reads signed cookies set by
// session. Placing it first ensures req.cookies is populated for all middleware.
app.use(cookieParser());

  // Re-evaluate secure flag at session-config time so it is always correct
  // regardless of when constants.js was required relative to NODE_ENV normalization.
  app.use(session({
    name: SESSION_COOKIE,
    secret: sessionSecret,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      ...SESSION_COOKIE_OPTIONS,
      secure: process.env.NODE_ENV === 'production',
      maxAge: SESSION_MAX_AGE
    }
  }));

app.use(flash());

// ---------------------------------------------------------------------------
// CSRF Protection (separate secret from session)
// ---------------------------------------------------------------------------
let csrfSecret = process.env.CSRF_SECRET;
if (!csrfSecret) {
  if (process.env.NODE_ENV === 'production') {
    console.error('ERROR: CSRF_SECRET is required in production');
    process.exit(1);
  }
  csrfSecret = crypto.randomBytes(32).toString('hex');
  console.warn('WARNING: No CSRF_SECRET set — using random ephemeral secret (CSRF tokens will not survive restart)');
}

const csrfConfig = doubleCsrf({
  getSecret: () => csrfSecret,
  getSessionIdentifier: (req) => req.sessionID,
  cookieName: 'csrf-token',
  cookieOptions: {
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true
  },
  getCsrfTokenFromRequest: (req) => req.body?._csrf || req.headers['x-csrf-token'],
  size: 64,
  // Set the CSRF cookie on every request (including GET) so that API endpoints
  // and health checks also establish the cookie. Without this, any client that
  // fetches a token-only endpoint (e.g. /health) would not receive the cookie,
  // making subsequent CSRF-protected writes fail. The token is still only
  // *validated* on write methods (PUT/POST/DELETE/PATCH) — GET/HEAD/OPTIONS
  // skip validation as before.
  skipCsrfProtection: (req) => ['GET', 'HEAD', 'OPTIONS'].includes(req.method)
});
app.use(csrfConfig.doubleCsrfProtection);

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

// Rate limit write endpoints to prevent spam
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: 'Too many requests. Please slow down.',
  standardHeaders: true,
  legacyHeaders: false
});
// Privileged export/aggregation endpoints (/audit, /reports) already enforce
// requireAdminOrManager and carry their own per-route limiters, but this adds a
// uniform write-rate backstop against abuse of state-changing calls on those
// mounts as well (previously only the listed mounts were covered — a gap noted
// in prior review passes). Reads (GET) are intentionally left unthrottled here
// since the per-route limiters already cover the expensive report/audit queries.
app.use(['/tickets', '/assets', '/knowledge', '/changes', '/licenses', '/staff', '/projects', '/vendors', '/audit', '/reports'], (req, res, next) => {
  if (_WRITE_METHODS.has(req.method)) {
    return writeLimiter(req, res, next);
  }
  next();
});

// ---------------------------------------------------------------------------
// Global template variables
// ---------------------------------------------------------------------------

// Hoist CONSTANTS object outside the per-request middleware to avoid creating
// a new object reference on every request. The values are frozen arrays/numbers
// so sharing across requests is safe. Mirrors the constant-hoisting pattern
// used elsewhere in the codebase (e.g. SORT_MAP in route modules).
const TEMPLATE_CONSTANTS = Object.freeze({
  TICKET_CATEGORIES: constantsModule.TICKET_CATEGORIES,
  TICKET_STATUSES: constantsModule.TICKET_STATUSES,
  TICKET_PRIORITIES: constantsModule.TICKET_PRIORITIES,
  ASSET_CATEGORIES: constantsModule.ASSET_CATEGORIES,
  ASSET_STATUSES: constantsModule.ASSET_STATUSES,
  ASSET_CONDITIONS: constantsModule.ASSET_CONDITIONS,
  PROJECT_STATUSES: constantsModule.PROJECT_STATUSES,
  PROJECT_PRIORITIES: constantsModule.PROJECT_PRIORITIES,
  TASK_STATUSES: constantsModule.TASK_STATUSES,
  TASK_PRIORITIES: constantsModule.TASK_PRIORITIES,
  MEMBER_ROLES: constantsModule.MEMBER_ROLES,
  VENDOR_CATEGORIES: constantsModule.VENDOR_CATEGORIES,
  CHANGE_TYPES: constantsModule.CHANGE_TYPES,
  CHANGE_STATUSES: constantsModule.CHANGE_STATUSES,
  CHANGE_PRIORITIES: constantsModule.CHANGE_PRIORITIES,
  KB_CATEGORIES: constantsModule.KB_CATEGORIES,
  KB_STATUSES: constantsModule.KB_STATUSES,
  LICENSE_TYPES: constantsModule.LICENSE_TYPES,
  USER_ROLES: constantsModule.USER_ROLES,
  ALLOWED_ACTIONS: constantsModule.ALLOWED_ACTIONS,
  ALLOWED_ENTITY_TYPES: constantsModule.ALLOWED_ENTITY_TYPES,
  MAX_MEDIUM_STR: constantsModule.MAX_MEDIUM_STR,
  MAX_SHORT_STR: constantsModule.MAX_SHORT_STR,
  MAX_CONTENT: constantsModule.MAX_CONTENT,
  MAX_LONG_STR: constantsModule.MAX_LONG_STR,
  MAX_DESC: constantsModule.MAX_DESC,
  MAX_NOTES: constantsModule.MAX_NOTES,
  MAX_EMAIL: constantsModule.MAX_EMAIL,
  MAX_PHONE: constantsModule.MAX_PHONE,
  MAX_ADDRESS: constantsModule.MAX_ADDRESS,
  MAX_PASSWORD: constantsModule.MAX_PASSWORD,
  MIN_PASSWORD: constantsModule.MIN_PASSWORD,
  MAX_USERNAME: constantsModule.MAX_USERNAME,
  MAX_ASSET_TAG: constantsModule.MAX_ASSET_TAG,
  MAX_SEARCH: constantsModule.MAX_SEARCH,
  MAX_PAGE: constantsModule.MAX_PAGE,
  DEFAULT_PAGE_SIZE: constantsModule.DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE: constantsModule.MAX_PAGE_SIZE
});

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.flash = {
    success: req.flash('success'),
    error: req.flash('error'),
    info: req.flash('info')
  };
  res.locals.currentPage = req.path;
  res.locals.csrfToken = typeof req.csrfToken === 'function' ? req.csrfToken() : '';
  res.locals.localDate = utilsModule.localDate;
  res.locals.formatDate = utilsModule.formatDate;
  res.locals.formatDateTime = utilsModule.formatDateTime;
  // Date/usage helpers used by list/detail templates (licenses index, asset &
  // project show pages). Without these the templates throw ReferenceError.
  res.locals.daysUntil = utilsModule.daysUntil;
  res.locals.usagePercent = utilsModule.usagePercent;
  res.locals.escapeHtml = utilsModule.escapeHtml;
  res.locals.isValidEmail = utilsModule.isValidEmail;
  res.locals.isExpiringSoon = utilsModule.isExpiringSoon;
  res.locals.titleCase = utilsModule.titleCase;
  res.locals.isPrivileged = utilsModule.isPrivileged;
  res.locals.badgeClass = utilsModule.badgeClass;
  res.locals.CONDITION_BADGE = CONDITION_BADGE;
  res.locals.CHANGE_TYPE_BADGE = CHANGE_TYPE_BADGE;
  res.locals.ROLE_BADGE = ROLE_BADGE;
  // Reuse the hoisted CONSTANTS object shared across all requests.
  res.locals.CONSTANTS = TEMPLATE_CONSTANTS;
  next();
});

// ---------------------------------------------------------------------------
// Cache-Control: prevent caching of all pages (authenticated and
// unauthenticated). Unauthenticated pages like login/error can contain
// sensitive flash messages that must not be stored by intermediary caches.
// Must come BEFORE routes so headers are set on matched routes.
// Note: rolling:true in the session config above refreshes the cookie maxAge
// (and touches the store) on every authenticated response automatically.
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  // Expires header omitted — Cache-Control: no-store already prevents caching;
  // a fixed 1970 date is redundant and may confuse some HTTP intermediaries.
  res.set('Surrogate-Control', 'no-store');
  // Prevent JavaScript from reading the CSRF cookie (mitigates XSS-based
  // token theft). The cookie is httpOnly so JS cannot read it anyway, but
  // this header provides defense-in-depth in case httpOnly is misconfigured.
  res.set('X-Content-Type-Options', 'nosniff');
  next();
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.use('/', require('./routes/auth'));
app.use('/dashboard', require('./routes/dashboard'));
app.use('/assets', require('./routes/assets'));
app.use('/tickets', require('./routes/tickets'));
app.use('/projects', require('./routes/projects'));
app.use('/staff', require('./routes/staff'));
app.use('/vendors', require('./routes/vendors'));
app.use('/knowledge', require('./routes/knowledge'));
app.use('/changes', require('./routes/changes'));
app.use('/licenses', require('./routes/licenses'));
app.use('/reports', require('./routes/reports'));
app.use('/audit', require('./routes/audit'));

// Return 204 No Content for favicon.ico to prevent browser favicon requests
// from generating 404 errors in the access log.
app.get('/favicon.ico', (req, res) => res.status(204).end());

// Health check (unauthenticated) — rate-limited to prevent abuse
const _healthCheckStmt = db.prepare('SELECT 1 AS ok');
const healthLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  standardHeaders: true,
  legacyHeaders: false
});
app.get('/health', healthLimiter, (req, res) => {
  // no-store headers come from the global middleware above; nothing to add here
  res.type('application/json');

  try {
    const row = _healthCheckStmt.get();
    if (!row || row.ok !== 1) {
      throw new Error('DB sanity check failed');
    }
    // Only verify DB connectivity here — a user-existence check would cause
    // the health endpoint to fail on a fresh install (before seeding) and after
    // a mass deactivation, both of which are valid operational states. The
    // application logic (login, routes) already gates on user existence.
    res.json({ status: 'ok', timestamp: new Date().toISOString(), db: 'ok' });
  } catch {
    res.status(503).json({ status: 'error', message: 'Database unavailable' });
  }
});

// Home redirect
app.get('/', (req, res) => {
  if (req.session.user) {
    return res.redirect('/dashboard');
  }
  return res.redirect('/login');
});

// 404 handler
app.use((req, res) => {
  // Honor content negotiation so AJAX clients (Accept: application/json / */*)
  // receive JSON rather than an HTML 404 page, mirroring the error handler.
  // This URL is served in two representations (HTML and JSON) selected by the
  // Accept header, so advertise the variation for intermediaries (RFC 9110
  // §12.5.3). Cache-Control: no-store already prevents caching, but Vary: Accept
  // is the correct protocol behavior for a content-negotiated response and
  // protects against any future proxy/CDN that keys on Vary.
  res.set('Vary', 'Accept');
  if (prefersJson(req)) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.status(404).render('pages/404', { title: 'Not Found' });
});

// Error handler
app.use((err, req, res, _next) => {
  // Only log full stack in development to avoid leaking internal details
  if (process.env.NODE_ENV !== 'production') {
    console.error((err && err.stack) || err || 'Unknown error');
  } else {
    console.error('Unhandled error:', (err && err.message) || String(err));
  }

  // Handle JSON requests (e.g. AJAX endpoints) gracefully.
  // prefersJson() uses content negotiation so AJAX callers (Accept: */* or
  // application/json) correctly receive JSON instead of an HTML error page.
  const wantsJson = prefersJson(req);

  // The error response is also content-negotiated (HTML vs JSON based on
  // Accept), so advertise the variation (RFC 9110 §12.5.3) the same way the
  // 404 handler does — correct protocol behavior for intermediaries even
  // though Cache-Control: no-store is set on every response.
  res.set('Vary', 'Accept');

  if (err.code === 'EBADCSRFTOKEN') {
    if (wantsJson) {
      return res.status(403).json({ error: 'Invalid security token' });
    }
    if (typeof req.flash === 'function') {
      req.flash('error', 'Invalid security token. Please try again.');
    }
    const ref = req.get('Referrer');
    // Only redirect to same-origin referrer pathname to prevent open redirect.
    // Strip query string to prevent CSRF token from leaking via Referer header.
    // Use hostname (not host) to avoid port-mismatch bugs: URL.host omits default
    // ports (80/443) while the Host header from some clients includes them.
    try {
      if (ref) {
        const refUrl = new URL(ref);
        const expectedHost = req.hostname;
        if (refUrl.hostname === expectedHost && refUrl.protocol === (req.secure ? 'https:' : 'http:')) {
          return res.redirect(refUrl.pathname);
        }
      }
    } catch { /* invalid URL, ignore */ }
    return res.redirect('/');
  }

  const errMsg = (err && err.message) || String(err);
  const detail = process.env.NODE_ENV === 'production' ? 'Something went wrong.' : errMsg;

  // Honor err.status/err.statusCode for known client errors (e.g. body-parser
  // 413 payload-too-large, 400 malformed JSON) instead of reporting every
  // error as a 500. Only trust a plausible HTTP status range.
  const rawStatus = (err && (err.status || err.statusCode)) || 500;
  const status = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599
    ? rawStatus
    : 500;

  if (wantsJson) {
    return res.status(status).json({ error: detail });
  }

  res.status(status).render('pages/error', { title: 'Error', error: { message: detail } });
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
const PORT = (() => {
  const raw = process.env.PORT;
  if (raw === undefined || raw === '') {
    return 3000;
  }
  // Reject non-numeric strings — parseInt('3000abc') silently returns 3000,
  // which would mislead operators into thinking an invalid value is accepted.
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    console.error(`ERROR: PORT must be a positive integer, got "${raw}"`);
    if (require.main === module) {
      process.exit(1);
    }
    return 3000;
  }
  const n = parseInt(raw, 10);
  if (n < 1 || n > 65535) {
    console.error(`ERROR: PORT must be between 1 and 65535, got "${raw}"`);
    if (require.main === module) {
      process.exit(1);
    }
    return 3000;
  }
  return n;
})();

// Create server explicitly so timeouts can be configured BEFORE listen()
// starts accepting connections. Although listen() is async and timeouts set
// immediately after app.listen() would also work in practice, this pattern
// is conventional and eliminates any ambiguity about ordering.
const server = http.createServer(app);

// Request timeout (prevents hung connections)
server.requestTimeout = 30_000; // 30 seconds (replaces deprecated server.timeout)
server.keepAliveTimeout = 5_000;
server.headersTimeout = 6_000; // Must be > keepAliveTimeout

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`ERROR: Port ${PORT} is already in use. Is another instance running?`);
  } else {
    console.error('Server error:', err.message);
  }
  process.exit(1);
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`\nIT Department Manager running at http://localhost:${PORT}`);
    console.log(`   Environment: ${process.env.NODE_ENV || 'development'}\n`);
  });
}

// Graceful shutdown
// ---------------------------------------------------------------------------
let _shuttingDown = false;
function shutdown(signal, exitCode = 0) {
  if (_shuttingDown) {
    return;
  }
  _shuttingDown = true;
  console.log(`\n${signal} received — shutting down gracefully…`);
  // Stop periodic intervals before closing DB
  stopLoginFailureCleanup();
  if (_pruneInterval) {
    clearInterval(_pruneInterval);
  }
  // Drop idle keep-alive connections so server.close() doesn't hang waiting
  // for them to time out. closeIdleConnections() lets in-flight requests
  // finish gracefully (bounded by the force-exit timer below); the broader
  // closeAllConnections() would also kill active requests mid-flight.
  try {
    if (typeof server.closeIdleConnections === 'function') {
      server.closeIdleConnections();
    } else if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
  } catch (err) {
    console.error('Error closing idle connections:', err.message);
  }
  const forceExitTimer = setTimeout(() => process.exit(exitCode), 10000);
  forceExitTimer.unref();
  server.close(() => {
    clearTimeout(forceExitTimer);
    console.log('HTTP server closed.');
    let dbClosed = true;
    try {
      db.close();
    } catch (err) {
      console.error('Error closing database:', err.message);
      dbClosed = false;
    }
    if (dbClosed) {
      console.log('Database connection closed.');
    }
    process.exit(dbClosed ? exitCode : 1);
  });
}
// Register process-level handlers only when the app is the entry point.
// When app.js is require()d (e.g. by the test suite), a stray unhandled
// rejection would otherwise invoke shutdown() — which calls server.close(),
// db.close(), and process.exit(1) — killing the entire jest run with an
// opaque failure instead of jest's own per-test reporting. Mirrors the
// require.main === module guard applied to server.listen() above.
if (require.main === module) {
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', (reason && reason.message) || String(reason));
    shutdown('UNHANDLED_REJECTION', 1);
  });
  process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', (err && err.message) || String(err));
    shutdown('UNCAUGHT_EXCEPTION', 1);
  });
}

module.exports = app;
