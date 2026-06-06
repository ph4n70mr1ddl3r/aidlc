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
    'dev-csrf-secret-change-for-production',
    'generate-a-random-string-here',
    'generate-another-random-string-here',
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
require('./models/database');

// Prune stale audit log entries on startup if PRUNE_AUDIT_DAYS is configured.
// This prevents unbounded audit_log growth which degrades query performance
// over time. Set PRUNE_AUDIT_DAYS=365 in .env to auto-delete entries older
// than 1 year on each server start.
const _pruneDays = parseInt(process.env.PRUNE_AUDIT_DAYS, 10);
if (Number.isFinite(_pruneDays) && _pruneDays > 0) {
  const _db = require('./models/database');
  const { pruneAuditLog } = require('./utils');
  const pruned = pruneAuditLog(_db, _pruneDays);
  if (pruned > 0) console.log(`Pruned ${pruned} audit log entries older than ${_pruneDays} days`);
}

const app = express();

// ---------------------------------------------------------------------------
// Trust proxy (required for correct req.ip behind reverse proxy)
// Only enable when actually behind a proxy (set TRUST_PROXY=1 in env)
// ---------------------------------------------------------------------------
if (process.env.TRUST_PROXY === '1') {
  app.set('trust proxy', 1);
}

// ---------------------------------------------------------------------------
// Security headers via Helmet
// ---------------------------------------------------------------------------
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // 'unsafe-inline' required for inline event handlers (onclick, onchange, onsubmit)
      // and embedded <script> tags (license key reveal). Refactor to nonce-based CSP
      // or external scripts with addEventListener for a stricter policy.
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com'],
      fontSrc: ["'self'", 'https://cdnjs.cloudflare.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
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
    preload: true,
  } : false,
}));

// ---------------------------------------------------------------------------
// View engine
// ---------------------------------------------------------------------------
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

// ---------------------------------------------------------------------------
// Core middleware
// ---------------------------------------------------------------------------
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(methodOverride('_method'));
// Static assets with cache-control in production
app.use(express.static(path.join(__dirname, '..', 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
  etag: true,
}));

// ---------------------------------------------------------------------------
// Session configuration
// ---------------------------------------------------------------------------
const sessionSecret = process.env.SESSION_SECRET || (process.env.NODE_ENV === 'production' ? null : 'dev-only-secret');
if (!sessionSecret) {
  console.error('ERROR: SESSION_SECRET is required in production');
  process.exit(1);
}

// In production, MemoryStore is not suitable — warn if no external store is configured
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_STORE) {
  console.warn('WARNING: Using default MemoryStore for sessions. Consider configuring a production-grade session store (e.g. connect-sqlite, redis) via SESSION_STORE env var.');
}

app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
  },
}));

app.use(flash());

// ---------------------------------------------------------------------------
// Cookie parser (required for CSRF)
// ---------------------------------------------------------------------------
app.use(cookieParser());

// ---------------------------------------------------------------------------
// CSRF Protection (separate secret from session)
// ---------------------------------------------------------------------------
const csrfSecret = process.env.CSRF_SECRET || (process.env.NODE_ENV === 'production' ? null : 'dev-csrf-secret');
if (!csrfSecret) {
  console.error('ERROR: CSRF_SECRET is required in production');
  process.exit(1);
}

const csrfConfig = doubleCsrf({
  getSecret: () => csrfSecret,
  getSessionIdentifier: (req) => req.sessionID || 'anonymous',
  cookieName: 'csrf-token',
  cookieOptions: {
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
  },
  getCsrfTokenFromRequest: (req) => req.body._csrf || req.headers['x-csrf-token'],
  size: 64,
});
app.use(csrfConfig.doubleCsrfProtection);

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

// Rate limit password-related endpoints to prevent brute-force
const passwordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: 'Too many password attempts. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  // Count all requests — password routes return 302 redirects for both
  // success and failure, so skipSuccessfulRequests would never count anything.
});
app.use('/profile/password', passwordLimiter);

