const db = require('../models/database');
const bcrypt = require('bcryptjs');
const { requireAuth, requireRole } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const { validatePassword, isValidEmail, trim } = require('../utils');

const router = require('express').Router();

// Cached prepared statements — login runs frequently and db.prepare() is expensive.
const _loginStmt = db.prepare('SELECT id, username, password, email, first_name, last_name, role, department, phone, avatar, is_active, last_login FROM users WHERE username = ? AND is_active = 1');
const _updateLastLoginStmt = db.prepare(`UPDATE users SET last_login = datetime('now') WHERE id = ?`);

// Apply login rate limiter only to POST /login
const rateLimit = require('express-rate-limit');
const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many login attempts. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  // Count all requests — login handler returns 302 redirects for both
  // success and failure, so skipSuccessfulRequests would never count anything.
});

// Track per-account login failures to prevent brute-force across IP rotation
const loginFailures = new Map(); // username -> { count, lockedUntil }
const MAX_LOGIN_FAILURES = 5;
const LOGIN_LOCKOUT_MINUTES = 15;
const MAX_LOGIN_FAILURES_MAP_SIZE = 10_000;

function checkAccountLockout(username) {
  const entry = loginFailures.get(username);
  if (!entry) return false;
  if (entry.lockedUntil && Date.now() < entry.lockedUntil) return true;
  if (entry.lockedUntil && Date.now() >= entry.lockedUntil) {
    loginFailures.delete(username);
    return false;
  }
  return false;
}

function recordLoginFailure(username) {
  let entry = loginFailures.get(username);
  if (!entry) {
    // Evict oldest entries if Map is at capacity to prevent unbounded memory growth
    if (loginFailures.size >= MAX_LOGIN_FAILURES_MAP_SIZE) {
      const firstKey = loginFailures.keys().next().value;
      if (firstKey !== undefined) loginFailures.delete(firstKey);
    }
    entry = { count: 0, lockedUntil: null, lastAttempt: null };
  }
  entry.count++;
  entry.lastAttempt = Date.now();
  if (entry.count >= MAX_LOGIN_FAILURES) {
    entry.lockedUntil = Date.now() + LOGIN_LOCKOUT_MINUTES * 60 * 1000;
    entry.count = 0; // reset count so lockout is fresh on next attempt
  }
  loginFailures.set(username, entry);
}

function clearLoginFailure(username) {
  loginFailures.delete(username);
}

// Purge stale entries every 10 minutes to prevent memory leak.
// Only delete entries whose last attempt is older than the lockout window.
// This prevents resetting partial failure counts that haven't yet triggered lockout.
const loginFailureCleanup = setInterval(() => {
  const now = Date.now();
  const staleThreshold = now - LOGIN_LOCKOUT_MINUTES * 60 * 1000;
  for (const [key, entry] of loginFailures) {
    if (entry.lockedUntil && now >= entry.lockedUntil) loginFailures.delete(key);
    else if (entry.lastAttempt && entry.lastAttempt < staleThreshold) loginFailures.delete(key);
  }
}, 10 * 60 * 1000);
// Allow the process to exit cleanly when the server shuts down;
// without unref() this timer keeps the event loop alive.
if (loginFailureCleanup.unref) loginFailureCleanup.unref();

// Login page
router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  // Only allow known reason values to prevent arbitrary message injection via crafted URLs
  const allowedReasons = ['deactivated'];
  const reason = allowedReasons.includes(req.query.reason) ? req.query.reason : '';
  res.render('pages/auth/login', { title: 'Login', reason });
});

// Login handler
router.post('/login', loginRateLimiter, (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    req.flash('error', 'Please enter username and password');
    return res.redirect('/login');
  }

  // Reject excessively long passwords early to prevent wasted bcrypt CPU
  if (typeof password !== 'string' || password.length > 128) {
    req.flash('error', 'Invalid username or password');
    return res.redirect('/login');
  }

  // Check account-level lockout (prevents brute-force across IP rotation)
  const safeUsername = String(username).substring(0, 50);
  if (checkAccountLockout(safeUsername)) {
    // Use the same generic message as normal login failure to prevent
    // username enumeration (an attacker comparing "locked" vs "invalid"
    // responses to discover which accounts exist).
    req.flash('error', 'Invalid username or password');
    return res.redirect('/login');
  }

  const user = _loginStmt.get(safeUsername);

  if (!user || !bcrypt.compareSync(password, user.password)) {
    recordLoginFailure(safeUsername);
    req.flash('error', 'Invalid username or password');
    return res.redirect('/login');
  }

  // Update last login
  _updateLastLoginStmt.run(user.id);

  // Clear any login failure tracking for this account
  clearLoginFailure(safeUsername);

  // Store user in session (without password) — regenerate session to prevent fixation
  const { password: _, ...sessionUser } = user;

  req.session.regenerate((err) => {
    if (err) {
      req.flash('error', 'Login failed. Please try again.');
      return res.redirect('/login');
    }
    req.session.user = sessionUser;
    audit({ req, action: 'login', entity: 'user', entityId: user.id, details: `User ${safeUsername} logged in` });
    req.flash('success', `Welcome back, ${user.first_name}!`);
    res.redirect('/dashboard');
  });
});

