const db = require('../models/database');
const { isPrivileged } = require('../utils');

// Cache the prepared statement — requireAuth runs on every authenticated request
// and db.prepare() is relatively expensive.
const _authCheckStmt = db.prepare('SELECT id, is_active, role FROM users WHERE id = ?');

/**
 * Verify the session user is still active in the database.
 * Shared by requireAuth and requireRole to avoid duplicating the DB check.
 * On failure, destroys the session and redirects to /login.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {boolean} true if user is valid, false if redirect was sent
 */
function _verifySessionUser(req, res) {
  if (!req.session.user) {
    req.flash('error', 'Please log in to access this page');
    res.redirect('/login');
    return false;
  }

  try {
    const row = _authCheckStmt.get(req.session.user.id);
    if (!row || !row.is_active) {
      req.session.destroy(() => {
        res.clearCookie('connect.sid');
        res.redirect('/login?reason=deactivated');
      });
      return false;
    }
    // Keep session role in sync (admin may have changed it)
    if (row.role !== req.session.user.role) {
      req.session.user.role = row.role;
    }
  } catch (err) {
    // Fail closed — if we can't verify the session, treat it as unauthenticated.
    console.error('Auth DB check error:', err.message);
    req.flash('error', 'Session verification failed. Please log in again.');
    res.redirect('/login');
    return false;
  }

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
  return fields.some(f => resource[f] && Number(resource[f]) === Number(req.session.user.id));
}

module.exports = { requireAuth, requireRole, requireAdminOrManager, requireAdmin, canAccessResource };
