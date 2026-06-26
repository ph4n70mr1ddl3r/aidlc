const db = require('../models/database');
const { requireAuth, requireAdminOrManager } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { paginate, paginationBaseUrl, addSearch, buildFilters, safeId, trim, countQuery, selectQuery, isPrivileged } = require('../utils');
const { KB_CATEGORIES: VALID_CATEGORIES, KB_STATUSES: VALID_STATUSES, MAX_MEDIUM_STR, MAX_CONTENT, MAX_LONG_STR } = require('../constants');
const { invalidateDashboardCache } = require('./dashboard');
const { marked } = require('marked');
const sanitizeHtml = require('sanitize-html');
const rateLimit = require('express-rate-limit');

// Rate limit knowledge article creation/update — markdown parsing + sanitization
// is CPU-intensive and could be abused for server-side DoS even by authenticated users.
const kbWriteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 30,
  message: 'Too many article submissions. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});

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

// Module-level constants for session view tracking (avoids redefining per-request)
const VIEWED_KEY = 'kb_viewed';
const MAX_VIEWED_ARTICLES = 200;

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

function resolveSafeStatus(user, status, existingStatus) {
  if (isPrivileged(user)) {
    return status || 'draft';
  }
  // Non-privileged owners editing their own article must not promote status
  // (e.g. draft -> published). They may keep the existing status or demote to
  // draft (unpublish). When the status field is absent from the request the
  // caller passes existing.status, so the check below preserves it unchanged.
  if (existingStatus && status !== existingStatus && status !== 'draft') {
    return existingStatus;
  }
  return status || 'draft';
}

function resolveSafeFeatured(user, is_featured) {
  if (!isPrivileged(user)) {
    return 0;
  }
  return (is_featured && is_featured !== '0') ? 1 : 0;
}

// Configure marked options (passed per-call to avoid mutating global state)
const MARKED_OPTIONS = {
  breaks: true,
  gfm: true
};

const SANITIZE_HTML_OPTIONS = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'details', 'summary', 'del', 'input']),
  allowedAttributes: {
    ...sanitizeHtml.defaults.allowedAttributes,
    img: ['src', 'alt', 'title'],
    a: ['href', 'name', 'target', 'rel', 'title'],
    code: ['class'],
    input: ['type', 'checked', 'disabled']
  },
  // Force rel="noopener noreferrer" on all links for defense-in-depth
  // against reverse tabnabbing, even though marked doesn't emit target="_blank".
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' })
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesAppliedToAttributes: ['href', 'src'],
  allowProtocolRelative: false
};

const STRIP_HTML_OPTIONS = {
  allowedTags: [],
  allowedAttributes: {},
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesAppliedToAttributes: ['href', 'src']
};

