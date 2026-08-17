const db = require('../models/database');
const bcrypt = require('bcryptjs');
const { requireAuth } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const { validatePassword, isValidEmail, trim, sanitizePhone, isValidPhone, asyncHandler, safeQueryValue, rejectHppArrays, normalizeIp, invalidateActiveStaffCache, authKeyGenerator } = require('../utils');
const { SESSION_COOKIE, SESSION_COOKIE_OPTIONS, MAX_USERNAME, MAX_PASSWORD_BYTES, MAX_SHORT_STR, MAX_EMAIL, MAX_PHONE, BCRYPT_SALT_ROUNDS } = require('../constants');
const { invalidateDashboardCache } = require('./dashboard');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

function _regenerateSession(session) {
  return new Promise((resolve, reject) => {
    session.regenerate(err => err ? reject(err) : resolve());
  });
}

const router = require('express').Router();

// Rate limit password-related endpoints to prevent brute-force. Keyed per
// account (the routes are authenticated) so one user's actions never consume
// the shared budget of everyone behind a NAT'd IP.
const passwordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes (aligned with loginRateLimiter)
  max: 10,
  keyGenerator: authKeyGenerator,
  message: 'Too many password attempts. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});

// Rate limit profile updates (separate from password changes)
const profileLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  keyGenerator: authKeyGenerator,
  message: 'Too many profile update attempts. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});

// Lazily initialized so tests can reset cached statements via resetCachedStatements()
// (consistent with the lazy-init pattern in audit.js and middleware/auth.js).
let _loginStmt = null;
function _getLoginStmt() {
  if (!_loginStmt) {
    _loginStmt = db.prepare('SELECT id, username, password, email, first_name, last_name, role, department, phone, avatar, is_active, last_login, password_changed_at FROM users WHERE username = ? AND is_active = 1');
  }
  return _loginStmt;
}
let _updateLastLoginStmt = null;
function _getUpdateLastLoginStmt() {
  if (!_updateLastLoginStmt) {
    _updateLastLoginStmt = db.prepare('UPDATE users SET last_login = datetime(\'now\') WHERE id = ?');
  }
  return _updateLastLoginStmt;
}

// Apply login rate limiter only to POST /login.
// Key on the SAME normalized IP used by the login-failure lockout maps so
// IPv4-mapped addresses (::ffff:x.x.x.x) are budgeted together.
// NOTE: skipSuccessfulRequests is intentionally NOT used — all login outcomes
// redirect with 302 (status < 400), so the option would skip every request.
// Brute-force defense comes from per-account/per-IP failure lockouts; this
// limiter only bounds total login traffic per source.
const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => ipKeyGenerator(normalizeIp(req.ip)),
  handler: (req, res) => {
    audit({ req, action: 'login_rate_limited', entity: 'user', entityId: null,
      details: 'Login rate limited by IP' });
    req.flash('error', 'Too many login attempts. Please try again in 15 minutes.');
    return res.redirect('/login');
  },
  standardHeaders: true,
  legacyHeaders: false
});

// Track per-account login failures to prevent brute-force across IP rotation
// Also track per-IP failures for defense-in-depth
const loginFailures = new Map(); // username -> { count, lockedUntil, lastAttempt }
const ipLoginFailures = new Map(); // ip -> { count, lockedUntil, lastAttempt }
const MAX_LOGIN_FAILURES = 5;
const LOGIN_LOCKOUT_MINUTES = 15;
const MAX_LOGIN_FAILURES_MAP_SIZE = 10_000;
// Pre-compute a dummy hash synchronously at module load for the username-
// enumeration timing defense. The sync call happens only once at startup so
// it does not affect request latency.
const DUMMY_HASH = bcrypt.hashSync('dummy', BCRYPT_SALT_ROUNDS);

function checkLockout(map, key) {
  const entry = map.get(key);
  if (!entry) {
    return false;
  }
  if (entry.lockedUntil && Date.now() < entry.lockedUntil) {
    return true;
  }
  return false;
}

