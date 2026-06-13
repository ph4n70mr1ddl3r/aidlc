const db = require('../models/database');
const bcrypt = require('bcryptjs');
const { requireAuth } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const { validatePassword, isValidEmail, trim, sanitizePhone, isValidPhone, asyncHandler } = require('../utils');
const { SESSION_COOKIE } = require('../constants');

const router = require('express').Router();

// Cached prepared statements — login runs frequently and db.prepare() is expensive.
const _loginStmt = db.prepare('SELECT id, username, password, email, first_name, last_name, role, department, phone, avatar, is_active, last_login FROM users WHERE username = ? AND is_active = 1');
const _updateLastLoginStmt = db.prepare('UPDATE users SET last_login = datetime(\'now\') WHERE id = ?');

// Apply login rate limiter only to POST /login
const rateLimit = require('express-rate-limit');
const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many login attempts. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false
  // Count all requests — login handler returns 302 redirects for both
  // success and failure, so skipSuccessfulRequests would never count anything.
});

// Track per-account login failures to prevent brute-force across IP rotation
// Also track per-IP failures for defense-in-depth
const loginFailures = new Map(); // username -> { count, lockedUntil, lastAttempt }
const ipLoginFailures = new Map(); // ip -> { count, lockedUntil, lastAttempt }
const MAX_LOGIN_FAILURES = 5;
const LOGIN_LOCKOUT_MINUTES = 15;
const MAX_LOGIN_FAILURES_MAP_SIZE = 10_000;
const DUMMY_BCRYPT_HASH = '$2a$12$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function checkLockout(map, key) {
  const entry = map.get(key);
  if (!entry) {
    return false;
  }
  if (entry.lockedUntil && Date.now() < entry.lockedUntil) {
    return true;
  }
  // Lockout expired or never set — clean up
  map.delete(key);
  return false;
}

function checkAccountLockout(username) {
  return checkLockout(loginFailures, username);
}

function checkIpLockout(ip) {
  return checkLockout(ipLoginFailures, ip);
}

/**
 * Purge stale entries from a login-failure map to bound memory usage.
 * When the map exceeds MAX_LOGIN_FAILURES_MAP_SIZE, removes entries whose
 * lastAttempt is older than the lockout window, then evicts oldest entries
 * as a fallback.
 */
function purgeStaleEntries(map) {
  if (map.size < MAX_LOGIN_FAILURES_MAP_SIZE) {
    return;
  }
  const staleThreshold = Date.now() - LOGIN_LOCKOUT_MINUTES * 60 * 1000;
  for (const [key, val] of map) {
    if (map.size < MAX_LOGIN_FAILURES_MAP_SIZE - 100) {
      break;
    }
    if (val.lastAttempt < staleThreshold) {
      map.delete(key);
    }
  }
  while (map.size >= MAX_LOGIN_FAILURES_MAP_SIZE) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) {
      map.delete(oldest);
    } else {
      break;
    }
  }
}

/**
 * Record a failed login attempt for the given username and IP.
 * Increments failure counts and locks the account/IP after MAX_LOGIN_FAILURES.
 */
function recordLoginFailure(username, ip) {
  // Record per-username failure
  let entry = loginFailures.get(username);
  if (!entry) {
    purgeStaleEntries(loginFailures);
    entry = { count: 0, lockedUntil: null, lastAttempt: null };
  }
  entry.count++;
  entry.lastAttempt = Date.now();
  if (entry.count >= MAX_LOGIN_FAILURES) {
    entry.lockedUntil = Date.now() + LOGIN_LOCKOUT_MINUTES * 60 * 1000;
    entry.count = 0;
  }
  loginFailures.set(username, entry);

  // Record per-IP failure
  if (ip) {
    let ipEntry = ipLoginFailures.get(ip);
    if (!ipEntry) {
      purgeStaleEntries(ipLoginFailures);
      ipEntry = { count: 0, lockedUntil: null, lastAttempt: null };
    }
    ipEntry.count++;
    ipEntry.lastAttempt = Date.now();
    if (ipEntry.count >= MAX_LOGIN_FAILURES) {
      ipEntry.lockedUntil = Date.now() + LOGIN_LOCKOUT_MINUTES * 60 * 1000;
      ipEntry.count = 0;
    }
    ipLoginFailures.set(ip, ipEntry);
  }
}

