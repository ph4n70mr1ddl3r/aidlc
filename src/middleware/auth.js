const db = require('../models/database');

// Cache the prepared statement — requireAuth runs on every authenticated request
// and db.prepare() is relatively expensive.
const _authCheckStmt = db.prepare('SELECT id, is_active, role FROM users WHERE id = ?');

/**
 * Express middleware that verifies the user has an active session.
 * Checks session existence, database activity status, and role sync.
 * Redirects to /login if unauthenticated or deactivated.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function requireAuth(req, res, next) {
  if (!req.session.user) {
    req.flash('error', 'Please log in to access this page');
    return res.redirect('/login');
  }

  // Verify the user is still active in the database.
  // Without this check, a deactivated (or role-changed) user retains
  // full access until their session cookie expires (up to 24 h).
  try {
    const row = _authCheckStmt.get(req.session.user.id);
    if (!row || !row.is_active) {
      // Destroy session immediately so the user cannot keep browsing
      req.session.destroy(() => {
        res.clearCookie('connect.sid');
        // Can't use req.flash here — session is gone. Redirect to login
        // with a query hint so the login page can show a message.
        res.redirect('/login?reason=deactivated');
      });
      return;
    }
    // Keep session role in sync (admin may have changed it)
    if (row.role !== req.session.user.role) {
      req.session.user.role = row.role;
    }
  } catch (err) {
    // Fail closed — if we can't verify the session, treat it as unauthenticated.
    // Failing open would bypass auth on DB errors (e.g., corruption, disk full).
    console.error('Auth DB check error:', err.message);
    req.flash('error', 'Session verification failed. Please log in again.');
    return res.redirect('/login');
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
    // Defensive: redirect to login if session is missing rather than crashing.
    if (!req.session.user) {
      req.flash('error', 'Please log in to access this page');
      return res.redirect('/login');
    }
    // Verify user is still active in DB (same check as requireAuth).
    // Without this, a deactivated user retains access until session expiry.
    try {
      const row = _authCheckStmt.get(req.session.user.id);
      if (!row || !row.is_active) {
        req.session.destroy(() => {
          res.clearCookie('connect.sid');
          res.redirect('/login?reason=deactivated');
        });
        return;
      }
      // Keep session role in sync
      if (row.role !== req.session.user.role) {
        req.session.user.role = row.role;
      }
    } catch (err) {
      console.error('requireRole DB check error:', err.message);
      req.flash('error', 'Session verification failed. Please log in again.');
      return res.redirect('/login');
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
  if (!req.session.user) {
    return false;
  }
  const isAdminOrManager = req.session.user.role === 'admin' || req.session.user.role === 'manager';
  if (isAdminOrManager) {
    return true;
  }
  // Check various ownership fields
  const ownerId = resource.assigned_to || resource.owner_id || resource.user_id || resource.author_id;
  return ownerId && Number(ownerId) === Number(req.session.user.id);
}

module.exports = { requireAuth, requireRole, requireAdminOrManager, requireAdmin, canAccessResource };