function checkAccountLockout(username) {
  const safe = typeof username === 'string' ? username.toLowerCase() : '';
  return checkLockout(loginFailures, safe);
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
  // Evict stale entries first (older than the lockout window), then fall back
  // to oldest-entry eviction for entries that are too recent to be stale.
  // Map iteration order is insertion-order, so we walk from oldest to newest.
  const entriesToDelete = [];
  for (const [key, val] of map) {
    if (val.lastAttempt < staleThreshold) {
      entriesToDelete.push(key);
    }
  }
  for (const key of entriesToDelete) {
    map.delete(key);
    if (map.size < MAX_LOGIN_FAILURES_MAP_SIZE) {
      return;
    }
  }
  // Still over capacity — evict oldest non-locked entries.
  // If the absolute oldest entry is locked (active lockout), skip it
  // and evict the next unlocked entry so the map doesn't grow unbounded.
  let evicted = false;
  for (const [key, val] of map) {
    if (val && val.lockedUntil && Date.now() < val.lockedUntil) {
      continue;
    }
    map.delete(key);
    evicted = true;
    break;
  }
  // When every entry is locked, force-evict the oldest entry regardless of lock
  // state so the map can make room.
  if (!evicted) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) {
      map.delete(oldest);
    }
  }
}

/**
 * Record a failed login attempt for the given username and IP.
 * Increments failure counts and locks the account/IP after MAX_LOGIN_FAILURES.
 */
function recordLoginFailure(username, ip) {
  // Normalize to lowercase so the key matches what clearLoginFailure uses
  const safe = username.toLowerCase();

  // Ensure bounded map size before adding new entries
  purgeStaleEntries(loginFailures);

  let entry = loginFailures.get(safe);
  if (!entry) {
    entry = { count: 0, lockedUntil: null, lastAttempt: null };
  }
  entry.count++;
  entry.lastAttempt = Date.now();
  if (entry.count >= MAX_LOGIN_FAILURES) {
    entry.lockedUntil = Date.now() + LOGIN_LOCKOUT_MINUTES * 60 * 1000;
    entry.count = MAX_LOGIN_FAILURES;
  }
  loginFailures.set(safe, entry);

  // Record per-IP failure
  if (ip) {
    purgeStaleEntries(ipLoginFailures);

    let ipEntry = ipLoginFailures.get(ip);
    if (!ipEntry) {
      ipEntry = { count: 0, lockedUntil: null, lastAttempt: null };
    }
    ipEntry.count++;
    ipEntry.lastAttempt = Date.now();
    if (ipEntry.count >= MAX_LOGIN_FAILURES) {
      ipEntry.lockedUntil = Date.now() + LOGIN_LOCKOUT_MINUTES * 60 * 1000;
      ipEntry.count = MAX_LOGIN_FAILURES;
    }
    ipLoginFailures.set(ip, ipEntry);
  }
}

function clearLoginFailure(username) {
  if (!username || typeof username !== 'string') {
    return;
  }
  loginFailures.delete(username.toLowerCase());
}

function clearIpLoginFailure(ip) {
  if (!ip || typeof ip !== 'string') {
    return;
  }
  ipLoginFailures.delete(ip);
}

function _purgeStaleEntriesFromMap(map, now, staleThreshold) {
  for (const [key, entry] of map) {
    if (entry.lockedUntil && now >= entry.lockedUntil) {
      map.delete(key);
    } else if (entry.lastAttempt && entry.lastAttempt < staleThreshold) {
      map.delete(key);
    }
  }
}

// Purge stale entries every 10 minutes to prevent memory leak.
const loginFailureCleanup = setInterval(() => {
  const now = Date.now();
  const staleThreshold = now - LOGIN_LOCKOUT_MINUTES * 60 * 1000;
  _purgeStaleEntriesFromMap(loginFailures, now, staleThreshold);
  _purgeStaleEntriesFromMap(ipLoginFailures, now, staleThreshold);
}, 10 * 60 * 1000);
if (loginFailureCleanup.unref) {
  loginFailureCleanup.unref();
}

// Flag to prevent double-clearing of the login-failure cleanup interval.
let _loginFailureCleanupStopped = false;

/**
 * Mark auth module as shutting down to stop the cleanup interval
 * from firing after db.close() has been called.
 */
