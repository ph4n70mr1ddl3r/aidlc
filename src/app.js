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

const app = express();

// ---------------------------------------------------------------------------
// Trust proxy (required for correct req.ip behind reverse proxy)
// ---------------------------------------------------------------------------
app.set('trust proxy', 1);

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
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// ---------------------------------------------------------------------------
// View engine
// ---------------------------------------------------------------------------
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

// ---------------------------------------------------------------------------
// Core middleware
// ---------------------------------------------------------------------------
app.use(morgan('dev'));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(methodOverride('_method'));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------------------------------------------------------------------------
// Session configuration
// ---------------------------------------------------------------------------
const sessionSecret = process.env.SESSION_SECRET || (process.env.NODE_ENV === 'production' ? null : 'dev-only-secret');
if (!sessionSecret) {
  console.error('ERROR: SESSION_SECRET is required in production');
  process.exit(1);
}

// In production, MemoryStore is not suitable — warn if no external store is configured
if (process.env.NODE_ENV === 'production') {
  console.warn('WARNING: Using default MemoryStore for sessions. Consider using a production-grade session store (e.g. connect-sqlite, redis).');
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
  skipSuccessfulRequests: true,
});
app.use('/profile/password', passwordLimiter);

// Rate limit write endpoints to prevent spam
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50,
  message: 'Too many requests. Please slow down.',
  skipSuccessfulRequests: false,
});
app.use(['/tickets', '/assets', '/knowledge', '/changes', '/licenses'], (req, res, next) => {
  if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
    return writeLimiter(req, res, next);
  }
  next();
});

// ---------------------------------------------------------------------------
// Global template variables
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.flash = {
    success: req.flash('success'),
    error: req.flash('error'),
    info: req.flash('info'),
  };
  res.locals.currentPage = req.path;
  res.locals.csrfToken = typeof req.csrfToken === 'function' ? req.csrfToken() : '';
  next();
});

// ---------------------------------------------------------------------------
// Cache-Control: prevent caching of authenticated pages
// Must come BEFORE routes so headers are set on matched routes.
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  if (req.session.user) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
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
app.get('/health', (req, res) => {
  try {
    const db = require('./models/database');
    db.prepare('SELECT 1 AS ok').get();
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
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
  console.error(err.stack);
  if (err.code === 'EBADCSRFTOKEN') {
    req.flash('error', 'Invalid security token. Please try again.');
    const ref = req.get('Referrer');
    // Only redirect to same-origin referrer to prevent open redirect
    if (ref && ref.startsWith(req.protocol + '://' + req.get('Host') + '/')) {
      return res.redirect(ref);
    }
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
const server = app.listen(PORT, () => {
  console.log(`\n🚀 IT Department Manager running at http://localhost:${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}\n`);
});

// ---------------------------------------------------------------------------
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
