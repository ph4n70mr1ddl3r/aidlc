const db = require('../models/database');
const { requireAuth, requireAdminOrManager } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { paginate, paginationBaseUrl, addSearch, buildFilters, safeId, trim, countQuery, selectQuery, isPrivileged, parseBooleanFlag, safeQueryValue, safeFilters, escapeHtml, rejectHppArrays } = require('../utils');
const { KB_CATEGORIES: VALID_CATEGORIES, KB_STATUSES: VALID_STATUSES, MAX_MEDIUM_STR, MAX_CONTENT, MAX_LONG_STR } = require('../constants');
const { invalidateDashboardCache } = require('./dashboard');
// The package.json pins ^15.0.7 (marked v15 is the last CJS-compatible major).
// If loading fails, fall back to a static mock that logs a warning.
let marked;
let markedFallback = false;
try {
  marked = require('marked');
} catch (err) {
  console.error(`ERROR: marked package failed to load: ${err.message}. Run \`npm install\` to ensure marked >=12 <16 is installed (CJS compatible).`);
  console.error('Falling back to plain-text rendering for knowledge articles.');
  marked = { parse: (content) => content };
  markedFallback = true;
}
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
  // Non-privileged users must not promote status (e.g. draft -> published).
  // When editing an existing article, they may keep the existing status or
  // demote to draft (unpublish). When creating a new article (existingStatus
  // is null), force draft regardless of what status was submitted.
  if (!existingStatus) {
    return 'draft';
  }
  if (status !== existingStatus && status !== 'draft') {
    return existingStatus;
  }
  return status || 'draft';
}

function resolveSafeFeatured(user, is_featured, existingFeatured = 0) {
  if (!isPrivileged(user)) {
    return existingFeatured;
  }
  // When the is_featured field is absent from the request (unchecked checkbox,
  // which browsers omit entirely), preserve the existing value to prevent
  // an edit from silently un-featuring the article. Checkboxes with a hidden
  // `value="0"` field send `0` when unchecked, which is handled below.
  if (is_featured === undefined || is_featured === '') {
    return existingFeatured;
  }
  // Only the canonical "checked" values set the flag. A browser only sends a
  // value when the checkbox is checked; unchecked sends nothing (handled above)
  // or a hidden "0". parseBooleanFlag rejects any other string (e.g. 'false',
  // 'off', 'no') so an API/HTML form with a custom value cannot silently mark
  // an article featured — and it gates on privilege (non-privileged returns 0).
  return parseBooleanFlag(is_featured, isPrivileged(user));
}

// Markdown options are inlined per-call in renderMarkdown to avoid
// mutating a shared object (even though marked does not currently
// mutate the options argument, being defensive costs nothing).

const SANITIZE_HTML_OPTIONS = {
  // NOTE: 'input' is intentionally NOT allowed. A published KB article that
  // renders interactive form controls is a stored HTML/UI-injection vector
  // (e.g. a hidden checkbox or file-input appearing in an article body).
  allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'details', 'summary', 'del']),
  allowedAttributes: {
    ...sanitizeHtml.defaults.allowedAttributes,
    img: ['src', 'alt', 'title'],
    a: ['href', 'name', 'rel', 'title'],
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
    // marked v15 .parse() is synchronous unless async extensions are registered
    // (none here), so it returns a string.  Guard against async extensions by
    // rejecting thenables — otherwise sanitizeHtml would receive a Promise
    // and render "[object Promise]" in the template.
    const html = marked.parse(content, { breaks: true, gfm: true });
    if (html?.then) {
      throw new Error('marked.parse returned a Promise (async extension detected) — fall back to plain text');
    }
    return sanitizeHtml(html, SANITIZE_HTML_OPTIONS);
  } catch (err) {
    console.error('Markdown render error:', err.message);
    try {
      const text = sanitizeHtml(content, STRIP_HTML_OPTIONS);
      return `<div class="alert alert-info">Article content could not be rendered. Showing plain text:</div><pre>${escapeHtml(text)}</pre>`;
    } catch (innerErr) {
      console.error('Secondary sanitize error:', innerErr.message);
      return '<div class="alert alert-info">Article content could not be rendered.</div>';
    }
  }
}