function stopLoginFailureCleanup() {
  if (_loginFailureCleanupStopped) {
    return;
  }
  _loginFailureCleanupStopped = true;
  if (loginFailureCleanup) {
    clearInterval(loginFailureCleanup);
  }
}

// Login page
router.get('/login', (req, res) => {
  if (req.session.user) {
    return res.redirect('/dashboard');
  }
  // Only allow known reason values to prevent arbitrary message injection via crafted URLs
  const allowedReasons = ['deactivated', 'password_changed', 'session_idle', 'session_expired'];
  const qReason = safeQueryValue(req.query.reason);
  const reason = allowedReasons.includes(qReason) ? qReason : '';
  res.render('pages/auth/login', { title: 'Login', reason });
});

// Login handler
router.post('/login', loginRateLimiter, asyncHandler(async (req, res) => {
  const hppErrors = rejectHppArrays(req, ['username', 'password']);
  if (hppErrors.length > 0) {
    req.flash('error', 'Please enter username and password');
    return res.redirect('/login');
  }

  const username = safeQueryValue(req.body.username);
  const password = safeQueryValue(req.body.password);

  if (!username || typeof username !== 'string' || !password) {
    req.flash('error', 'Please enter username and password');
    return res.redirect('/login');
  }

  const safeUsername = username.toLowerCase();
  // Normalize IP: strip IPv6-mapped prefix for consistent lockout tracking.
  // Guard against req.ip being an array (e.g. from HPP on X-Forwarded-For)
  // — falling through to a non-string key would serialize oddly in the lockout map.
  const clientIp = normalizeIp(req.ip);
  const user = _getLoginStmt().get(safeUsername);

  // Always perform a bcrypt comparison to prevent username enumeration via timing
  // side-channel. If the user doesn't exist, compare against a pre-computed dummy
  // hash so the CPU cost is identical whether the username is valid or not. The
  // compare MUST run before any length-based early-return below, otherwise an
  // oversized-password request for a non-existent account would return instantly
  // and leak which usernames exist (timing oracle). bcrypt.compare hashes only
  // the first 72 bytes, so an oversized password is safe to pass through here.
  const hashToCompare = (user && user.password) ? user.password : DUMMY_HASH;
  let passwordMatch;
  try {
    passwordMatch = await bcrypt.compare(password, hashToCompare);
  } catch (err) {
    // bcrypt.compare can throw on unexpected input (e.g. malformed hash, OOM).
    console.error('bcrypt.compare error during login:', err.message);
    req.flash('error', 'An error occurred during login. Please try again.');
    return res.redirect('/login');
  }

  // Reject overly long usernames and passwords after the constant-time bcrypt
  // compare to avoid reintroducing a timing oracle. An oversized username or
  // password cannot match, so rejecting here is fail-closed.
  if (typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES || safeUsername.length > MAX_USERNAME) {
    req.flash('error', 'Invalid username or password');
    return res.redirect('/login');
  }

  // Check lockout AFTER bcrypt compare (not before) to prevent timing-based
  // username enumeration. A locked-account response must take the same
  // ~200-300ms as a live-account wrong-password response.
  if (checkAccountLockout(safeUsername) || checkIpLockout(clientIp)) {
    audit({ req, action: 'login_blocked', entity: 'user', entityId: null, details: `Login blocked for username: ${safeUsername} (account or IP lockout)` });
    req.flash('error', 'Invalid username or password');
    return res.redirect('/login');
  }

  if (!user || !passwordMatch) {
    recordLoginFailure(safeUsername, clientIp);
    // Audit failed login attempt (user may not exist, use username as entityId substitute)
    audit({ req, action: 'login_failed', entity: 'user', entityId: user ? user.id : null, details: `Failed login for username: ${safeUsername}` });
    req.flash('error', 'Invalid username or password');
    return res.redirect('/login');
  }

  // Update last login
  _getUpdateLastLoginStmt().run(user.id);

  // Clear any login failure tracking for this account and IP
  clearLoginFailure(safeUsername);
  clearIpLoginFailure(clientIp);

  // Store user in session (without password) — regenerate session to prevent fixation
  // password intentionally excluded from session via destructuring
  const { password: _password, ...sessionUser } = user;

  try {
    await _regenerateSession(req.session);
  } catch (err) {
    console.error('Session regeneration error during login:', err.message);
    req.flash('error', 'An error occurred during login. Please try again.');
    return res.redirect('/login');
  }
  req.session.user = sessionUser;
  audit({ req, action: 'login', entity: 'user', entityId: user.id, details: `User ${safeUsername} logged in` });
  req.flash('success', `Welcome back, ${user.first_name}!`);
  return res.redirect('/dashboard');
}));