function clearLoginFailure(username) {
  loginFailures.delete(String(username).substring(0, 50).toLowerCase());
}

function clearIpLoginFailure(ip) {
  ipLoginFailures.delete(String(ip).substring(0, 64).toLowerCase());
}

// Purge stale entries every 10 minutes to prevent memory leak.
const loginFailureCleanup = setInterval(() => {
  const now = Date.now();
  const staleThreshold = now - LOGIN_LOCKOUT_MINUTES * 60 * 1000;
  for (const [key, entry] of loginFailures) {
    if (entry.lockedUntil && now >= entry.lockedUntil) {
      loginFailures.delete(key);
    } else if (entry.lastAttempt && entry.lastAttempt < staleThreshold) {
      loginFailures.delete(key);
    }
  }
  for (const [key, entry] of ipLoginFailures) {
    if (entry.lockedUntil && now >= entry.lockedUntil) {
      ipLoginFailures.delete(key);
    } else if (entry.lastAttempt && entry.lastAttempt < staleThreshold) {
      ipLoginFailures.delete(key);
    }
  }
}, 10 * 60 * 1000);
if (loginFailureCleanup.unref) {
  loginFailureCleanup.unref();
}

/**
 * Mark auth module as shutting down to stop the cleanup interval
 * from firing after db.close() has been called.
 */
function stopLoginFailureCleanup() {
  clearInterval(loginFailureCleanup);
}

// Login page
router.get('/login', (req, res) => {
  if (req.session.user) {
    return res.redirect('/dashboard');
  }
  // Only allow known reason values to prevent arbitrary message injection via crafted URLs
  const allowedReasons = ['deactivated'];
  const reason = allowedReasons.includes(req.query.reason) ? req.query.reason : '';
  res.render('pages/auth/login', { title: 'Login', reason });
});

// Login handler
router.post('/login', loginRateLimiter, asyncHandler(async (req, res) => {
  const { username, password } = req.body;

  if (!username || typeof username !== 'string' || !password) {
    req.flash('error', 'Please enter username and password');
    return res.redirect('/login');
  }

  // Reject excessively long passwords early to prevent wasted bcrypt CPU
  if (typeof password !== 'string' || password.length > 128) {
    req.flash('error', 'Invalid username or password');
    return res.redirect('/login');
  }

  // Check account-level lockout (prevents brute-force across IP rotation)
  const safeUsername = username.substring(0, 50).toLowerCase();
  const clientIp = req.ip || 'unknown';
  if (checkAccountLockout(safeUsername) || checkIpLockout(clientIp)) {
    // Use the same generic message as normal login failure to prevent
    // username enumeration (an attacker comparing "locked" vs "invalid"
    // responses to discover which accounts exist).
    audit({ req, action: 'login_blocked', entity: 'user', entityId: null, details: `Login blocked for username: ${safeUsername} (account or IP lockout)` });
    req.flash('error', 'Invalid username or password');
    return res.redirect('/login');
  }

  const user = _loginStmt.get(safeUsername);

  // Always perform a bcrypt comparison to prevent username enumeration via timing
  // side-channel. If the user doesn't exist, compare against a dummy hash so the
  // CPU cost is identical whether the username is valid or not.
  const hashToCompare = user ? user.password : DUMMY_BCRYPT_HASH;
  const passwordMatch = await bcrypt.compare(password, hashToCompare);

  if (!user || !passwordMatch) {
    recordLoginFailure(safeUsername, clientIp);
    // Audit failed login attempt (user may not exist, use username as entityId substitute)
    audit({ req, action: 'login_failed', entity: 'user', entityId: user ? user.id : null, details: `Failed login for username: ${safeUsername}` });
    req.flash('error', 'Invalid username or password');
    return res.redirect('/login');
  }

  // Update last login
  _updateLastLoginStmt.run(user.id);

  // Clear any login failure tracking for this account and IP
  clearLoginFailure(safeUsername);
  clearIpLoginFailure(clientIp);

  // Store user in session (without password) — regenerate session to prevent fixation
  // eslint-disable-next-line no-unused-vars -- password intentionally excluded from session
  const { password: _password, ...sessionUser } = user;

  await new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
  req.session.user = sessionUser;
  audit({ req, action: 'login', entity: 'user', entityId: user.id, details: `User ${safeUsername} logged in` });
  req.flash('success', `Welcome back, ${user.first_name}!`);
  res.redirect('/dashboard');
}));

