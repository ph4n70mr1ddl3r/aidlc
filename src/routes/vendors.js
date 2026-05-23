const db = require('../models/database');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = require('express').Router();
router.use(requireAuth);

// List vendors
router.get('/', (req, res) => {
  const { category, search } = req.query;
  let where = ['1=1'];
  let params = [];
  
  if (category) { where.push('category = ?'); params.push(category); }
  if (search) {
    where.push('(name LIKE ? OR contact_person LIKE ? OR email LIKE ?)');
    const term = `%${search}%`;
    params.push(term, term, term);
  }
  
  const vendors = db.prepare(`
    SELECT * FROM vendors WHERE ${where.join(' AND ')} ORDER BY name ASC
  `).all(...params);

  res.render('pages/vendors/index', { title: 'Vendors', vendors, filters: req.query });
});

// New vendor
router.get('/new', requireRole('admin', 'manager'), (req, res) => {
  res.render('pages/vendors/form', { title: 'New Vendor', vendor: {}, isEdit: false });
});

// Create vendor
router.post('/', requireRole('admin', 'manager'), (req, res) => {
  const { name, contact_person, email, phone, address, website, category, contract_start, contract_end, notes, rating } = req.body;
  
  if (!name) {
    req.flash('error', 'Vendor name is required');
    return res.redirect('/vendors/new');
  }

  try {
    db.prepare(`
      INSERT INTO vendors (name, contact_person, email, phone, address, website, category, contract_start, contract_end, notes, rating)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, contact_person || null, email || null, phone || null, address || null, 
      website || null, category || null, contract_start || null, contract_end || null, 
      notes || null, rating ? Math.max(1, Math.min(5, parseInt(rating))) : null);
    
    req.flash('success', `Vendor ${name} created`);
    res.redirect('/vendors');
  } catch (err) {
    req.flash('error', 'Error creating vendor. Please try again.');
    res.redirect('/vendors/new');
  }
});

// Show vendor
router.get('/:id', (req, res) => {
  const vendor = db.prepare('SELECT * FROM vendors WHERE id = ?').get(req.params.id);
  if (!vendor) {
    req.flash('error', 'Vendor not found');
    return res.redirect('/vendors');
  }
  res.render('pages/vendors/show', { title: vendor.name, vendor });
});

// Edit vendor
router.get('/:id/edit', requireRole('admin', 'manager'), (req, res) => {
  const vendor = db.prepare('SELECT * FROM vendors WHERE id = ?').get(req.params.id);
  if (!vendor) {
    req.flash('error', 'Vendor not found');
    return res.redirect('/vendors');
  }
  res.render('pages/vendors/form', { title: 'Edit Vendor', vendor, isEdit: true });
});

// Update vendor
router.put('/:id', requireRole('admin', 'manager'), (req, res) => {
  const { name, contact_person, email, phone, address, website, category, contract_start, contract_end, notes, rating, is_active } = req.body;
  
  try {
    db.prepare(`
      UPDATE vendors SET name = ?, contact_person = ?, email = ?, phone = ?, address = ?,
        website = ?, category = ?, contract_start = ?, contract_end = ?, notes = ?, rating = ?,
        is_active = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(name, contact_person || null, email || null, phone || null, address || null,
      website || null, category || null,
      contract_start || null, contract_end || null, notes || null, 
      rating ? Math.max(1, Math.min(5, parseInt(rating))) : null,
      is_active ? 1 : 0, req.params.id);
    
    req.flash('success', 'Vendor updated');
    res.redirect(`/vendors/${req.params.id}`);
  } catch (err) {
    req.flash('error', 'Error updating vendor. Please try again.');
    res.redirect(`/vendors/${req.params.id}/edit`);
  }
});

// Delete vendor
router.delete('/:id', requireRole('admin', 'manager'), (req, res) => {
  try {
    db.prepare('DELETE FROM vendors WHERE id = ?').run(req.params.id);
    req.flash('success', 'Vendor deleted');
  } catch (err) {
    req.flash('error', 'Error deleting vendor');
  }
  res.redirect('/vendors');
});

module.exports = router;