// Logout (POST only — GET logout is CSRF-vulnerable)
router.post('/logout', (req, res) => {
  if (req.session.user) {
    audit({ req, action: 'logout', entity: 'user', entityId: req.session.user.id });
  } else {
    // Audit logout attempts with a missing session user — this can happen when
    // a session cookie persists after the session store entry is deleted
    // (e.g. manual store cleanup). The audit trail should still record the
    // attempt even though we cannot attribute it to a specific user ID.
    audit({ req, action: 'logout', entity: 'user', entityId: null, details: 'Logout with no active session' });
  }
  req.session.destroy((err) => {
    if (err) {
      console.error('Session destroy error:', err.message);
    }
    try {
      // Match the full cookie options (including `secure`) used when the
      // session cookie was originally set — omitting `secure` on the clear
      // cookie can prevent browsers from removing a Secure cookie in
      // production. Mirrors the session config in app.js.
      res.clearCookie(SESSION_COOKIE, { ...SESSION_COOKIE_OPTIONS, secure: process.env.NODE_ENV === 'production' });
    } catch {
      // Non-critical — cookie clear failure does not prevent logout
    }
    if (!res.headersSent) {
      return res.redirect('/login');
    }
  });
});

// Lazily initialized for test isolation (consistent with the login stmts and audit.js).
let _profileSelectStmt = null;
function _getProfileSelectStmt() {
  if (!_profileSelectStmt) {
    _profileSelectStmt = db.prepare('SELECT id, username, email, first_name, last_name, role, department, phone, avatar, is_active, last_login, password_changed_at, created_at, updated_at FROM users WHERE id = ?');
  }
  return _profileSelectStmt;
}
let _profileUpdateStmt = null;
function _getProfileUpdateStmt() {
  if (!_profileUpdateStmt) {
    _profileUpdateStmt = db.prepare(`
      UPDATE users SET first_name = ?, last_name = ?, email = ?, phone = ?, updated_at = datetime('now')
      WHERE id = ?
    `);
  }
  return _profileUpdateStmt;
}
let _passwordSelectStmt = null;
function _getPasswordSelectStmt() {
  if (!_passwordSelectStmt) {
    _passwordSelectStmt = db.prepare('SELECT password FROM users WHERE id = ?');
  }
  return _passwordSelectStmt;
}
let _passwordUpdateStmt = null;
function _getPasswordUpdateStmt() {
  if (!_passwordUpdateStmt) {
    _passwordUpdateStmt = db.prepare('UPDATE users SET password = ?, password_changed_at = datetime(\'now\'), updated_at = datetime(\'now\') WHERE id = ?');
  }
  return _passwordUpdateStmt;
}

// Profile page
router.get('/profile', requireAuth, (req, res) => {
  const profileUser = _getProfileSelectStmt().get(req.session.user.id);
  if (!profileUser) {
    req.flash('error', 'Profile not found');
    return res.redirect('/login');
  }
  res.render('pages/auth/profile', { title: 'My Profile', profileUser });
});