// List articles (paginated)
router.get('/', (req, res) => {
  const { page, limit, offset } = paginate(req);

  const qCategory = safeQueryValue(req.query.category);
  const qStatus = safeQueryValue(req.query.status);
  const filters = buildFilters({
    'k.category': { value: VALID_CATEGORIES.includes(qCategory) ? qCategory : '' },
    'k.status': { value: VALID_STATUSES.includes(qStatus) ? qStatus : '' }
  }, ['k.category', 'k.status']);

  const where = [...filters.where];
  const params = [...filters.params];
  addSearch(where, params, safeQueryValue(req.query.search), ['k.title', 'k.content', 'k.tags']);

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
    title: 'Knowledge Base', articles,
    filters: safeFilters(req.query, ['search', 'category', 'status']),
    page, limit, totalPages, total,
    baseUrl: paginationBaseUrl(req)
  });
});

// New article
router.get('/new', (req, res) => {
  res.render('pages/knowledge/form', { title: 'New Article', article: {}, isEdit: false });
});

// Create article
router.post('/', kbWriteLimiter, (req, res) => {
  // Fail closed on HTTP parameter pollution: reject array payloads.
  const hppErrors = rejectHppArrays(req, ['title', 'content', 'category', 'tags', 'status', 'is_featured']);
  if (hppErrors.length > 0) {
    req.flash('error', 'Invalid request parameters');
    return res.redirect('/knowledge/new');
  }

  const title = trim(safeQueryValue(req.body.title));
  const content = trim(safeQueryValue(req.body.content));
  const category = trim(safeQueryValue(req.body.category));
  const tags = trim(safeQueryValue(req.body.tags));
  const status = trim(safeQueryValue(req.body.status));
  const is_featured = safeQueryValue(req.body.is_featured);

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

  // Sanitize tags, title, and content for defense-in-depth (templates escape with <%=, but strip HTML at input too)
  let safeTags = null;
  let safeTitle = '';
  let safeContent = '';
  try {
    // Sanitize first, then truncate. Truncating before sanitizing would let a
    // value sitting exactly at the limit grow past it once sanitizeHtml escapes
    // characters (e.g. "&" -> "&amp;"), producing over-length stored data.
    safeTags = sanitizeHtml(tags || '', STRIP_HTML_OPTIONS);
    safeTitle = sanitizeHtml(title, STRIP_HTML_OPTIONS).substring(0, MAX_MEDIUM_STR);
    safeContent = sanitizeHtml(content, STRIP_HTML_OPTIONS).substring(0, MAX_CONTENT);
    if (safeTags) {
      safeTags = safeTags.substring(0, MAX_LONG_STR) || null;
    }
  } catch (sanitizeErr) {
    console.error('HTML sanitization error:', sanitizeErr.message);
    req.flash('error', 'Error processing input. Please try again.');
    return res.redirect('/knowledge/new');
  }
  if (!safeTitle) {
    req.flash('error', 'Title is required after removing invalid content');
    return res.redirect('/knowledge/new');
  }
  if (!safeContent) {
    req.flash('error', 'Content is required after removing invalid content');
    return res.redirect('/knowledge/new');
  }

  try {
    // Resolve safeStatus/safeFeatured inside a transaction to avoid a TOCTOU
    // race where the user's role is changed between the resolution and the INSERT
    // (mirrors the update route pattern where these are resolved inside the txn).
    const createArticle = db.transaction(() => {
      const txnSafeStatus = resolveSafeStatus(req.session.user, status || 'draft', null);
      const txnSafeFeatured = resolveSafeFeatured(req.session.user, is_featured);
      return _articleInsertStmt.run(safeTitle, safeContent, category, safeTags, req.session.user.id, txnSafeStatus, txnSafeFeatured);
    });
    const result = createArticle();

    req.audit('create', 'knowledge_article', result.lastInsertRowid, `Created article "${safeTitle}"`);
    req.flash('success', 'Article created');
    invalidateDashboardCache();
    res.redirect(`/knowledge/${result.lastInsertRowid}`);
  } catch (err) {
    console.error('Article create error:', err.message);
    req.flash('error', 'Error creating article. Please try again.');
    return res.redirect('/knowledge/new');
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
      if (typeof req.audit === 'function') {
        req.audit('access_denied', 'knowledge_article', id, 'Unauthorized view of non-published article');
      }
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
    // Prepend the new article and cap the tracking set by evicting the oldest
    // entry. Use concat (non-mutating) instead of push so that the reassignment
    // below triggers the session.modified flag — resave:false won't persist
    // in-place array mutations against the same reference.
    req.session[VIEWED_KEY] = viewed.concat(id).slice(-MAX_VIEWED_ARTICLES);
  }

  article.renderedContent = renderMarkdown(article.content);

  res.render('pages/knowledge/show', { title: article.title, article, markedFallback });
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
    if (typeof req.audit === 'function') {
      req.audit('access_denied', 'knowledge_article', id, 'Unauthorized edit attempt on article');
    }
    req.flash('error', 'You can only edit your own articles');
    return res.redirect(`/knowledge/${id}`);
  }

  res.render('pages/knowledge/form', { title: 'Edit Article', article, isEdit: true });
});