// Logout (POST only — GET logout is CSRF-vulnerable)
router.post('/logout', (req, res) => {
  if (req.session.user) {
    audit({ req, action: 'logout', entity: 'user', entityId: req.session.user.id });
  }
  req.session.destroy((err) => {
    if (err) {
      console.error('Session destroy error:', err.message);
    }
    res.clearCookie('connect.sid');
    res.redirect('/login');
  });
});

// Cached prepared statements for profile routes
const _profileSelectStmt = db.prepare('SELECT id, username, email, first_name, last_name, role, department, phone, avatar, is_active, last_login, created_at, updated_at FROM users WHERE id = ?');
const _profileUpdateStmt = db.prepare(`
  UPDATE users SET first_name = ?, last_name = ?, email = ?, phone = ?, updated_at = datetime('now')
  WHERE id = ?
`);
const _passwordSelectStmt = db.prepare('SELECT password FROM users WHERE id = ?');
const _passwordUpdateStmt = db.prepare(`UPDATE users SET password = ?, updated_at = datetime('now') WHERE id = ?`);

// Profile page
router.get('/profile', requireAuth, (req, res) => {
  const row = _profileSelectStmt.get(req.session.user.id);
  const profileUser = row;
  res.render('pages/auth/profile', { title: 'My Profile', profileUser });
});

// Update profile
router.put('/profile', requireAuth, (req, res) => {
  const first_name = trim(req.body.first_name);
  const last_name = trim(req.body.last_name);
  const email = trim(req.body.email);
  const phone = trim(req.body.phone);

  if (!first_name || !last_name || !email) {
    req.flash('error', 'First name, last name, and email are required');
    return res.redirect('/profile');
  }

  if (!isValidEmail(email)) {
    req.flash('error', 'Please enter a valid email address');
    return res.redirect('/profile');
  }

  try {
    _profileUpdateStmt.run(first_name.substring(0, 100), last_name.substring(0, 100), email.substring(0, 200), (phone || '').substring(0, 50), req.session.user.id);

    // Update session
    req.session.user.first_name = first_name;
    req.session.user.last_name = last_name;
    req.session.user.email = email;
    req.session.user.phone = phone;

    audit({ req, action: 'update', entity: 'user', entityId: req.session.user.id, details: 'Updated own profile' });
    req.flash('success', 'Profile updated successfully');
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      req.flash('error', 'Email address is already in use');
    } else {
      req.flash('error', 'Error updating profile. Please try again.');
    }
  }

  res.redirect('/profile');
});

// Change password
router.put('/profile/password', requireAuth, (req, res) => {
  const { current_password, new_password, confirm_password } = req.body;

  if (!current_password) {
    req.flash('error', 'Current password is required');
    return res.redirect('/profile');
  }

  // Reject excessively long / non-string current password to prevent bcrypt DoS
  if (typeof current_password !== 'string' || current_password.length > 128) {
    req.flash('error', 'Invalid current password');
    return res.redirect('/profile');
  }

  const user = _passwordSelectStmt.get(req.session.user.id);

  if (!bcrypt.compareSync(current_password, user.password)) {
    req.flash('error', 'Current password is incorrect');
    return res.redirect('/profile');
  }

  if (new_password !== confirm_password) {
    req.flash('error', 'New passwords do not match');
    return res.redirect('/profile');
  }

  const pwError = validatePassword(new_password);
  if (pwError) {
    req.flash('error', pwError);
    return res.redirect('/profile');
  }

  const hashed = bcrypt.hashSync(new_password, 12);
  _passwordUpdateStmt.run(hashed, req.session.user.id);

  audit({ req, action: 'update', entity: 'user', entityId: req.session.user.id, details: 'Changed own password' });

  // Regenerate session to invalidate old session
  const sessionUser = req.session.user;
  req.session.regenerate((err) => {
    if (err) {
      req.flash('error', 'Error updating session');
      return res.redirect('/profile');
    }
    req.session.user = sessionUser;
    req.flash('success', 'Password changed successfully');
    res.redirect('/profile');
  });
});

module.exports = router;