// Update profile
router.put('/profile', requireAuth, profileLimiter, asyncHandler(async (req, res) => {
  const hppErrors = rejectHppArrays(req, ['first_name', 'last_name', 'email', 'phone']);
  if (hppErrors.length > 0) {
    req.flash('error', 'Invalid request parameters');
    return res.redirect('/profile');
  }

  const first_name = trim(safeQueryValue(req.body.first_name));
  const last_name = trim(safeQueryValue(req.body.last_name));
  const email = trim(safeQueryValue(req.body.email)).toLowerCase();
  const rawPhone = safeQueryValue(req.body.phone);
  // Reject overly long phone input before expensive sanitization
  if (typeof rawPhone === 'string' && rawPhone.length > MAX_PHONE) {
    req.flash('error', `Phone number must be at most ${MAX_PHONE} characters`);
    return res.redirect('/profile');
  }
  const phone = sanitizePhone(rawPhone);
  // Fail closed on a present-but-malformed phone: a value that sanitizes to
  // nothing (e.g. "abc", or a non-string JSON value) must be rejected rather
  // than silently stored as NULL — the fail-closed convention applied to every
  // other present-but-invalid field. Absent/empty values are allowed (no phone).
  if (rawPhone !== undefined && rawPhone !== null && rawPhone !== '' && !phone) {
    req.flash('error', 'Please enter a valid phone number');
    return res.redirect('/profile');
  }

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
  if (first_name.length > MAX_SHORT_STR) {
    req.flash('error', `First name must be at most ${MAX_SHORT_STR} characters`);
    return res.redirect('/profile');
  }
  if (last_name.length > MAX_SHORT_STR) {
    req.flash('error', `Last name must be at most ${MAX_SHORT_STR} characters`);
    return res.redirect('/profile');
  }

  if (email.length > MAX_EMAIL) {
    req.flash('error', `Email must be at most ${MAX_EMAIL} characters`);
    return res.redirect('/profile');
  }

  const safeFirstName = first_name.substring(0, MAX_SHORT_STR);
  const safeLastName = last_name.substring(0, MAX_SHORT_STR);
  const safeEmail = email.substring(0, MAX_EMAIL);
  const safePhone = phone ? phone.substring(0, MAX_PHONE) : null;
  const userId = req.session.user.id;
  try {
    const updateResult = _getProfileUpdateStmt().run(safeFirstName, safeLastName, safeEmail, safePhone, userId);
    if (updateResult.changes === 0) {
      console.error('Profile update: user not found (possibly deleted concurrently)');
      req.flash('error', 'User not found. Please log in again.');
      return res.redirect('/login');
    }

    // Regenerate session to prevent fixation — consistent with the password-change route
    try {
      await _regenerateSession(req.session);
    } catch (regErr) {
      console.error('Session regeneration error during profile update:', regErr.message);
      req.flash('error', 'An error occurred. Please try again.');
      return res.redirect('/profile');
    }

    // Fetch fresh user data from DB for the new session (consistent with
    // the password-change route) — avoids an incomplete session user object
    // that could cause issues for code reading role/username/department before
    // the auth middleware syncs them. Password is excluded so the session
    // never holds credential material.
    const freshUser = _getProfileSelectStmt().get(userId);
    if (freshUser) {
      const { password: _pw, ...sessionUser } = freshUser;
      req.session.user = sessionUser;
    }

    audit({ req, action: 'update', entity: 'user', entityId: userId, details: 'Updated own profile' });
    // Profile edits change first_name/last_name — the exact columns cached by
    // getActiveStaff() — so invalidate that cache too, mirroring the parallel
    // admin route (PUT /staff/:id). Previously dropdowns showed the old name
    // for up to the 30s TTL after a self-service rename.
    invalidateActiveStaffCache();
    invalidateDashboardCache();
    req.flash('success', 'Profile updated successfully');
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      req.flash('error', 'An account with this email address already exists');
    } else {
      req.flash('error', 'Error updating profile. Please try again.');
    }
  }

  return res.redirect('/profile');
}));