// Update article (author or admin/manager only)
router.put('/:id', requireAdminOrManager, kbWriteLimiter, (req, res) => {
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

  // Fail closed on HTTP parameter pollution: reject array payloads.
  const hppErrors = rejectHppArrays(req, ['title', 'content', 'category', 'tags', 'status', 'is_featured']);
  if (hppErrors.length > 0) {
    req.flash('error', 'Invalid request parameters');
    return res.redirect(`/knowledge/${id}/edit`);
  }

  const title = trim(safeQueryValue(req.body.title));
  const content = trim(safeQueryValue(req.body.content));
  const category = trim(safeQueryValue(req.body.category));
  const tags = trim(safeQueryValue(req.body.tags));
  const status = trim(safeQueryValue(req.body.status));
  const is_featured = safeQueryValue(req.body.is_featured);

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

  // resolveSafeFeatured / safeStatus are now computed inside the transaction
  // from the rechecked row to avoid a TOCTOU where a concurrent admin action
  // (e.g. promoting is_featured or changing status) is silently overwritten.
  // The outer existing.is_featured / existing.status are only used for the
  // authorisation guard above and the date-helpers inside the transaction.

  // Sanitize tags, title, and content for defense-in-depth (templates escape with <%=, but strip HTML at input too)
  let safeTags = null;
  let safeTitle = '';
  let safeContent = '';
  try {
    // Sanitize first, then truncate. Truncating before sanitizing would let a
    // value sitting exactly at the limit grow past it once sanitizeHtml escapes
    // characters (e.g. "&" -> "&amp;"), producing over-length stored data.
    safeTags = sanitizeHtml(tags || '', STRIP_HTML_OPTIONS);
    safeTitle = sanitizeHtml(title, STRIP_HTML_OPTIONS).substring(0, MAX_MEDIUM_STR);
    safeContent = sanitizeHtml(content, STRIP_HTML_OPTIONS).substring(0, MAX_CONTENT);
    if (safeTags) {
      safeTags = safeTags.substring(0, MAX_LONG_STR) || null;
    }
  } catch (sanitizeErr) {
    console.error('HTML sanitization error:', sanitizeErr.message);
    req.flash('error', 'Error processing input. Please try again.');
    return res.redirect(`/knowledge/${id}/edit`);
  }
  if (!safeTitle) {
    req.flash('error', 'Title is required after removing invalid content');
    return res.redirect(`/knowledge/${id}/edit`);
  }
  if (!safeContent) {
    req.flash('error', 'Content is required after removing invalid content');
    return res.redirect(`/knowledge/${id}/edit`);
  }

  try {
    // Verify the article still exists, recheck authorization, and update in a
    // single transaction to avoid TOCTOU races: the article could be deleted or
    // the user's role changed between the outer checks and the UPDATE.
    // Rechecking authorization inside the transaction prevents a concurrent
    // role change from bypassing the edit restriction.
    const updateArticle = db.transaction(() => {
      const recheck = _editArticleStmt.get(id);
      if (!recheck) {
        throw new Error('NOT_FOUND');
      }
      // Recheck authorization inside the transaction so a concurrent role
      // change between the outer check and the UPDATE cannot bypass it.
      const txnIsOwner = recheck.author_id === req.session.user.id;
      if (!txnIsOwner && !isPrivileged(req.session.user)) {
        throw new Error('ACCESS_DENIED');
      }
      const txnSafeStatus = resolveSafeStatus(req.session.user, status || recheck.status, recheck.status);
      const txnSafeFeatured = resolveSafeFeatured(req.session.user, is_featured, recheck.is_featured);
      const result = _articleUpdateStmt.run(safeTitle, safeContent, category, safeTags, txnSafeStatus, txnSafeFeatured, id);
      if (result.changes === 0) {
        throw new Error('NOT_FOUND');
      }
    });
    updateArticle();

    req.audit('update', 'knowledge_article', id, `Updated article "${safeTitle}"`);
    req.flash('success', 'Article updated');
    invalidateDashboardCache();
    res.redirect(`/knowledge/${id}`);
  } catch (err) {
    if (err.message === 'NOT_FOUND') {
      req.flash('error', 'Article not found');
      return res.redirect('/knowledge');
    }
    if (err.message === 'ACCESS_DENIED') {
      req.flash('error', 'You can only edit your own articles');
      return res.redirect(`/knowledge/${id}`);
    }
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

  // Authorization: allow author (matching edit behavior) or admin/manager
  const existing = _editArticleStmt.get(id);
  if (!existing) {
    req.flash('error', 'Article not found');
    return res.redirect('/knowledge');
  }
  const isOwner = existing.author_id === req.session.user.id;
  if (!isOwner && !isPrivileged(req.session.user)) {
    req.flash('error', 'You can only delete your own articles');
    return res.redirect('/knowledge');
  }

  try {
    // Verify the article still exists, recheck authorization, and delete in a
    // single transaction to avoid TOCTOU races: the article could be deleted or
    // the user's role / article authorship changed between the existence/auth
    // checks and the DELETE (mirrors the article update transaction pattern).
    const deleteArticle = db.transaction(() => {
      const recheck = _editArticleStmt.get(id);
      if (!recheck) {
        return { notFound: true, title: null };
      }
      // Recheck authorization inside the transaction so a concurrent role
      // change between the outer check and the DELETE cannot bypass it.
      const txnIsOwner = recheck.author_id === req.session.user.id;
      if (!txnIsOwner && !isPrivileged(req.session.user)) {
        throw new Error('ACCESS_DENIED');
      }
      const result = _deleteArticleStmt.run(id);
      return { notFound: false, changes: result.changes, title: recheck.title };
    });
    const deleteResult = deleteArticle();
    if (deleteResult.notFound) {
      req.flash('error', 'Article not found');
    } else {
      req.audit('delete', 'knowledge_article', id, `Deleted article "${deleteResult.title}"`);
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
module.exports.resolveSafeFeatured = resolveSafeFeatured;
module.exports.resolveSafeStatus = resolveSafeStatus;
module.exports.markedFallback = markedFallback;
