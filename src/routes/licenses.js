const db = require('../models/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { paginate, paginationBaseUrl, addSearch, buildFilters } = require('../utils');

const router = require('express').Router();
router.use(requireAuth, auditMiddleware);

const VALID_LICENSE_TYPES = ['perpetual','subscription','volume','oem','academic'];

// List licenses (paginated)
router.get('/', (req, res) => {
  const { page, limit, offset } = paginate(req);

  const filters = buildFilters({
    'license_type': { value: VALID_LICENSE_TYPES.includes(req.query.license_type) ? req.query.license_type : '' },
  });

  const where = [...filters.where];
  const params = [...filters.params];
  addSearch(where, params, req.query.search, ['software_name', 'vendor']);

  const whereClause = where.length ? where.join(' AND ') : '1=1';

  const total = db.prepare(`SELECT COUNT(*) as c FROM licenses WHERE ${whereClause}`).get(...params).c;
  const totalPages = Math.ceil(total / limit) || 1;

  const licenses = db.prepare(`
    SELECT * FROM licenses WHERE ${whereClause} ORDER BY software_name ASC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  res.render('pages/licenses/index', {
    title: 'Software Licenses', licenses, filters: req.query,
    page, totalPages, total,
    baseUrl: paginationBaseUrl(req),
  });
});

// New license
router.get('/new', requireRole('admin', 'manager'), (req, res) => {
  res.render('pages/licenses/form', { title: 'New License', license: {}, isEdit: false });
});

// Create license
router.post('/', requireRole('admin', 'manager'), (req, res) => {
  const { software_name, vendor, license_key, license_type, total_seats, used_seats, purchase_date, expiry_date, cost, notes } = req.body;

  if (!software_name) {
    req.flash('error', 'Software name is required');
    return res.redirect('/licenses/new');
  }

  try {
    const result = db.prepare(`
      INSERT INTO licenses (software_name, vendor, license_key, license_type, total_seats, used_seats, purchase_date, expiry_date, cost, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(software_name, vendor || null, license_key || null, license_type || null,
      total_seats ? parseInt(total_seats) : 1, used_seats ? parseInt(used_seats) : 0,
      purchase_date || null, expiry_date || null, cost ? parseFloat(cost) : null, notes || null);

    req.audit('create', 'license', result.lastInsertRowid, `Created license for ${software_name}`);
    req.flash('success', `License for ${software_name} created`);
    res.redirect('/licenses');
  } catch (err) {
    req.flash('error', 'Error creating license. Please try again.');
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
router.get('/:id/edit', requireRole('admin', 'manager'), (req, res) => {
  const license = db.prepare('SELECT * FROM licenses WHERE id = ?').get(req.params.id);
  if (!license) {
    req.flash('error', 'License not found');
    return res.redirect('/licenses');
  }
  res.render('pages/licenses/form', { title: 'Edit License', license, isEdit: true });
});

// Update license
router.put('/:id', requireRole('admin', 'manager'), (req, res) => {
  const { software_name, vendor, license_key, license_type, total_seats, used_seats, purchase_date, expiry_date, cost, notes } = req.body;

  try {
    db.prepare(`
      UPDATE licenses SET software_name = ?, vendor = ?, license_key = ?, license_type = ?,
        total_seats = ?, used_seats = ?, purchase_date = ?, expiry_date = ?, cost = ?, notes = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(software_name, vendor || null, license_key || null, license_type || null,
      total_seats ? parseInt(total_seats) : 1, used_seats ? parseInt(used_seats) : 0,
      purchase_date || null, expiry_date || null, cost ? parseFloat(cost) : null, notes || null, req.params.id);

    req.audit('update', 'license', parseInt(req.params.id), `Updated license for ${software_name}`);
    req.flash('success', 'License updated');
    res.redirect(`/licenses/${req.params.id}`);
  } catch (err) {
    req.flash('error', 'Error updating license. Please try again.');
    res.redirect(`/licenses/${req.params.id}/edit`);
  }
});

// Delete license
router.delete('/:id', requireRole('admin', 'manager'), (req, res) => {
  try {
    db.prepare('DELETE FROM licenses WHERE id = ?').run(req.params.id);
    req.audit('delete', 'license', parseInt(req.params.id), 'Deleted license');
    req.flash('success', 'License deleted');
  } catch (err) {
    req.flash('error', 'Error deleting license');
  }
  res.redirect('/licenses');
});

module.exports = router;
