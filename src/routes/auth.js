const db = require('../models/database');
const bcrypt = require('bcryptjs');
const { requireAuth } = require('../middleware/auth');
const { audit, auditMiddleware } = require('../middleware/audit');
const { validatePassword, isValidEmail, trim, sanitizePhone, isValidPhone, asyncHandler, safeQueryValue, rejectHppArrays, resolveOptionalField, normalizeIp, invalidateActiveStaffCache, authKeyGenerator, findNonStringField, logError } = require('../utils');
const { SESSION_COOKIE, SESSION_COOKIE_OPTIONS, MAX_USERNAME, MAX_PASSWORD_BYTES, MAX_SHORT_STR, MAX_EMAIL, MAX_PHONE, BCRYPT_SALT_ROUNDS } = require('../constants');
const { invalidateDashboardCache } = require('./dashboard');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

function _regenerateSession(session) {
  return new Promise((resolve, reject) => {
    session.regenerate(err => err ? reject(err) : resolve());
  });
}

const router = require('express').Router();

// Mount the audit middleware on this router so `req.audit(...)` is defined for
// every route below — the same convention every other route module follows
// (`router.use(requireAuth, auditMiddleware)`).
//
// This module was the ONLY one that called `req.audit()` without mounting the
// middleware: GET /profile logged its read through `req.audit('read', 'user',
// ...)` (the app-wide convention for read surfaces), but the auth router never
// installed auditMiddleware, so `req.audit` was undefined and EVERY
// authenticated GET /profile request died with
// "TypeError: req.audit is not a function" — a 500 on the My Profile page that
// the header links from every screen. The unit test that pinned the read audit
// (tests/code_review_192.test.js) injected `req.audit` into its fake request
// by hand, so it exercised the handler but never the router's middleware
// chain, and could not see the missing wiring.
//
// NOTE: no requireAuth here — /login and /logout are public routes, so the
// middleware is mounted on its own and every route keeps its own auth guard.
router.use(auditMiddleware);

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
  // Lazily reset the failure count when the lockout window has expired. The
  // 10-minute purge only deletes expired entries on its next tick, and the
  // count is pinned at MAX_LOGIN_FAILURES while locked — without this reset a
  // single failure after expiry would immediately re-arm the lockout, keeping
  // an account/IP permanently locked with one request per window.
  if (entry.lockedUntil && Date.now() >= entry.lockedUntil) {
    entry.count = 0;
    entry.lockedUntil = null;
    entry.lastAttempt = Date.now();
    return false;
  }
  if (entry.lockedUntil) {
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
 * lastAttempt is older than the lockout window, then evicts the oldest
 * unlocked entry as a fallback. Entries in an ACTIVE lockout are never
 * evicted here — doing so would release that account's lockout early and
 * let a username flood defeat the per-account brute-force protection.
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
  // Still over capacity — evict the oldest unlocked entry. If every entry
  // is locked (active lockout), skip all of them — see below.
  for (const [key, val] of map) {
    if (val && val.lockedUntil && Date.now() < val.lockedUntil) {
      continue;
    }
    map.delete(key);
    break;
  }
  // When every entry is still locked, the stale-eviction loop above removed
  // nothing and there is no unlocked entry to evict. Deleting a *locked*
  // entry would release that account's active lockout early — a 10 000-name
  // username flood could then keep force-evicting a victim's lockout one
  // entry at a time and defeat the per-account brute-force protection. Keep
  // the locked entry and accept the transient over-capacity instead: every
  // entry has a lastAttempt within the lockout window, so the periodic
  // 10-minute purge recovers the slots within ~25 minutes without ever
  // releasing an active lockout.
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

  // Record per-IP failure. The entry also tracks WHICH accounts failed from
  // this source (a per-account tally), so a successful login can clear only
  // its OWN failures — see clearIpLoginFailure.
  if (ip) {
    purgeStaleEntries(ipLoginFailures);

    let ipEntry = ipLoginFailures.get(ip);
    if (!ipEntry) {
      ipEntry = { count: 0, lockedUntil: null, lastAttempt: null, accounts: new Map() };
    }
    if (!ipEntry.accounts) {
      ipEntry.accounts = new Map();
    }
    ipEntry.count++;
    ipEntry.accounts.set(safe, (ipEntry.accounts.get(safe) || 0) + 1);
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

/**
 * Clear the per-IP login-failure record.
 *
 * With a `username`, only THAT account's failures are cleared: the IP counter
 * is shared by every account behind the address, and clearing it wholesale on
 * any successful login let an attacker reset the IP-level brake at will (log
 * in with one valid account, then keep guessing other accounts five at a
 * time). Only the failures the account itself recorded are removed.
 *
 * Without a `username` the whole IP record is dropped (used to reset state).
 *
 * @param {string} ip - the lockout map key (the IPv6-aware source key)
 * @param {string} [username] - the account whose failures should be cleared
 */
function clearIpLoginFailure(ip, username) {
  if (!ip || typeof ip !== 'string') {
    return;
  }
  const entry = ipLoginFailures.get(ip);
  if (!entry) {
    return;
  }
  if (!username || typeof username !== 'string') {
    ipLoginFailures.delete(ip);
    return;
  }
  const safe = username.toLowerCase();
  const failures = entry.accounts && entry.accounts.get(safe);
  if (!failures) {
    // This account has no recorded failures at this source — leave the other
    // accounts' failures (and any active lockout) untouched.
    return;
  }
  entry.accounts.delete(safe);
  entry.count = Math.max(0, entry.count - failures);
  if (entry.count < MAX_LOGIN_FAILURES) {
    entry.lockedUntil = null;
  }
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
    req.flash('error', 'Please enter username and password.');
    return res.redirect('/login');
  }

  const username = safeQueryValue(req.body.username);
  const password = safeQueryValue(req.body.password);

  // A MISSING credential is reported as such. The absence test is an
  // explicit comparison, not a truthiness test: a present-but-falsy
  // non-string credential (0, false) is a TYPE error, not an absent one, and
  // must not be reported as a missing field.
  const usernameMissing = username === undefined || username === null || username === '';
  const passwordMissing = password === undefined || password === null || password === '';
  if (usernameMissing || passwordMissing) {
    req.flash('error', 'Please enter username and password.');
    return res.redirect('/login');
  }
  // A present-but-non-string credential is a type error: it is rejected with
  // the route's own "Invalid Login Credentials" wording — the same verdict a
  // wrong password gets — instead of being reported as a missing field or
  // reaching bcrypt.compare (which THROWS "Illegal arguments" on a non-string
  // and turned a client error into "An error occurred during login" plus a
  // server-side log entry).
  //
  // The comparison still runs, against the empty string, so the constant-time
  // username-enumeration defence below is unchanged: the early return is a
  // TYPE test, not a length test, and it reveals nothing about the account.
  const credentialTypesValid = typeof username === 'string' && typeof password === 'string';
  const usernameForCompare = typeof username === 'string' ? username : '';
  const passwordForCompare = typeof password === 'string' ? password : '';

  const safeUsername = usernameForCompare.toLowerCase();
  // The lockout map is keyed by the SAME IPv6-aware source key the login rate
  // limiter uses (ipKeyGenerator over the normalized address), so the two
  // mechanisms agree on what "one client" means. Keyed by the raw address
  // before, an IPv6 host with a /64 could rotate through 2^8 addresses and
  // reset the per-IP brake while the limiter still counted it as one client.
  // Guard against req.ip being an array (e.g. from HPP on X-Forwarded-For)
  // — falling through to a non-string key would serialize oddly in the lockout map.
  const clientIp = ipKeyGenerator(normalizeIp(req.ip));
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
    passwordMatch = await bcrypt.compare(passwordForCompare, hashToCompare);
  } catch (err) {
    // bcrypt.compare can throw on unexpected input (e.g. malformed hash, OOM).
    logError('bcrypt.compare error during login:', err);
    req.flash('error', 'An error occurred during login. Please try again.');
    return res.redirect('/login');
  }

  // Reject overly long usernames and passwords after the constant-time bcrypt
  // compare to avoid reintroducing a timing oracle. An oversized username or
  // password cannot match, so rejecting here is fail-closed.
  if (typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES || safeUsername.length > MAX_USERNAME) {
    req.flash('error', 'Invalid Login Credentials');
    return res.redirect('/login');
  }

  // The wrong-TYPE verdict, reached only after the constant-time comparison
  // above (so it leaks nothing about the account).
  if (!credentialTypesValid) {
    req.flash('error', 'Invalid Login Credentials');
    return res.redirect('/login');
  }

  // Check lockout AFTER bcrypt compare (not before) to prevent timing-based
  // username enumeration. A locked-account response must take the same
  // ~200-300ms as a live-account wrong-password response.
  if (checkAccountLockout(safeUsername) || checkIpLockout(clientIp)) {
    audit({ req, action: 'login_blocked', entity: 'user', entityId: null, details: `Login blocked for username: ${safeUsername} (account or IP lockout)` });
    req.flash('error', 'Invalid Login Credentials');
    return res.redirect('/login');
  }

  if (!user || !passwordMatch) {
    recordLoginFailure(safeUsername, clientIp);
    // Audit failed login attempt (user may not exist, use username as entityId substitute)
    audit({ req, action: 'login_failed', entity: 'user', entityId: user ? user.id : null, details: `Failed login for username: ${safeUsername}` });
    req.flash('error', 'Invalid Login Credentials');
    return res.redirect('/login');
  }

  // Update last login
  _getUpdateLastLoginStmt().run(user.id);

  // Clear the login-failure tracking for this account, and for this account's
  // failures at this source. The IP-level record for OTHER accounts behind the
  // same address is deliberately left alone (see clearIpLoginFailure).
  clearLoginFailure(safeUsername);
  clearIpLoginFailure(clientIp, safeUsername);

  // Store user in session (without password) — regenerate session to prevent fixation
  // password intentionally excluded from session via destructuring
  const { password: _pw, ...sessionUser } = user;

  try {
    await _regenerateSession(req.session);
  } catch (err) {
    logError('Session regeneration error during login:', err);
    req.flash('error', 'An error occurred during login. Please try again.');
    return res.redirect('/login');
  }
  req.session.user = sessionUser;
  audit({ req, action: 'login', entity: 'user', entityId: user.id, details: `User ${safeUsername} logged in` });
  req.flash('success', `Welcome back, ${user.first_name}!`);
  return res.redirect('/dashboard');
}));

