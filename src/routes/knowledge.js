const db = require('../models/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { paginate, paginationBaseUrl, addSearch, buildFilters } = require('../utils');
const { marked } = require('marked');
const sanitizeHtml = require('sanitize-html');

const router = require('express').Router();
router.use(requireAuth, auditMiddleware);

const VALID_CATEGORIES = ['how_to','troubleshooting','policy','faq','sop','other'];
const VALID_STATUSES = ['draft','published','archived'];

// Configure marked for safe rendering
marked.setOptions({
  breaks: true,
  gfm: true,
});

function renderMarkdown(content) {
  const html = marked.parse(content);
  return sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'details', 'summary', 'input']),
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      img: ['src', 'alt', 'title'],
      input: ['type', 'checked', 'disabled'],
      code: ['class'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
  });
}

// List articles (paginated)
router.get('/', (req, res) => {
  const { page, limit, offset } = paginate(req);

  const filters = buildFilters({
    'k.category': { value: VALID_CATEGORIES.includes(req.query.category) ? req.query.category : '' },
    'k.status': { value: VALID_STATUSES.includes(req.query.status) ? req.query.status : '' },
  });

  const where = [...filters.where];
  const params = [...filters.params];
  addSearch(where, params, req.query.search, ['k.title', 'k.content', 'k.tags']);

  const whereClause = where.length ? where.join(' AND ') : '1=1';

  const total = db.prepare(`SELECT COUNT(*) as c FROM knowledge_articles k WHERE ${whereClause}`).get(...params).c;
  const totalPages = Math.ceil(total / limit) || 1;

  const articles = db.prepare(`
    SELECT k.*, u.first_name || ' ' || u.last_name as author_name
    FROM knowledge_articles k
    LEFT JOIN users u ON k.author_id = u.id
    WHERE ${whereClause}
    ORDER BY k.updated_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  res.render('pages/knowledge/index', {
    title: 'Knowledge Base', articles, filters: req.query,
    page, totalPages, total,
    baseUrl: paginationBaseUrl(req),
  });
});

// New article
router.get('/new', (req, res) => {
  res.render('pages/knowledge/form', { title: 'New Article', article: {}, isEdit: false });
});

// Create article
router.post('/', (req, res) => {
  const { title, content, category, tags, status, is_featured } = req.body;

  if (!title || !content || !category) {
    req.flash('error', 'Title, content, and category are required');
    return res.redirect('/knowledge/new');
  }

  if (!VALID_CATEGORIES.includes(category)) {
    req.flash('error', 'Invalid category');
    return res.redirect('/knowledge/new');
  }

  try {
    const result = db.prepare(`
      INSERT INTO knowledge_articles (title, content, category, tags, author_id, status, is_featured)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(title.substring(0, 200), content, category, (tags || '').substring(0, 500), req.session.user.id, status || 'draft', is_featured ? 1 : 0);

    req.audit('create', 'knowledge_article', result.lastInsertRowid, `Created article "${title}"`);
    req.flash('success', 'Article created');
    res.redirect(`/knowledge/${result.lastInsertRowid}`);
  } catch (err) {
    req.flash('error', 'Error creating article. Please try again.');
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

  article.renderedContent = renderMarkdown(article.content);

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
    `).run(title.substring(0, 200), content, category, (tags || '').substring(0, 500), status, is_featured ? 1 : 0, req.params.id);

    req.audit('update', 'knowledge_article', parseInt(req.params.id), `Updated article "${title}"`);
    req.flash('success', 'Article updated');
    res.redirect(`/knowledge/${req.params.id}`);
  } catch (err) {
    req.flash('error', 'Error updating article. Please try again.');
    res.redirect(`/knowledge/${req.params.id}/edit`);
  }
});

// Delete article
router.delete('/:id', requireRole('admin', 'manager'), (req, res) => {
  try {
    db.prepare('DELETE FROM knowledge_articles WHERE id = ?').run(req.params.id);
    req.audit('delete', 'knowledge_article', parseInt(req.params.id), 'Deleted article');
    req.flash('success', 'Article deleted');
  } catch (err) {
    req.flash('error', 'Error deleting article');
  }
  res.redirect('/knowledge');
});

module.exports = router;
