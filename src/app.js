require('dotenv').config();
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const methodOverride = require('method-override');
const morgan = require('morgan');
const path = require('path');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const { doubleCsrf } = require('csrf-csrf');

// Validate session secret in production
if (process.env.NODE_ENV === 'production' &&
    (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'it-dept-manager-secret-change-in-production')) {
  console.error('ERROR: SESSION_SECRET must be changed from default in production');
  process.exit(1);
}

// Initialize database
require('./models/database');

const app = express();

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

// Middleware
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(methodOverride('_method'));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax'
  }
}));

app.use(flash());

// Cookie parser (required for CSRF)
app.use(cookieParser());

// CSRF Protection
const csrfConfig = doubleCsrf({
  getSecret: () => process.env.SESSION_SECRET || 'fallback-secret',
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

// Rate limiting on login
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: 'Too many login attempts. Please try again later.',
  skipSuccessfulRequests: true,
});
app.use('/login', loginLimiter);

// Global template variables
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.flash = {
    success: req.flash('success'),
    error: req.flash('error'),
    info: req.flash('info')
  };
  res.locals.currentPage = req.path;
  res.locals.csrfToken = req.csrfToken ? req.csrfToken() : '';
  next();
});

// Routes
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
    return res.redirect(req.get('Referrer') || '/');
  }
  const detail = process.env.NODE_ENV === 'production'
    ? 'Something went wrong.'
    : err.message;
  res.status(500).render('pages/error', { title: 'Error', error: { message: detail } });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 IT Department Manager running at http://localhost:${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}\n`);
});

module.exports = app;
