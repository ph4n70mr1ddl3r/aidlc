const db = require('../models/database');
const bcrypt = require('bcryptjs');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = require('express').Router();

// Login page
router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('pages/auth/login', { title: 'Login' });
});

// Login handler
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(username);
  
  if (!user || !bcrypt.compareSync(password, user.password)) {
    req.flash('error', 'Invalid username or password');
    return res.redirect('/login');
  }

  // Update last login
  db.prepare(`UPDATE users SET last_login = datetime('now') WHERE id = ?`).run(user.id);

  // Store user in session (without password)
  const { password: _, ...sessionUser } = user;
  req.session.user = sessionUser;
  
  req.flash('success', `Welcome back, ${user.first_name}!`);
  res.redirect('/dashboard');
});

// Logout
router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// Profile page
router.get('/profile', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  res.render('pages/auth/profile', { title: 'My Profile', profileUser: user });
});

// Update profile
router.put('/profile', requireAuth, (req, res) => {
  const { first_name, last_name, email, phone } = req.body;
  
  try {
    db.prepare(`
      UPDATE users SET first_name = ?, last_name = ?, email = ?, phone = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(first_name, last_name, email, phone, req.session.user.id);
    
    // Update session
    req.session.user.first_name = first_name;
    req.session.user.last_name = last_name;
    req.session.user.email = email;
    
    req.flash('success', 'Profile updated successfully');
  } catch (err) {
    req.flash('error', 'Error updating profile: ' + err.message);
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
  
  if (new_password.length < 6) {
    req.flash('error', 'Password must be at least 6 characters');
    return res.redirect('/profile');
  }
  
  const hashed = bcrypt.hashSync(new_password, 10);
  db.prepare(`UPDATE users SET password = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(hashed, req.session.user.id);
  
  req.flash('success', 'Password changed successfully');
  res.redirect('/profile');
});

module.exports = router;
