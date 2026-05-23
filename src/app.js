require('dotenv').config();
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const methodOverride = require('method-override');
const morgan = require('morgan');
const path = require('path');

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
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

app.use(flash());

// Global template variables
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.flash = {
    success: req.flash('success'),
    error: req.flash('error'),
    info: req.flash('info')
  };
  res.locals.currentPage = req.path;
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
  res.status(500).render('pages/error', { title: 'Error', error: err });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 IT Department Manager running at http://localhost:${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}\n`);
});

module.exports = app;