// Logout (POST only — GET logout is CSRF-vulnerable)
router.post('/logout', (req, res) => {
  if (req.session.user) {
    audit({ req, action: 'logout', entity: 'user', entityId: req.session.user.id });
  }
  req.session.destroy((err) => {
    if (err) {
      console.error('Session destroy error:', err.message);
    }
    res.clearCookie(SESSION_COOKIE);
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
const _passwordUpdateStmt = db.prepare('UPDATE users SET password = ?, updated_at = datetime(\'now\') WHERE id = ?');

// Profile page
router.get('/profile', requireAuth, (req, res) => {
  const profileUser = _profileSelectStmt.get(req.session.user.id);
  if (!profileUser) {
    req.flash('error', 'Profile not found');
    return res.redirect('/login');
  }
  res.render('pages/auth/profile', { title: 'My Profile', profileUser });
});

// Update profile
router.put('/profile', requireAuth, (req, res) => {
  const first_name = trim(req.body.first_name);
  const last_name = trim(req.body.last_name);
  const email = trim(req.body.email);
  const phone = sanitizePhone(req.body.phone);

  if (!first_name || !last_name || !email) {
    req.flash('error', 'First name, last name, and email are required');
    return res.redirect('/profile');
  }

  if (!isValidEmail(email)) {
    req.flash('error', 'Please enter a valid email address');
    return res.redirect('/profile');
  }

  if (phone && !isValidPhone(phone)) {
    req.flash('error', 'Please enter a valid phone number');
    return res.redirect('/profile');
  }

  try {
    _profileUpdateStmt.run(first_name.substring(0, 100), last_name.substring(0, 100), email.substring(0, 200), phone ? phone.substring(0, 50) : null, req.session.user.id);

    // Update session
    req.session.user.first_name = first_name;
    req.session.user.last_name = last_name;
    req.session.user.email = email;
    req.session.user.phone = (phone || '').substring(0, 50);

    audit({ req, action: 'update', entity: 'user', entityId: req.session.user.id, details: 'Updated own profile' });
    req.flash('success', 'Profile updated successfully');
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      req.flash('error', 'Email address is already in use');
    } else {
      req.flash('error', 'Error updating profile. Please try again.');
    }
  }

  res.redirect('/profile');
});

// Change password
router.put('/profile/password', requireAuth, asyncHandler(async (req, res) => {
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

  if (typeof new_password !== 'string') {
    req.flash('error', 'New password is required');
    return res.redirect('/profile');
  }
  if (new_password.length > 128) {
    req.flash('error', 'Password must be at most 128 characters');
    return res.redirect('/profile');
  }

  const user = _passwordSelectStmt.get(req.session.user.id);
  if (!user) {
    req.flash('error', 'User not found');
    return res.redirect('/login');
  }

  if (!(await bcrypt.compare(current_password, user.password))) {
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

  const hashed = await bcrypt.hash(new_password, 12);
  _passwordUpdateStmt.run(hashed, req.session.user.id);

  audit({ req, action: 'update', entity: 'user', entityId: req.session.user.id, details: 'Changed own password' });

  // Regenerate session to invalidate old session
  const sessionUser = req.session.user;
  await new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
  req.session.user = sessionUser;
  req.flash('success', 'Password changed successfully');
  res.redirect('/profile');
}));

module.exports = router;
module.exports.stopLoginFailureCleanup = stopLoginFailureCleanup;
module.exports.clearLoginFailure = clearLoginFailure;
module.exports.clearIpLoginFailure = clearIpLoginFailure;
