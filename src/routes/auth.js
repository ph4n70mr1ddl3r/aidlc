const db = require('../models/database');
const bcrypt = require('bcryptjs');
const { requireAuth, requireRole } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const { validatePassword, isValidEmail } = require('../utils');

const router = require('express').Router();

// Apply login rate limiter only to POST /login
const rateLimit = require('express-rate-limit');
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many login attempts. Please try again later.',
  skipSuccessfulRequests: true,
});

// Login page
router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('pages/auth/login', { title: 'Login' });
});

// Login handler
router.post('/login', loginLimiter, (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    req.flash('error', 'Please enter username and password');
    return res.redirect('/login');
  }

  // Sanitize username — only allow reasonable characters
  const safeUsername = String(username).substring(0, 50);
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(safeUsername);

  if (!user || !bcrypt.compareSync(password, user.password)) {
    req.flash('error', 'Invalid username or password');
    return res.redirect('/login');
  }

  // Update last login
  db.prepare(`UPDATE users SET last_login = datetime('now') WHERE id = ?`).run(user.id);

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
  req.session.destroy();
  res.redirect('/login');
});

// Profile page
router.get('/profile', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  const { password: _, ...profileUser } = row;
  res.render('pages/auth/profile', { title: 'My Profile', profileUser });
});

// Update profile
router.put('/profile', requireAuth, (req, res) => {
  const { first_name, last_name, email, phone } = req.body;

  if (!first_name || !first_name.trim() || !last_name || !last_name.trim() || !email) {
    req.flash('error', 'First name, last name, and email are required');
    return res.redirect('/profile');
  }

  if (!isValidEmail(email)) {
    req.flash('error', 'Please enter a valid email address');
    return res.redirect('/profile');
  }

  try {
    db.prepare(`
      UPDATE users SET first_name = ?, last_name = ?, email = ?, phone = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(first_name.substring(0, 100), last_name.substring(0, 100), email.substring(0, 200), (phone || '').substring(0, 50), req.session.user.id);

    // Update session
    req.session.user.first_name = first_name;
    req.session.user.last_name = last_name;
    req.session.user.email = email;

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

  const user = db.prepare('SELECT password FROM users WHERE id = ?').get(req.session.user.id);

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
  db.prepare(`UPDATE users SET password = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(hashed, req.session.user.id);

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
