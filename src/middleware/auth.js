function requireAuth(req, res, next) {
  if (!req.session.user) {
    req.flash('error', 'Please log in to access this page');
    return res.redirect('/login');
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
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