function renderMarkdown(content) {
  if (!content || typeof content !== 'string') {
    return '';
  }
  try {
    // marked.parse() is synchronous unless async extensions are registered
    // (none here), so it returns a string.  Guard against async extensions by
    // rejecting thenables — otherwise sanitizeHtml would receive a Promise
    // and render "[object Promise]" in the template.
    const html = marked.parse(content, MARKED_OPTIONS);
    if (html && typeof html.then === 'function') {
      throw new Error('marked.parse returned a Promise (async extension detected) — fall back to plain text');
    }
    return sanitizeHtml(html, SANITIZE_HTML_OPTIONS);
  } catch (err) {
    // If markdown/sanitization fails, escape the raw content and wrap in a
    // visible error notice so the user knows rendering failed instead of
    // seeing a blank page.
    console.error('Markdown render error:', err.message);
    const escaped = sanitizeHtml(content, STRIP_HTML_OPTIONS);
    return `<div class="alert alert-info">Article content could not be rendered. Showing plain text:</div><pre>${escaped}</pre>`;
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
  if (!isPrivileged(req.session.user)) {
    where.push("(k.status = 'published' OR k.author_id = ?)");
    params.push(req.session.user.id);
  }

  const whereClause = where.length ? where.join(' AND ') : '1=1';

  const total = countQuery(db, 'knowledge_articles', 'k', whereClause, params);
  const totalPages = Math.ceil(total / limit) || 1;

  const articles = selectQuery(db, `
    SELECT k.*, u.first_name || ' ' || u.last_name as author_name
    FROM knowledge_articles k
    LEFT JOIN users u ON k.author_id = u.id
    WHERE ${whereClause}
    ORDER BY k.updated_at DESC
    LIMIT ? OFFSET ?
  `, [...params, limit, offset]);

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
router.post('/', requireAdminOrManager, kbWriteLimiter, (req, res) => {
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
  if (title.length > MAX_MEDIUM_STR) {
    req.flash('error', `Title must be at most ${MAX_MEDIUM_STR} characters`);
    return res.redirect('/knowledge/new');
  }
  if (content.length > MAX_CONTENT) {
    req.flash('error', `Content must be at most ${MAX_CONTENT} characters`);
    return res.redirect('/knowledge/new');
  }
  if (tags.length > MAX_LONG_STR) {
    req.flash('error', `Tags must be at most ${MAX_LONG_STR} characters`);
    return res.redirect('/knowledge/new');
  }

  if (!VALID_CATEGORIES.includes(category)) {
    req.flash('error', 'Invalid category');
    return res.redirect('/knowledge/new');
  }

  if (status && !VALID_STATUSES.includes(status)) {
    req.flash('error', 'Invalid status');
    return res.redirect('/knowledge/new');
  }

  const safeStatus = resolveSafeStatus(req.session.user, status || 'draft', null);
  const safeFeatured = resolveSafeFeatured(req.session.user, is_featured);

  // Sanitize tags and title for defense-in-depth (templates escape with <%=, but strip HTML at input too)
  const safeTags = sanitizeHtml((tags || '').substring(0, MAX_LONG_STR), STRIP_HTML_OPTIONS) || null;
  const safeTitle = sanitizeHtml(title.substring(0, MAX_MEDIUM_STR), STRIP_HTML_OPTIONS);

  try {
    const result = _articleInsertStmt.run(safeTitle, content.substring(0, MAX_CONTENT), category, safeTags, req.session.user.id, safeStatus, safeFeatured);

    req.audit('create', 'knowledge_article', result.lastInsertRowid, `Created article "${safeTitle}"`);
    req.flash('success', 'Article created');
    invalidateDashboardCache();
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
    if (!isOwner && !isPrivileged(req.session.user)) {
      req.flash('error', 'Article not found');
      return res.redirect('/knowledge');
    }
  }

  // Increment views only once per session per article to prevent refresh inflation.
  // Cap the tracked set to prevent unbounded session growth.
  // Use an array (not an object) so eviction removes the oldest-viewed article —
  // Object.keys() on integer-like keys returns numeric order, which would evict
  // the lowest-ID article instead of the oldest viewed.
  if (!req.session[VIEWED_KEY]) {
    req.session[VIEWED_KEY] = [];
  }
  const viewed = req.session[VIEWED_KEY];
  if (!viewed.includes(id) && article.author_id !== req.session.user.id) {
    try {
      _viewCountStmt.run(id);
    } catch (err) {
      console.error('View count update error:', err.message);
    }
    viewed.push(id);
    // Evict oldest entries (front of array) if the tracking set exceeds the cap
    if (viewed.length > MAX_VIEWED_ARTICLES) {
      viewed.splice(0, viewed.length - MAX_VIEWED_ARTICLES);
    }
    // Reassign to trigger session.modified flag (resave:false won't persist
    // in-place array mutations)
    req.session[VIEWED_KEY] = [...viewed];
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
  if (!isOwner && !isPrivileged(req.session.user)) {
    req.flash('error', 'You can only edit your own articles');
    return res.redirect(`/knowledge/${id}`);
  }

  res.render('pages/knowledge/form', { title: 'Edit Article', article, isEdit: true });
});

// Update article (author or admin/manager only)
router.put('/:id', kbWriteLimiter, (req, res) => {
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
  if (!isOwner && !isPrivileged(req.session.user)) {
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
  if (title.length > MAX_MEDIUM_STR) {
    req.flash('error', `Title must be at most ${MAX_MEDIUM_STR} characters`);
    return res.redirect(`/knowledge/${id}/edit`);
  }
  if (content.length > MAX_CONTENT) {
    req.flash('error', `Content must be at most ${MAX_CONTENT} characters`);
    return res.redirect(`/knowledge/${id}/edit`);
  }
  if (tags.length > MAX_LONG_STR) {
    req.flash('error', `Tags must be at most ${MAX_LONG_STR} characters`);
    return res.redirect(`/knowledge/${id}/edit`);
  }

  if (!VALID_CATEGORIES.includes(category)) {
    req.flash('error', 'Invalid category');
    return res.redirect(`/knowledge/${id}/edit`);
  }

  if (status && !VALID_STATUSES.includes(status)) {
    req.flash('error', 'Invalid status');
    return res.redirect(`/knowledge/${id}/edit`);
  }

  const safeStatus = resolveSafeStatus(req.session.user, status || existing.status, existing.status);
  const safeFeatured = is_featured !== undefined ? resolveSafeFeatured(req.session.user, is_featured) : existing.is_featured;

  // Sanitize tags and title for defense-in-depth (templates escape with <%=, but strip HTML at input too)
  const safeTags = sanitizeHtml((tags || '').substring(0, MAX_LONG_STR), STRIP_HTML_OPTIONS) || null;
  const safeTitle = sanitizeHtml(title.substring(0, MAX_MEDIUM_STR), STRIP_HTML_OPTIONS);

  try {
    const result = _articleUpdateStmt.run(safeTitle, content.substring(0, MAX_CONTENT), category, safeTags, safeStatus, safeFeatured, id);
    if (result.changes === 0) {
      req.flash('error', 'Article not found');
      return res.redirect('/knowledge');
    }

    req.audit('update', 'knowledge_article', id, `Updated article "${safeTitle}"`);
    req.flash('success', 'Article updated');
    invalidateDashboardCache();
    res.redirect(`/knowledge/${id}`);
  } catch (err) {
    console.error('Article update error:', err.message);
    req.flash('error', 'Error updating article. Please try again.');
    res.redirect(`/knowledge/${id}/edit`);
  }
});

// Delete article
router.delete('/:id', requireAdminOrManager, kbWriteLimiter, (req, res) => {
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
      invalidateDashboardCache();
    }
  } catch (err) {
    console.error('Article delete error:', err.message);
    req.flash('error', 'Error deleting article');
  }
  res.redirect('/knowledge');
});

module.exports = router;
// Exposed for unit testing (the route module is mocked in app.test.js).
module.exports.renderMarkdown = renderMarkdown;
