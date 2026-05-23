const db = require('../models/database');
const { requireAuth } = require('../middleware/auth');

const router = require('express').Router();
router.use(requireAuth);

// List articles
router.get('/', (req, res) => {
  const { category, status, search } = req.query;
  let where = ['1=1'];
  let params = [];
  
  if (category) { where.push('k.category = ?'); params.push(category); }
  if (status) { where.push('k.status = ?'); params.push(status); }
  if (search) {
    where.push('(k.title LIKE ? OR k.content LIKE ? OR k.tags LIKE ?)');
    const term = `%${search}%`;
    params.push(term, term, term);
  }
  
  const articles = db.prepare(`
    SELECT k.*, u.first_name || ' ' || u.last_name as author_name
    FROM knowledge_articles k
    LEFT JOIN users u ON k.author_id = u.id
    WHERE ${where.join(' AND ')}
    ORDER BY k.updated_at DESC
  `).all(...params);

  res.render('pages/knowledge/index', { title: 'Knowledge Base', articles, filters: req.query });
});

// New article
router.get('/new', (req, res) => {
  res.render('pages/knowledge/form', { title: 'New Article', article: {}, isEdit: false });
});

// Create article
router.post('/', (req, res) => {
  const { title, content, category, tags, status, is_featured } = req.body;
  
  try {
    const result = db.prepare(`
      INSERT INTO knowledge_articles (title, content, category, tags, author_id, status, is_featured)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(title, content, category, tags, req.session.user.id, status || 'draft', is_featured ? 1 : 0);
    
    req.flash('success', 'Article created');
    res.redirect(`/knowledge/${result.lastInsertRowid}`);
  } catch (err) {
    req.flash('error', 'Error creating article: ' + err.message);
    res.redirect('/knowledge/new');
  }
});

// Show article
router.get('/:id', (req, res) => {
  // Increment views
  db.prepare('UPDATE knowledge_articles SET views = views + 1 WHERE id = ?').run(req.params.id);
  
  const article = db.prepare(`
    SELECT k.*, u.first_name || ' ' || u.last_name as author_name
    FROM knowledge_articles k
    LEFT JOIN users u ON k.author_id = u.id
    WHERE k.id = ?
  `).get(req.params.id);
  
  if (!article) {
    req.flash('error', 'Article not found');
    return res.redirect('/knowledge');
  }
  res.render('pages/knowledge/show', { title: article.title, article });
});

// Edit article
router.get('/:id/edit', (req, res) => {
  const article = db.prepare('SELECT * FROM knowledge_articles WHERE id = ?').get(req.params.id);
  if (!article) {
    req.flash('error', 'Article not found');
    return res.redirect('/knowledge');
  }
  res.render('pages/knowledge/form', { title: 'Edit Article', article, isEdit: true });
});

// Update article
router.put('/:id', (req, res) => {
  const { title, content, category, tags, status, is_featured } = req.body;
  
  try {
    db.prepare(`
      UPDATE knowledge_articles SET title = ?, content = ?, category = ?, tags = ?,
        status = ?, is_featured = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(title, content, category, tags, status, is_featured ? 1 : 0, req.params.id);
    
    req.flash('success', 'Article updated');
    res.redirect(`/knowledge/${req.params.id}`);
  } catch (err) {
    req.flash('error', 'Error updating article: ' + err.message);
    res.redirect(`/knowledge/${req.params.id}/edit`);
  }
});

// Delete article
router.delete('/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM knowledge_articles WHERE id = ?').run(req.params.id);
    req.flash('success', 'Article deleted');
  } catch (err) {
    req.flash('error', 'Error deleting article');
  }
  res.redirect('/knowledge');
});

module.exports = router;