// Rate limit write endpoints to prevent spam
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: 'Too many requests. Please slow down.',
  skipSuccessfulRequests: false,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(['/tickets', '/assets', '/knowledge', '/changes', '/licenses', '/staff', '/projects', '/vendors'], (req, res, next) => {
  if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
    return writeLimiter(req, res, next);
  }
  next();
});

// ---------------------------------------------------------------------------
// Global template variables
// ---------------------------------------------------------------------------
const utilsModule = require('./utils');
const constantsModule = require('./constants');

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.flash = {
    success: req.flash('success'),
    error: req.flash('error'),
    info: req.flash('info'),
  };
  res.locals.currentPage = req.path;
  res.locals.csrfToken = typeof req.csrfToken === 'function' ? req.csrfToken() : '';
  res.locals.jsonScriptSafe = utilsModule.jsonScriptSafe;
  // Expose validation constants to all templates so EJS forms stay in sync
  // with the single source of truth in constants.js.
  res.locals.CONSTANTS = constantsModule;
  next();
});

// ---------------------------------------------------------------------------
// Cache-Control: prevent caching of all pages (authenticated and
// unauthenticated). Unauthenticated pages like login/error can contain
// sensitive flash messages that must not be stored by intermediary caches.
// For authenticated requests, also refresh the session TTL.
// Must come BEFORE routes so headers are set on matched routes.
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');

  if (req.session.user) {
    // Rolling session: extend cookie expiry on each authenticated request
    // so active users aren't unexpectedly logged out after 24 h of idle.
    // With resave:false, we must call touch() to refresh the store TTL.
    req.session.touch();
  }
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

// Health check (unauthenticated)
const healthDb = require('./models/database');
const _healthCheckStmt = healthDb.prepare('SELECT 1 AS ok');
app.get('/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const row = _healthCheckStmt.get();
    if (!row || row.ok !== 1) throw new Error('DB sanity check failed');
    res.json({ status: 'ok', timestamp: new Date().toISOString(), db: 'ok' });
  } catch (err) {
    res.status(503).json({ status: 'error', message: 'Database unavailable' });
  }
});

// Home redirect
app.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.redirect('/login');
});

// 404 handler
app.use((req, res) => {
  res.status(404).render('pages/404', { title: 'Not Found' });
});

// Error handler
app.use((err, req, res, next) => {
  // Only log full stack in development to avoid leaking internal details
  if (process.env.NODE_ENV !== 'production') {
    console.error(err.stack);
  } else {
    console.error('Unhandled error:', err.message || err);
  }
  if (err.code === 'EBADCSRFTOKEN') {
    req.flash('error', 'Invalid security token. Please try again.');
    const ref = req.get('Referrer');
    // Only redirect to same-origin referrer pathname to prevent open redirect.
    // Strip query string to prevent CSRF token from leaking via Referer header.
    try {
      if (ref) {
        const refUrl = new URL(ref);
        const expectedHost = req.get('Host');
        if (refUrl.host === expectedHost && refUrl.protocol === (req.secure ? 'https:' : 'http:')) {
          return res.redirect(refUrl.pathname);
        }
      }
    } catch (_) { /* invalid URL, ignore */ }
    return res.redirect('/');
  }
  const detail = process.env.NODE_ENV === 'production'
    ? 'Something went wrong.'
    : err.message;
  res.status(500).render('pages/error', { title: 'Error', error: { message: detail } });
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;

// Create server explicitly so timeouts can be configured BEFORE listen()
// starts accepting connections. Although listen() is async and timeouts set
// immediately after app.listen() would also work in practice, this pattern
// is conventional and eliminates any ambiguity about ordering.
const http = require('http');
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

server.listen(PORT);

server.on('listening', () => {
  console.log(`\n🚀 IT Department Manager running at http://localhost:${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}\n`);
});

// Graceful shutdown
// ---------------------------------------------------------------------------
function shutdown(signal) {
  console.log(`\n${signal} received — shutting down gracefully…`);
  server.close(() => {
    console.log('HTTP server closed.');
    const db = require('./models/database');
    db.close();
    console.log('Database connection closed.');
    process.exit(0);
  });
  // Force exit after 10 s if connections don't drain
  setTimeout(() => process.exit(1), 10000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
