const db = require('../models/database');
const { isPrivileged } = require('../utils');
const { SESSION_COOKIE, SESSION_COOKIE_OPTIONS } = require('../constants');

const _authVerifiedSym = Symbol('authVerified');


function _destroyAndRedirect(req, res, redirectUrl, errMsg) {
  res.clearCookie(SESSION_COOKIE, SESSION_COOKIE_OPTIONS);
  req.session.destroy((err) => {
    if (res.headersSent) {
      return;
    }
    if (err) {
      console.error(errMsg, err.message);
    }
    res.redirect(redirectUrl);
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
    const row = _getAuthCheckStmt().get(req.session.user.id);
    if (!row || !row.is_active) {
      _destroyAndRedirect(req, res, '/login?reason=deactivated', 'Session destroy error (deactivated):');
      return false;
    }
    if (row.password_changed_at && row.password_changed_at !== req.session.user.password_changed_at) {
      _destroyAndRedirect(req, res, '/login?reason=password_changed', 'Session destroy error (password changed):');
      return false;
    }
    if (row.role !== req.session.user.role) {
      req.session.user = { ...req.session.user, role: row.role };
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
      req.flash('error', 'You do not have permission to access this page');
      return res.redirect('/dashboard');
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
module.exports = { requireAuth, requireRole, requireAdminOrManager, requireAdmin, canAccessResource, resetCachedStatements };
