const db = require('../models/database');

function requireAuth(req, res, next) {
  if (!req.session.user) {
    req.flash('error', 'Please log in to access this page');
    return res.redirect('/login');
  }

  // Verify the user is still active in the database.
  // Without this check, a deactivated (or role-changed) user retains
  // full access until their session cookie expires (up to 24 h).
  try {
    const row = db.prepare('SELECT id, is_active, role FROM users WHERE id = ?').get(req.session.user.id);
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
    // If the DB check fails, let the request through — failing open is
    // better than locking everyone out due to a transient SQLite error.
    console.error('Auth DB check error:', err.message);
  }

  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    // requireAuth must run first — this middleware assumes req.session.user exists.
    // Defensive: redirect to login if session is missing rather than crashing.
    if (!req.session.user) {
      req.flash('error', 'Please log in to access this page');
      return res.redirect('/login');
    }
    if (!roles.includes(req.session.user.role)) {
      req.flash('error', 'You do not have permission to access this page');
      return res.redirect('/dashboard');
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