// Change password
router.put('/profile/password', requireAuth, passwordLimiter, asyncHandler(async (req, res) => {
  const hppErrors = rejectHppArrays(req, ['current_password', 'new_password', 'confirm_password']);
  if (hppErrors.length > 0) {
    req.flash('error', 'Invalid request parameters');
    return res.redirect('/profile');
  }

  const current_password = safeQueryValue(req.body.current_password);
  const new_password = safeQueryValue(req.body.new_password);
  const confirm_password = safeQueryValue(req.body.confirm_password);

  if (!current_password) {
    req.flash('error', 'Current password is required');
    return res.redirect('/profile');
  }

  // Reject excessively long / non-string current password to prevent bcrypt DoS
  // and silent 72-byte truncation.
  if (typeof current_password !== 'string' || Buffer.byteLength(current_password, 'utf8') > MAX_PASSWORD_BYTES) {
    req.flash('error', 'Invalid current password');
    return res.redirect('/profile');
  }

  if (typeof new_password !== 'string' || !new_password) {
    req.flash('error', 'New password is required');
    return res.redirect('/profile');
  }
  if (Buffer.byteLength(new_password, 'utf8') > MAX_PASSWORD_BYTES) {
    req.flash('error', `Password must be at most ${MAX_PASSWORD_BYTES} bytes`);
    return res.redirect('/profile');
  }

  if (typeof confirm_password !== 'string' || !confirm_password) {
    req.flash('error', 'Password confirmation is required');
    return res.redirect('/profile');
  }
  if (Buffer.byteLength(confirm_password, 'utf8') > MAX_PASSWORD_BYTES) {
    req.flash('error', 'Password confirmation is invalid');
    return res.redirect('/profile');
  }

  if (new_password !== confirm_password) {
    req.flash('error', 'New passwords do not match');
    return res.redirect('/profile');
  }

  if (current_password === new_password) {
    req.flash('error', 'New password must be different from current password');
    return res.redirect('/profile');
  }

  const pwError = validatePassword(new_password);
  if (pwError) {
    req.flash('error', pwError);
    return res.redirect('/profile');
  }

  const user = _getPasswordSelectStmt().get(req.session.user.id);
  if (!user) {
    req.flash('error', 'User not found');
    return res.redirect('/login');
  }

  let passwordMatch;
  try {
    passwordMatch = await bcrypt.compare(current_password, user.password);
  } catch (err) {
    console.error('bcrypt.compare error during password change:', err.message);
    req.flash('error', 'An error occurred. Please try again.');
    return res.redirect('/profile');
  }
  if (!passwordMatch) {
    req.flash('error', 'Current password is incorrect');
    return res.redirect('/profile');
  }

  let hashed;
  try {
    hashed = await bcrypt.hash(new_password, BCRYPT_SALT_ROUNDS);
  } catch (err) {
    console.error('bcrypt.hash error during password change:', err.message);
    req.flash('error', 'An error occurred. Please try again.');
    return res.redirect('/profile');
  }
  const updateResult = _getPasswordUpdateStmt().run(hashed, req.session.user.id);
  if (updateResult.changes === 0) {
    console.error('Password change: user not found (possibly deleted concurrently)');
    req.flash('error', 'User not found. Please log in again.');
    return res.redirect('/login');
  }

  audit({ req, action: 'update', entity: 'user', entityId: req.session.user.id, details: 'Changed own password' });
  invalidateDashboardCache();

  // Regenerate session to invalidate old session ID,
  // then fetch fresh user data from DB (don't carry over old session data)
  const userId = req.session.user.id;
  try {
    await _regenerateSession(req.session);
  } catch (err) {
    console.error('Session regeneration error during password change:', err.message);
    req.flash('error', 'An error occurred. Please try again.');
    return res.redirect('/profile');
  }
  // Fetch fresh user data (without password) for the new session
  const freshUser = _getProfileSelectStmt().get(userId);
  if (freshUser) {
    const { password: _pw, ...sessionUser } = freshUser;
    req.session.user = sessionUser;
  }
  req.flash('success', 'Password changed successfully');
  return res.redirect('/profile');
}));

/**
 * Reset module-level cached prepared statements (test use only).
 * Ensures test isolation when using mock db instances — consistent with
 * the same-named export in middleware/auth.js, audit.js, and utils.js.
 */
function resetCachedStatements() {
  _loginStmt = null;
  _updateLastLoginStmt = null;
  _profileSelectStmt = null;
  _profileUpdateStmt = null;
  _passwordSelectStmt = null;
  _passwordUpdateStmt = null;
}

module.exports = router;
module.exports.stopLoginFailureCleanup = stopLoginFailureCleanup;
module.exports.clearLoginFailure = clearLoginFailure;
module.exports.clearIpLoginFailure = clearIpLoginFailure;
module.exports.resetCachedStatements = resetCachedStatements;
