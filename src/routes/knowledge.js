const db = require('../models/database');
const { requireAuth, requireAdminOrManager } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { paginate, paginationBaseUrl, addSearch, buildFilters, safeId, trim } = require('../utils');
const { KB_CATEGORIES: VALID_CATEGORIES, KB_STATUSES: VALID_STATUSES } = require('../constants');
const { marked } = require('marked');
const sanitizeHtml = require('sanitize-html');

const router = require('express').Router();
router.use(requireAuth, auditMiddleware);

// Cached prepared statements for show/edit routes (static SQL).
const _showArticleStmt = db.prepare(`
    SELECT k.*, u.first_name || ' ' || u.last_name as author_name
    FROM knowledge_articles k
    LEFT JOIN users u ON k.author_id = u.id
    WHERE k.id = ?
  `);
const _editArticleStmt = db.prepare('SELECT * FROM knowledge_articles WHERE id = ?');
const _viewCountStmt = db.prepare('UPDATE knowledge_articles SET views = views + 1 WHERE id = ?');
const _deleteArticleStmt = db.prepare('DELETE FROM knowledge_articles WHERE id = ?');

// Cached prepared statements for create/update routes
const _articleInsertStmt = db.prepare(`
    INSERT INTO knowledge_articles (title, content, category, tags, author_id, status, is_featured)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
const _articleUpdateStmt = db.prepare(`
    UPDATE knowledge_articles SET title = ?, content = ?, category = ?, tags = ?,
      status = ?, is_featured = ?, updated_at = datetime('now')
    WHERE id = ?
  `);

// Configure marked options (passed per-call to avoid mutating global state)
const MARKED_OPTIONS = {
  breaks: true,
  gfm: true
};

function renderMarkdown(content) {
  try {
    const html = marked.parse(content, MARKED_OPTIONS);
    return sanitizeHtml(html, {
      allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'details', 'summary']),
      allowedAttributes: {
        ...sanitizeHtml.defaults.allowedAttributes,
        img: ['src', 'alt', 'title'],
        a: ['href', 'name', 'target', 'rel', 'title'],
        code: ['class']
      },
      // Force rel="noopener noreferrer" on all links for defense-in-depth
      // against reverse tabnabbing, even though marked doesn't emit target="_blank".
      transformTags: {
        a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' })
      },
      allowedSchemes: ['http', 'https', 'mailto'],
      allowedSchemesAppliedToAttributes: ['href', 'src'],
      allowProtocolRelative: false
    });
  } catch (err) {
    // If markdown/sanitization fails, escape and return as plain text
    console.error('Markdown render error:', err.message);
    return sanitizeHtml(content, {
      allowedTags: [],
      allowedAttributes: {},
      allowedSchemes: ['http', 'https', 'mailto']
    });
  }
}

// List articles (paginated)
router.get('/', (req, res) => {
  const { page, limit, offset } = paginate(req);

  const filters = buildFilters({
    'k.category': { value: VALID_CATEGORIES.includes(req.query.category) ? req.query.category : '' },
    'k.status': { value: VALID_STATUSES.includes(req.query.status) ? req.query.status : '' }
  }, ['k.category', 'k.status']);

  const where = [...filters.where];
  const params = [...filters.params];
  addSearch(where, params, req.query.search, ['k.title', 'k.content', 'k.tags']);

  // Visibility: non-privileged users can only see published articles and their own drafts/archived.
  // The show page already restricts access, but the index was leaking draft metadata
  // (titles, authors, categories) to all authenticated users.
  const isPrivileged = req.session.user.role === 'admin' || req.session.user.role === 'manager';
  if (!isPrivileged) {
    where.push("(k.status = 'published' OR k.author_id = ?)");
    params.push(req.session.user.id);
  }

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
    page, limit, totalPages, total,
    baseUrl: paginationBaseUrl(req)
  });
});

// New article
router.get('/new', requireAdminOrManager, (req, res) => {
  res.render('pages/knowledge/form', { title: 'New Article', article: {}, isEdit: false });
});

// Create article
router.post('/', (req, res) => {
  const title = trim(req.body.title);
  const content = trim(req.body.content);
  const category = req.body.category;
  const tags = trim(req.body.tags);
  const status = req.body.status;
  const is_featured = req.body.is_featured;

  if (!title || !content || !category) {
    req.flash('error', 'Title, content, and category are required');
    return res.redirect('/knowledge/new');
  }
  if (title.length > 200) {
    req.flash('error', 'Title must be at most 200 characters');
    return res.redirect('/knowledge/new');
  }
  if (content.length > 50000) {
    req.flash('error', 'Content must be at most 50,000 characters');
    return res.redirect('/knowledge/new');
  }
  if (tags.length > 500) {
    req.flash('error', 'Tags must be at most 500 characters');
    return res.redirect('/knowledge/new');
  }

  if (!VALID_CATEGORIES.includes(category)) {
    req.flash('error', 'Invalid category');
    return res.redirect('/knowledge/new');
  }

  const isPrivileged = req.session.user.role === 'admin' || req.session.user.role === 'manager';
  const safeStatus = isPrivileged && VALID_STATUSES.includes(status) ? status : 'draft';
  // Non-privileged users can only create drafts — publishing requires admin/manager

  const safeFeatured = isPrivileged ? (is_featured ? 1 : 0) : 0;

  try {
    const result = _articleInsertStmt.run(title.substring(0, 200), content.substring(0, 50000), category, tags.substring(0, 500) || null, req.session.user.id, safeStatus, safeFeatured);

    req.audit('create', 'knowledge_article', result.lastInsertRowid, `Created article "${title}"`);
    req.flash('success', 'Article created');
    res.redirect(`/knowledge/${result.lastInsertRowid}`);
  } catch (err) {
    console.error('Article create error:', err.message);
    req.flash('error', 'Error creating article. Please try again.');
    res.redirect('/knowledge/new');
  }
});

// Show article
router.get('/:id', (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid article ID');
    return res.redirect('/knowledge');
  }

  const article = _showArticleStmt.get(id);

  if (!article) {
    req.flash('error', 'Article not found');
    return res.redirect('/knowledge');
  }

  // Visibility: non-published articles are only visible to the author and admin/manager.
  // Without this check any authenticated user can read drafts/archived articles by URL.
  if (article.status !== 'published') {
    const isOwner = article.author_id === req.session.user.id;
    const isPrivileged = req.session.user.role === 'admin' || req.session.user.role === 'manager';
    if (!isOwner && !isPrivileged) {
      req.flash('error', 'Article not found');
      return res.redirect('/knowledge');
    }
  }

  // Increment views only once per session per article to prevent refresh inflation.
  // Cap the tracked set to prevent unbounded session growth.
  const VIEWED_KEY = 'kb_viewed';
  const MAX_VIEWED_ARTICLES = 200;
  if (!req.session[VIEWED_KEY]) {
    req.session[VIEWED_KEY] = {};
  }
  const viewed = req.session[VIEWED_KEY];
  if (!viewed[id] && article.author_id !== req.session.user.id) {
    _viewCountStmt.run(id);
    viewed[id] = true;
    // Evict oldest entries if the tracking set exceeds the cap
    const keys = Object.keys(viewed);
    if (keys.length > MAX_VIEWED_ARTICLES) {
      for (let i = 0; i < keys.length - MAX_VIEWED_ARTICLES; i++) {
        delete viewed[keys[i]];
      }
    }
  }

  article.renderedContent = renderMarkdown(article.content);

  res.render('pages/knowledge/show', { title: article.title, article });
});

// Edit article (author or admin/manager only)
router.get('/:id/edit', (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid article ID');
    return res.redirect('/knowledge');
  }

  const article = _editArticleStmt.get(id);
  if (!article) {
    req.flash('error', 'Article not found');
    return res.redirect('/knowledge');
  }

  const isOwner = article.author_id === req.session.user.id;
  const isPrivileged = req.session.user.role === 'admin' || req.session.user.role === 'manager';
  if (!isOwner && !isPrivileged) {
    req.flash('error', 'You can only edit your own articles');
    return res.redirect(`/knowledge/${id}`);
  }

  res.render('pages/knowledge/form', { title: 'Edit Article', article, isEdit: true });
});

// Update article (author or admin/manager only)
router.put('/:id', (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid article ID');
    return res.redirect('/knowledge');
  }

  // Authorization check
  const existing = _editArticleStmt.get(id);
  if (!existing) {
    req.flash('error', 'Article not found');
    return res.redirect('/knowledge');
  }
  const isOwner = existing.author_id === req.session.user.id;
  const isPrivileged = req.session.user.role === 'admin' || req.session.user.role === 'manager';
  if (!isOwner && !isPrivileged) {
    req.flash('error', 'You can only edit your own articles');
    return res.redirect(`/knowledge/${id}`);
  }

  const title = trim(req.body.title);
  const content = trim(req.body.content);
  const category = req.body.category;
  const tags = trim(req.body.tags);
  const status = req.body.status;
  const is_featured = req.body.is_featured;

  if (!title || !content || !category) {
    req.flash('error', 'Title, content, and category are required');
    return res.redirect(`/knowledge/${id}/edit`);
  }
  if (title.length > 200) {
    req.flash('error', 'Title must be at most 200 characters');
    return res.redirect(`/knowledge/${id}/edit`);
  }
  if (content.length > 50000) {
    req.flash('error', 'Content must be at most 50,000 characters');
    return res.redirect(`/knowledge/${id}/edit`);
  }
  if (tags.length > 500) {
    req.flash('error', 'Tags must be at most 500 characters');
    return res.redirect(`/knowledge/${id}/edit`);
  }

  // Non-privileged users cannot publish — force to draft
  const safeUpdateStatus = isPrivileged && VALID_STATUSES.includes(status) ? status : 'draft';
  if (!VALID_CATEGORIES.includes(category)) {
    req.flash('error', 'Invalid category');
    return res.redirect(`/knowledge/${id}/edit`);
  }

  const safeFeatured = isPrivileged ? (is_featured ? 1 : 0) : 0;

  try {
    _articleUpdateStmt.run(title.substring(0, 200), content.substring(0, 50000), category, tags.substring(0, 500) || null, safeUpdateStatus, safeFeatured, id);

    req.audit('update', 'knowledge_article', id, `Updated article "${title}"`);
    req.flash('success', 'Article updated');
    res.redirect(`/knowledge/${id}`);
  } catch (err) {
    console.error('Article update error:', err.message);
    req.flash('error', 'Error updating article. Please try again.');
    res.redirect(`/knowledge/${id}/edit`);
  }
});

// Delete article
router.delete('/:id', requireAdminOrManager, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) {
    req.flash('error', 'Invalid article ID');
    return res.redirect('/knowledge');
  }

  try {
    const result = _deleteArticleStmt.run(id);
    if (result.changes === 0) {
      req.flash('error', 'Article not found');
    } else {
      req.audit('delete', 'knowledge_article', id, 'Deleted article');
      req.flash('success', 'Article deleted');
    }
  } catch (err) {
    console.error('Article delete error:', err.message);
    req.flash('error', 'Error deleting article');
  }
  res.redirect('/knowledge');
});

module.exports = router;
