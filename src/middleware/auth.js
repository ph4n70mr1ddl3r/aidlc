const db = require('../models/database');
const { isPrivileged } = require('../utils');
const { SESSION_COOKIE, SESSION_COOKIE_OPTIONS } = require('../constants');
const { audit } = require('./audit');

const _authVerifiedSym = Symbol('authVerified');


// Shared "destroy this session and send the user to login" helper. Used by the
// requireAuth/requireRole path below and by app.js's session idle/absolute
// timeout middleware, so the destroy + cookie-clear + redirect sequence stays
// identical (and equally well-guarded) everywhere a session is killed.
// The redirectUrl may carry a `reason` query param the login page understands.
function destroySessionAndRedirect(req, res, redirectUrl, errMsg) {
  if (res.headersSent) {
    return;
  }
  req.session.destroy((err) => {
    if (err) {
      console.error(errMsg, err.message);
    }
    try {
      // Match the full cookie options (including `secure`) used when the
      // session cookie was originally set — omitting `secure` on the clear
      // cookie can prevent browsers from removing a Secure cookie in
      // production. Mirrors the session config in app.js.
      res.clearCookie(SESSION_COOKIE, { ...SESSION_COOKIE_OPTIONS, secure: process.env.NODE_ENV === 'production' });
    } catch {
      // Non-critical — cookie clear failure does not prevent redirect
    }
    // Guard against headers being sent during the async destroy callback
    // (e.g. by streaming middleware or a concurrent handler).
    if (!res.headersSent) {
      res.redirect(redirectUrl);
    }
  });
}


// Cache the prepared statement — requireAuth runs on every authenticated request
// and db.prepare() is relatively expensive.
let _authCheckStmt = null;
function _getAuthCheckStmt() {
  if (!_authCheckStmt) {
    _authCheckStmt = db.prepare('SELECT id, is_active, role, password_changed_at FROM users WHERE id = ?');
  }
  return _authCheckStmt;
}

/**
 * Verify the session user is still active in the database.
 * Shared by requireAuth and requireRole to avoid duplicating the DB check.
 * On failure, destroys the session and redirects to /login.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {boolean} true if user is valid, false if redirect was sent
 */
function _verifySessionUser(req, res) {
  if (!req.session || !req.session.user) {
    req.flash('error', 'Please log in to access this page');
    res.redirect('/login');
    return false;
  }

  // Skip duplicate DB verification within the same request — requireAuth and
  // requireRole both call _verifySessionUser, but Express middleware runs
  // synchronously so nothing can change between the two calls.
  if (req[_authVerifiedSym]) {
    return true;
  }

  try {
    const uid = req.session.user.id;
    if (uid == null) {
      destroySessionAndRedirect(req, res, '/login', 'Session verification failed. Please log in again.');
      return false;
    }
    const row = _getAuthCheckStmt().get(uid);
    if (!row || row.id !== uid || !row.is_active) {
      destroySessionAndRedirect(req, res, '/login?reason=deactivated', 'Session destroy error (deactivated):');
      return false;
    }
    if (row.password_changed_at && row.password_changed_at !== req.session.user.password_changed_at) {
      destroySessionAndRedirect(req, res, '/login?reason=password_changed', 'Session destroy error (password changed):');
      return false;
    }
    if (row.role !== req.session.user.role) {
      req.session.user = { ...req.session.user, role: row.role, password_changed_at: row.password_changed_at || null };
      // app.js captured res.locals.user BEFORE this middleware ran, so it
      // still references the pre-sync object — refresh it so templates and
      // isPrivileged()-gated UI rendered for THIS request reflect the synced
      // role instead of showing stale security-relevant UI for one request.
      if (res && res.locals) {
        res.locals.user = req.session.user;
      }
      // Persist the role change immediately so subsequent middleware in the
      // same request cycle (e.g. requireRole) sees the updated role without
      // waiting for the next response cycle's resave.
      req.session.save((err) => {
        if (err) {
          console.error('Session save error:', err.message);
        }
      });
    }
  } catch (err) {
    console.error('Auth DB check error:', err.message);
    req.flash('error', 'Session verification failed. Please log in again.');
    res.redirect('/login');
    return false;
  }

  req[_authVerifiedSym] = true;
  return true;
}

/**
 * Express middleware that verifies the user has an active session.
 * Checks session existence, database activity status, and role sync.
 * Redirects to /login if unauthenticated or deactivated.
 */
function requireAuth(req, res, next) {
  if (!_verifySessionUser(req, res)) {
    return;
  }
  next();
}

/**
 * Express middleware factory that restricts access to specific user roles.
 * Also verifies the user is still active in the database, preventing
 * deactivated users with valid sessions from accessing role-restricted routes.
 * @param {...string} roles - Allowed roles (e.g. 'admin', 'manager')
 * @returns {import('express').RequestHandler}
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!_verifySessionUser(req, res)) {
      return;
    }
    if (!roles.includes(req.session.user.role)) {
      // Record the denied attempt in the audit log — a compromised staff
      // account probing privileged endpoints (or any user exploring admin-only
      // routes) leaves the same trail the knowledge.js authorization guards
      // record via req.audit('access_denied', ...). audit() never throws, so a
      // logging failure cannot break the redirect.
      audit({
        req,
        action: 'access_denied',
        entity: 'user',
        entityId: req.session.user.id,
        details: `Role "${req.session.user.role}" not authorized for ${req.method} ${req.originalUrl}`
      });
      req.flash('error', 'You do not have permission to access this page');
      return res.redirect('/');
    }
    next();
  };
}

/**
 * Middleware to check if user is admin or manager.
 * Convenience wrapper for requireRole('admin', 'manager').
 */
function requireAdminOrManager(req, res, next) {
  return requireRole('admin', 'manager')(req, res, next);
}

/**
 * Middleware to check if user is admin.
 * Convenience wrapper for requireRole('admin').
 */
function requireAdmin(req, res, next) {
  return requireRole('admin')(req, res, next);
}

/**
 * Check if the current user can access a resource based on ownership/assignment.
 * Admin/manager can access everything. Regular staff can only access their own.
 * @param {Object} resource - The resource object with assigned_to or owner_id or user_id
 * @returns {boolean}
 */
function canAccessResource(req, resource) {
  if (!req.session.user || !resource) {
    return false;
  }
  if (isPrivileged(req.session.user)) {
    return true;
  }
  // Check all ownership fields — a resource may have multiple populated
  // and we must return true if any of them match the current user.
  const fields = ['assigned_to', 'owner_id', 'user_id', 'author_id'];
  return fields.some(f => resource[f] != null && Number(resource[f]) === Number(req.session.user.id));
}

// Reset module-level cached prepared statements (test use only).
// Ensures test isolation when using mock db instances.
function resetCachedStatements() {
  _authCheckStmt = null;
}
module.exports = { requireAuth, requireRole, requireAdminOrManager, requireAdmin, canAccessResource, destroySessionAndRedirect, resetCachedStatements };
