const db = require('../models/database');
const { requireAuth } = require('../middleware/auth');

const router = require('express').Router();
router.use(requireAuth);

// List licenses
router.get('/', (req, res) => {
  const { license_type, search } = req.query;
  let where = ['1=1'];
  let params = [];
  
  if (license_type) { where.push('license_type = ?'); params.push(license_type); }
  if (search) {
    where.push('(software_name LIKE ? OR vendor LIKE ?)');
    const term = `%${search}%`;
    params.push(term, term);
  }
  
  const licenses = db.prepare(`
    SELECT * FROM licenses WHERE ${where.join(' AND ')} ORDER BY software_name ASC
  `).all(...params);

  res.render('pages/licenses/index', { title: 'Software Licenses', licenses, filters: req.query });
});

// New license
router.get('/new', (req, res) => {
  res.render('pages/licenses/form', { title: 'New License', license: {}, isEdit: false });
});

// Create license
router.post('/', (req, res) => {
  const { software_name, vendor, license_key, license_type, total_seats, used_seats, purchase_date, expiry_date, cost, notes } = req.body;
  
  try {
    db.prepare(`
      INSERT INTO licenses (software_name, vendor, license_key, license_type, total_seats, used_seats, purchase_date, expiry_date, cost, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(software_name, vendor, license_key, license_type, total_seats || 1, used_seats || 0, purchase_date || null, expiry_date || null, cost || null, notes);
    
    req.flash('success', `License for ${software_name} created`);
    res.redirect('/licenses');
  } catch (err) {
    req.flash('error', 'Error creating license: ' + err.message);
    res.redirect('/licenses/new');
  }
});

// Show license
router.get('/:id', (req, res) => {
  const license = db.prepare('SELECT * FROM licenses WHERE id = ?').get(req.params.id);
  if (!license) {
    req.flash('error', 'License not found');
    return res.redirect('/licenses');
  }
  res.render('pages/licenses/show', { title: license.software_name, license });
});

// Edit license
router.get('/:id/edit', (req, res) => {
  const license = db.prepare('SELECT * FROM licenses WHERE id = ?').get(req.params.id);
  if (!license) {
    req.flash('error', 'License not found');
    return res.redirect('/licenses');
  }
  res.render('pages/licenses/form', { title: 'Edit License', license, isEdit: true });
});

// Update license
router.put('/:id', (req, res) => {
  const { software_name, vendor, license_key, license_type, total_seats, used_seats, purchase_date, expiry_date, cost, notes } = req.body;
  
  try {
    db.prepare(`
      UPDATE licenses SET software_name = ?, vendor = ?, license_key = ?, license_type = ?,
        total_seats = ?, used_seats = ?, purchase_date = ?, expiry_date = ?, cost = ?, notes = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(software_name, vendor, license_key, license_type, total_seats || 1, used_seats || 0,
      purchase_date || null, expiry_date || null, cost || null, notes, req.params.id);
    
    req.flash('success', 'License updated');
    res.redirect(`/licenses/${req.params.id}`);
  } catch (err) {
    req.flash('error', 'Error updating license: ' + err.message);
    res.redirect(`/licenses/${req.params.id}/edit`);
  }
});

// Delete license
router.delete('/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM licenses WHERE id = ?').run(req.params.id);
    req.flash('success', 'License deleted');
  } catch (err) {
    req.flash('error', 'Error deleting license');
  }
  res.redirect('/licenses');
});

module.exports = router;