// Rate limit logouts. The auth router is mounted at '/', which is NOT part of
// the app-wide write backstop in app.js (that list covers the ten resource
// routers), so POST /logout had no limiter at all. Every logout writes an
// audit row, so a client holding a single valid CSRF token could grow the
// audit_log table without bound. Keyed per account (the same authKeyGenerator
// convention the authenticated routes use), with the normalized-IP fallback
// for a request that carries no session.
const logoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  keyGenerator: authKeyGenerator,
  message: 'Too many logout attempts. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});

// Logout (POST only — GET logout is CSRF-vulnerable)
router.post('/logout', logoutLimiter, asyncHandler(async (req, res) => {
  // Fail closed on HTTP parameter pollution: reject array payloads. Mirrors
  // the array-rejection guards on every other write route in the app.
  //
  // The check is over EVERY body key, not a fixed field list: the previous
  // call passed an empty list, and rejectHppArrays() iterates that list, so
  // the guard could never fire — dead code that read like a fail-closed
  // check. Rejecting any array-valued body key actually implements the
  // stated intent, and a polluted `_csrf` is rejected by the CSRF middleware
  // anyway.
  //
  // The rejection MUST NOT cancel the logout. The handler reads NO body
  // field, so a polluted payload cannot affect what the route does — but the
  // guard used to return BEFORE the session was destroyed, so a JSON client
  // whose payload happened to contain an array got a "Invalid request
  // parameters" flash, a redirect to /login and a session that was STILL
  // ALIVE: the user believed they had logged out and had not. (A flash could
  // not have reported the anomaly either — the session is destroyed below,
  // which takes the flash with it.) The anomaly is recorded in the audit
  // trail instead, and the logout proceeds: a polluted payload has no field
  // to pollute.
  const hppErrors = rejectHppArrays(req, Object.keys(req.body || {}));
  const polluted = hppErrors.length > 0;
  if (req.session.user) {
    audit({
      req,
      action: 'logout',
      entity: 'user',
      entityId: req.session.user.id,
      details: polluted ? 'Logged out (request body carried an array-valued field)' : undefined
    });
  } else {
    // Audit logout attempts with a missing session user — this can happen when
    // a session cookie persists after the session store entry is deleted
    // (e.g. manual store cleanup). The audit trail should still record the
    // attempt even though we cannot attribute it to a specific user ID.
    audit({
      req,
      action: 'logout',
      entity: 'user',
      entityId: null,
      details: polluted
        ? 'Logout with no active session (request body carried an array-valued field)'
        : 'Logout with no active session'
    });
  }
  // Regenerate before destroy so the session id is rotated even in the
  // destroy-then-redirect path. destroy() alone leaves the pre-logout id
  // revivable by any cached copy of the cookie (back-button, service worker,
  // proxy cache) until the store entry is gone — the same fixation vector
  // the login/profile/password routes close with _regenerateSession.
  try {
    await _regenerateSession(req.session);
  } catch (err) {
    // Regeneration is best-effort: the destroy below still wipes the session
    // state, so a regenerate failure must not break logout.
    logError('Session regeneration error during logout:', err);
  }
  req.session.destroy((err) => {
    if (err) {
      logError('Session destroy error:', err);
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
}));

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
    // MILLISECOND-resolution marker (see the note in staff.js): the value is
    // compared against the copy stored in the session to invalidate sessions
    // issued against the old credential. With datetime('now')'s one-second
    // resolution, a change landing in the same second as the session marker
    // compared equal and the old session survived the credential change.
    _passwordUpdateStmt = db.prepare('UPDATE users SET password = ?, password_changed_at = strftime(\'%Y-%m-%d %H:%M:%f\', \'now\'), updated_at = datetime(\'now\') WHERE id = ?');
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
  req.audit('read', 'user', req.session.user.id, 'Viewed own profile');
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
  // Fail closed on a present-but-non-string REQUIRED column (e.g. a JSON
  // number in `first_name`): trim() coerces it to '', so the required-field
  // check below reported the type error as a MISSING field ("First name, last
  // name, and email are required"), while the sibling staff route reported
  // the identical submission as "Invalid request parameters" — a type error
  // masquerading as an absent one. The app-wide rule the README documents
  // ("A value of the wrong type ... is an invalid value, not a missing one,
  // and is reported as such") applies here too.
  const wrongTypeField = findNonStringField(req.body, ['first_name', 'last_name', 'email']);
  if (wrongTypeField) {
    req.flash('error', 'Invalid request parameters');
    return res.redirect('/profile');
  }
  // Absent-vs-present markers for the required profile fields. An ABSENT
  // field in a partial API submission preserves the stored value; a PRESENT
  // field must carry a valid value. The phone field on this route already
  // follows the resolveOptionalField convention (absent ⇒ preserve, '' ⇒
  // clear) — the three required fields were the sole exception, so a client
  // that submitted only a phone number was rejected with "First name, last
  // name, and email are required" even though the stored values were
  // perfectly valid. The stored values are read from the current row below.
  const firstNameAbsent = req.body.first_name === undefined || req.body.first_name === null;
  const lastNameAbsent = req.body.last_name === undefined || req.body.last_name === null;
  const emailAbsent = req.body.email === undefined || req.body.email === null;
  const currentProfile = _getProfileSelectStmt().get(req.session.user.id);
  if (!currentProfile) {
    req.flash('error', 'User not found. Please log in again.');
    return res.redirect('/login');
  }
  const resolvedFirstName = firstNameAbsent ? currentProfile.first_name : first_name;
  const resolvedLastName = lastNameAbsent ? currentProfile.last_name : last_name;
  const resolvedEmail = emailAbsent ? currentProfile.email : email;
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

  if (!resolvedFirstName || !resolvedLastName || !resolvedEmail) {
    req.flash('error', 'First name, last name, and email are required');
    return res.redirect('/profile');
  }

  // The length check runs BEFORE isValidEmail(): isValidEmail already caps the
  // length at MAX_EMAIL, so an over-long address failed the format check and
  // the user was told "Please enter a valid email address" — the dedicated
  // length message below was unreachable. The staff.js sibling checks the
  // length first, so the two routes reported the same condition differently.
  if (resolvedEmail.length > MAX_EMAIL) {
    req.flash('error', `Email must be at most ${MAX_EMAIL} characters`);
    return res.redirect('/profile');
  }

  if (!isValidEmail(resolvedEmail)) {
    req.flash('error', 'Please enter a valid email address');
    return res.redirect('/profile');
  }

  if (phone && !isValidPhone(phone)) {
    req.flash('error', 'Please enter a valid phone number');
    return res.redirect('/profile');
  }
  if (resolvedFirstName.length > MAX_SHORT_STR) {
    req.flash('error', `First name must be at most ${MAX_SHORT_STR} characters`);
    return res.redirect('/profile');
  }
  if (resolvedLastName.length > MAX_SHORT_STR) {
    req.flash('error', `Last name must be at most ${MAX_SHORT_STR} characters`);
    return res.redirect('/profile');
  }

  const safeFirstName = resolvedFirstName.substring(0, MAX_SHORT_STR);
  const safeLastName = resolvedLastName.substring(0, MAX_SHORT_STR);
  const safeEmail = resolvedEmail.substring(0, MAX_EMAIL);
  const userId = req.session.user.id;
  // Preserve the stored phone when the field is ABSENT from a partial
  // submission; an explicit empty string clears it. Mirrors the
  // resolveOptionalField convention used by the staff/vendors/assets update
  // routes. Previously an absent phone was unconditionally written as NULL,
  // silently wiping the stored value on any partial PUT.
  const resolvedPhone = resolveOptionalField(req.body.phone, phone || null, MAX_PHONE, currentProfile.phone);
  if (resolvedPhone && resolvedPhone.error) {
    req.flash('error', 'Please enter a valid phone number');
    return res.redirect('/profile');
  }
  const safePhone = resolvedPhone;
  try {
    const updateResult = _getProfileUpdateStmt().run(safeFirstName, safeLastName, safeEmail, safePhone, userId);
    if (updateResult.changes === 0) {
      logError('Profile update: user not found (possibly deleted concurrently)');
      req.flash('error', 'User not found. Please log in again.');
      return res.redirect('/login');
    }

    // Regenerate session to prevent fixation — consistent with the password-change route.
    //
    // The session-id change is a fixation defence, but session.regenerate()
    // also REPLACES req.session with a brand-new object that carries only the
    // cookie — every other session property is dropped. The app's idle and
    // absolute timeout anchors (sessionStart / lastAccess) live on the
    // session, so they were silently reset here. That made the documented
    // hard session-lifetime cap (SESSION_ABSOLUTE_TIMEOUT_SECONDS, 8h by
    // default) restart on every routine profile save, so a session could be
    // kept alive indefinitely by saving the profile page. The anchors are
    // carried across the regeneration: a profile save is the SAME
    // authentication, not a new one, so the absolute window must keep
    // running. (A genuine re-authentication — the login route and the
    // password-change route — deliberately starts a fresh window.)
    const previousSessionStart = req.session.sessionStart;
    const previousLastAccess = req.session.lastAccess;
    try {
      await _regenerateSession(req.session);
    } catch (regErr) {
      logError('Session regeneration error during profile update:', regErr);
      // The profile row was ALREADY written above, so the details are saved —
      // reporting "An error occurred. Please try again." contradicted what
      // happened and invited a pointless retry of a write that had succeeded.
      // Say what actually happened, and make the user log in again because the
      // session was left in an unknown state (the regeneration failed
      // mid-flight).
      req.flash('error', 'Your profile was updated, but your session could not be renewed. Please log in again.');
      return res.redirect('/login');
    }
    if (previousSessionStart) {
      req.session.sessionStart = previousSessionStart;
    }
    if (previousLastAccess) {
      req.session.lastAccess = previousLastAccess;
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
    req.flash('success', 'Profile updated successfully.');
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      req.flash('error', 'An account with this email address already exists');
    } else {
      // Every other catch block in the app logs the underlying error (the
      // shared logError helper). This one swallowed it, so a genuine DB
      // failure was indistinguishable from a routine rejection in the logs.
      logError('Profile update error:', err);
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

  // Fail closed on a present-but-non-string password (e.g. a JSON number):
  // it is a type error, not a missing field, so it is reported with the
  // app-wide "Invalid request parameters" instead of the "… is required"
  // wording a genuinely absent field gets. The sibling reset-password route
  // in staff.js already reports the identical submission this way.
  const wrongTypeField = findNonStringField(req.body, ['current_password', 'new_password', 'confirm_password']);
  if (wrongTypeField) {
    req.flash('error', 'Invalid request parameters');
    return res.redirect('/profile');
  }

  if (!current_password) {
    req.flash('error', 'Current password is required.');
    return res.redirect('/profile');
  }

  // Reject excessively long / non-string current password to prevent bcrypt DoS
  // and silent 72-byte truncation.
  if (typeof current_password !== 'string' || Buffer.byteLength(current_password, 'utf8') > MAX_PASSWORD_BYTES) {
    req.flash('error', 'Invalid Current Password');
    return res.redirect('/profile');
  }

  if (typeof new_password !== 'string' || !new_password) {
    req.flash('error', 'New password is required.');
    return res.redirect('/profile');
  }
  if (Buffer.byteLength(new_password, 'utf8') > MAX_PASSWORD_BYTES) {
    req.flash('error', `Password must be at most ${MAX_PASSWORD_BYTES} bytes`);
    return res.redirect('/profile');
  }

  if (typeof confirm_password !== 'string' || !confirm_password) {
    req.flash('error', 'Password confirmation is required.');
    return res.redirect('/profile');
  }
  if (Buffer.byteLength(confirm_password, 'utf8') > MAX_PASSWORD_BYTES) {
    req.flash('error', 'Password confirmation is invalid.');
    return res.redirect('/profile');
  }

  if (new_password !== confirm_password) {
    req.flash('error', 'New passwords do not match.');
    return res.redirect('/profile');
  }

  if (current_password === new_password) {
    req.flash('error', 'New password must be different from current password.');
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
    logError('bcrypt.compare error during password change:', err);
    req.flash('error', 'An error occurred. Please try again.');
    return res.redirect('/profile');
  }
  if (!passwordMatch) {
    req.flash('error', 'Current password is incorrect.');
    return res.redirect('/profile');
  }

  let hashed;
  try {
    hashed = await bcrypt.hash(new_password, BCRYPT_SALT_ROUNDS);
  } catch (err) {
    logError('bcrypt.hash error during password change:', err);
    req.flash('error', 'An error occurred. Please try again.');
    return res.redirect('/profile');
  }
  const updateResult = _getPasswordUpdateStmt().run(hashed, req.session.user.id);
  if (updateResult.changes === 0) {
    logError('Password change: user not found (possibly deleted concurrently)');
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
    logError('Session regeneration error during password change:', err);
    // The password hash was ALREADY written above, so the change SUCCEEDED —
    // the old password no longer works. Reporting "An error occurred. Please
    // try again." contradicted what happened and, worse, invited the user to
    // retry with the old password (which now fails) or to believe their old
    // password still works. Say what actually happened and send them to log
    // in again with the NEW password.
    req.flash('error', 'Your password was changed, but your session could not be renewed. Please log in again with your new password.');
    return res.redirect('/login');
  }
  // Fetch fresh user data (without password) for the new session
  const freshUser = _getProfileSelectStmt().get(userId);
  if (freshUser) {
    const { password: _pw, ...sessionUser } = freshUser;
    req.session.user = sessionUser;
  }
  req.flash('success', 'Password changed successfully.');
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
