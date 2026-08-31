const db = require('../models/database');
const { requireAuth } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { paginate, paginationBaseUrl, addSearch, buildFilters, safeId, trim, countQuery, selectQuery, isPrivileged, parseBooleanFlag, safeQueryValue, safeFilters, escapeHtml, rejectHppArrays, authKeyGenerator } = require('../utils');
const { KB_CATEGORIES: VALID_CATEGORIES, KB_STATUSES: VALID_STATUSES, MAX_MEDIUM_STR, MAX_CONTENT, MAX_LONG_STR } = require('../constants');
const { invalidateDashboardCache } = require('./dashboard');
// The package.json pins ^15.0.7 (marked v15 is the last CJS-compatible major).
// If loading fails, fall back to a static mock that logs a warning.
let marked;
let markedFallback = false;
try {
  marked = require('marked');
} catch (err) {
  console.error(`ERROR: marked package failed to load: ${err.message}. Run \`npm install\` to ensure marked ^15.0.7 is installed (CJS compatible).`);
  console.error('Falling back to plain-text rendering for knowledge articles.');
  marked = { parse: (content) => content };
  markedFallback = true;
}
const sanitizeHtml = (() => {
  try {
    const mod = require('sanitize-html');
    // sanitize-html 2.x exports the function as the default; some versions
    // also attach it as .default. Handle both shapes.
    return typeof mod === 'function'
      ? mod
      : (mod && typeof mod.default === 'function'
        ? mod.default
        : (() => {
          throw new Error('unexpected sanitize-html shape');
        })());
  } catch (err) {
    console.error(`ERROR: sanitize-html package failed to load: ${err.message}. Run \`npm install\` to ensure sanitize-html 2.17.5 is installed.`);
    // Fail closed: escape all HTML instead of passing it through unsanitized
    // (a no-op fallback would turn renderMarkdown into a stored-XSS surface).
    // Mirrors the marked fallback above, which degrades to plain text.
    console.error('Falling back to escaped (plain-text) HTML sanitization for knowledge articles.');
    const escape = (html) => escapeHtml(String(html ?? ''));
    const noop = escape;
    noop.defaults = { allowedTags: [], allowedAttributes: {} };
    noop.simpleTransform = () => (tagName, attribs) => attribs;
    return noop;
  }
})();
const rateLimit = require('express-rate-limit');

// Key rate-limiting by authenticated user id (per-account, shared utils helper)
// so one user's requests cannot silence everyone behind the same NAT'd office
// IP. The normalized-IP fallback exists for defense in depth.

// Rate limit knowledge article creation/update — markdown parsing + sanitization
// is CPU-intensive and could be abused for server-side DoS even by authenticated users.
const kbWriteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 30,
  keyGenerator: authKeyGenerator,
  message: 'Too many article submissions. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});

// Rate limit article reads (show/edit) to prevent rapid enumeration or
// resource exhaustion from repeated markdown parsing + sanitization on each view.
// Non-privileged users can only see published articles (filtered in-query),
// but privileged users can see drafts/archived too — this limiter protects
// against an admin/manager hammering the show/edit endpoints with many IDs.
const kbReadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  keyGenerator: authKeyGenerator,
  message: 'Too many article requests. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});

const router = require('express').Router();
router.use(requireAuth, auditMiddleware);

// Cached prepared statements for show/edit routes (static SQL).
const _showArticleStmt = db.prepare(`
    SELECT k.id, k.title, k.content, k.category, k.tags, k.author_id, k.status, k.views, k.is_featured, k.created_at, k.updated_at,
      u.first_name || ' ' || u.last_name as author_name
    FROM knowledge_articles k
    LEFT JOIN users u ON k.author_id = u.id
    WHERE k.id = ?
  `);
const _editArticleStmt = db.prepare('SELECT id, title, content, category, tags, author_id, status, views, is_featured, created_at, updated_at FROM knowledge_articles WHERE id = ?');
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
  // When the is_featured field is absent from the request (partial API update
  // that omits the field), preserve the existing value.
  if (is_featured === undefined || is_featured === '') {
    return existingFeatured;
  }
  // The edit form pairs the checkbox (value="1") with a hidden value="0"
  // companion, so a submission arrives as either '0' (unchecked, single value)
  // or ['0','1'] (checked, parsed by querystring as an array). In both cases
  // the last element encodes the checkbox state, so arrays are resolved by
  // taking the final element rather than safeQueryValue's first-element rule.
  // Only the canonical "checked" values set the flag; parseBooleanFlag rejects
  // any other string (e.g. 'false', 'off', 'no') so an API/HTML form with a
  // custom value cannot silently mark an article featured. The privilege gate
  // is already enforced by the early return above, so `true` is passed here
  // directly — calling isPrivileged again would be redundant.
  const lastValue = Array.isArray(is_featured) ? is_featured[is_featured.length - 1] : is_featured;
  return parseBooleanFlag(lastValue, true);
}

// Markdown options are inlined per-call in renderMarkdown to avoid
// mutating a shared object (even though marked does not currently
// mutate the options argument, being defensive costs nothing).

// Helper: recursively freeze an object so nested arrays/objects cannot be
// mutated at runtime. sanitize-html reads these options on every call, so a
// mutation from a future library change or unexpected code path would silently
// relax the allowlist. Object.freeze alone only freezes the top level.
// A `seen` Set prevents infinite recursion on circular references.
function deepFreeze(obj) {
  const seen = new WeakSet();
  function freeze(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (seen.has(value)) {
        return Object.freeze(value);
      }
      seen.add(value);
      for (const val of Object.values(value)) {
        if (val && typeof val === 'object') {
          freeze(val);
        }
      }
    } else if (Array.isArray(value)) {
      if (seen.has(value)) {
        return Object.freeze(value);
      }
      seen.add(value);
      for (const item of value) {
        if (item && typeof item === 'object') {
          freeze(item);
        }
      }
    }
    return Object.freeze(value);
  }
  return freeze(obj);
}

const SANITIZE_HTML_OPTIONS = deepFreeze({
  // NOTE: 'input' is intentionally NOT allowed. A published KB article that
  // renders interactive form controls is a stored HTML/UI-injection vector
  // (e.g. a hidden checkbox or file-input appearing in an article body).
  allowedTags: (sanitizeHtml.defaults?.allowedTags || []).concat(['img', 'details', 'summary', 'del']),
  allowedAttributes: {
    ...((sanitizeHtml.defaults?.allowedAttributes) || {}),
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
});

const STRIP_HTML_OPTIONS = deepFreeze({
  allowedTags: [],
  allowedAttributes: {},
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesAppliedToAttributes: ['href', 'src']
});

function renderMarkdown(content) {
  if (!content || typeof content !== 'string') {
    return '';
  }
  try {
    // marked v15 .parse() is synchronous unless async extensions are registered
    // (none here), so it returns a string.  Guard against async extensions by
    // rejecting thenables — otherwise sanitizeHtml would receive a Promise
    // and render "[object Promise]" in the template. Also guard against
    // undefined/null return for empty content.
    const html = marked.parse(content, { breaks: true, gfm: true });
    if (html && html.then) {
      throw new Error('marked.parse returned a Promise (async extension detected) — fall back to plain text');
    }
    if (!html || typeof html !== 'string') {
      return '';
    }
    return sanitizeHtml(html, SANITIZE_HTML_OPTIONS);
  } catch (err) {
    console.error('Markdown render error:', err.message);
    try {
      return `<div>Article content could not be rendered. Showing plain text:</div><pre>${escapeHtml(content || '')}</pre>`;
    } catch (innerErr) {
      console.error('Secondary escape error:', innerErr.message);
      return '<div>Article content could not be rendered.</div>';
    }
  }
}

/**
 * Sanitize knowledge article input by stripping HTML and truncating to max lengths.
 * Returns { safeTitle, safeContent, safeTags, error }. Title/content empty strings
 * are preserved (surfaced as errors since the fields are required); empty tags
 * (optional) are normalized to null.
 * @param {string} title
 * @param {string} content
 * @param {string} tags
 * @returns {{ safeTitle: string, safeContent: string, safeTags: string|null, error: string|null }}
 */
function sanitizeKnowledgeInput(title, content, tags) {
  let safeTags;
  let safeTitle;
  let safeContent;
  try {
    // Sanitize first, then truncate. Truncating before sanitizing would let a
    // value sitting exactly at the limit grow past it once sanitizeHtml escapes
    // characters (e.g. "&" -> "&amp;"), producing over-length stored data.
    safeTags = sanitizeHtml(tags || '', STRIP_HTML_OPTIONS);
    safeTitle = sanitizeHtml(title, STRIP_HTML_OPTIONS).substring(0, MAX_MEDIUM_STR);
    safeContent = sanitizeHtml(content, STRIP_HTML_OPTIONS).substring(0, MAX_CONTENT);
    // Normalize empty tags to null (the column is nullable and a NULL is
    // cleaner than a stored '' — searches and template rendering treat them
    // identically, so this only affects what is written to the DB).
    safeTags = safeTags ? safeTags.substring(0, MAX_LONG_STR) : null;
  } catch (sanitizeErr) {
    return { safeTitle: '', safeContent: '', safeTags: null, error: sanitizeErr.message };
  }
  return { safeTitle, safeContent, safeTags, error: null };
}

// List articles (paginated)
router.get('/', kbReadLimiter, (req, res) => {
  const { page: requestedPage, limit } = paginate(req);

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
  // Clamp the requested page to the actual page count so a page beyond the
  // last one (e.g. ?page=999) renders the final page instead of an empty list
  // with a broken "Showing N–M" range (M < N) in the pagination partial.
  const page = Math.min(requestedPage, totalPages);
  const offset = (page - 1) * limit;

  const articles = selectQuery(db, `
    SELECT k.id, k.title, k.status, k.category, k.tags, k.author_id, k.views, k.is_featured, k.updated_at,
      u.first_name || ' ' || u.last_name as author_name
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
  // Fail closed on HTTP parameter pollution: reject array payloads. is_featured
  // is intentionally excluded — a checked checkbox paired with its hidden
  // value="0" companion submits is_featured=0&is_featured=1, which the parser
  // turns into an array; resolveSafeFeatured resolves the last element.
  const hppErrors = rejectHppArrays(req, ['title', 'content', 'category', 'tags', 'status']);
  if (hppErrors.length > 0) {
    req.flash('error', 'Invalid request parameters');
    return res.redirect('/knowledge/new');
  }

  const title = trim(safeQueryValue(req.body.title));
  const content = trim(safeQueryValue(req.body.content));
  const category = trim(safeQueryValue(req.body.category));
  const tags = trim(safeQueryValue(req.body.tags));
  const status = trim(safeQueryValue(req.body.status));
  const is_featured = req.body.is_featured;

  // Fail closed on a present-but-non-string tags/status value (e.g. a JSON
  // number or object): trim() coerces it to '', which would silently wipe or
  // default the stored value — for tags that means NULLing the stored tags on
  // update, for status it means silently falling back to the default. Absent/
  // empty submissions are allowed and preserve the stored value.
  for (const field of ['tags', 'status']) {
    const v = req.body[field];
    if (v !== undefined && v !== null && v !== '' && typeof v !== 'string') {
      req.flash('error', 'Invalid request parameters');
      return res.redirect('/knowledge/new');
    }
  }

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
  const sanitized = sanitizeKnowledgeInput(title, content, tags);
  if (sanitized.error) {
    console.error('HTML sanitization error:', sanitized.error);
    req.flash('error', 'Error processing input. Please try again.');
    return res.redirect('/knowledge/new');
  }
  const { safeTags, safeTitle, safeContent } = sanitized;
  if (!safeTitle) {
    req.flash('error', 'Title is required after removing invalid content');
    return res.redirect('/knowledge/new');
  }
  if (!safeContent) {
    req.flash('error', 'Content is required after removing invalid content');
    return res.redirect('/knowledge/new');
  }

  try {
    // Co-locate safeStatus/safeFeatured resolution with the INSERT in a single
    // transaction. Note: this does NOT protect against a concurrent ROLE change
    // — the role is read from req.session.user, a request-lifetime snapshot
    // that a transaction boundary cannot re-check (requireAuth re-syncs it once
    // per request at the very start). The transaction merely keeps the resolved
    // values and the INSERT atomic; role TOCTOU is accepted because a demotion
    // takes effect on the user's next request.
    const createArticle = db.transaction(() => {
      const txnSafeStatus = resolveSafeStatus(req.session.user, status || 'draft', null);
      const txnSafeFeatured = resolveSafeFeatured(req.session.user, is_featured);
      return _articleInsertStmt.run(safeTitle, safeContent, category, safeTags, req.session.user.id, txnSafeStatus, txnSafeFeatured);
    });
    const result = createArticle();

    req.audit('create', 'knowledge_article', result.lastInsertRowid, `Created article "${safeTitle}"`);
    req.flash('success', 'Article created.');
    invalidateDashboardCache();
    return res.redirect(`/knowledge/${result.lastInsertRowid}`);
  } catch (err) {
    console.error('Article create error:', err.message);
    req.flash('error', 'Error creating article. Please try again.');
    return res.redirect('/knowledge/new');
  }
});

// Show article
router.get('/:id', kbReadLimiter, (req, res) => {
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
    const isOwner = Number(article.author_id) === Number(req.session.user.id);
    if (!isOwner && !isPrivileged(req.session.user)) {
      req.audit('access_denied', 'knowledge_article', id, 'Unauthorized view of non-published article');
      req.flash('error', 'Article not found');
      return res.redirect('/knowledge');
    }
  }

  req.audit('read', 'knowledge_article', id, `Viewed article: ${article.title}`);

  // Increment views only once per session per article to prevent refresh inflation.
  // Cap the tracked set to prevent unbounded session growth.
  // Use an array (not an object) so eviction removes the oldest-viewed article —
  // Object.keys() on integer-like keys returns numeric order, which would evict
  // the lowest-ID article instead of the oldest viewed.
  if (!req.session[VIEWED_KEY]) {
    req.session[VIEWED_KEY] = [];
  }
  const viewed = req.session[VIEWED_KEY];
  if (!viewed.includes(id) && Number(article.author_id) !== Number(req.session.user.id)) {
    try {
      _viewCountStmt.run(id);
    } catch (err) {
      console.error('View count update error:', err.message);
    }
    // Append the new article id and cap the tracking set with slice(-MAX),
    // which evicts the OLDEST-viewed entry from the front. Use concat
    // (non-mutating) instead of push so that the reassignment below triggers
    // the session.modified flag — resave:false won't persist in-place array
    // mutations against the same reference.
    req.session[VIEWED_KEY] = viewed.concat(id).slice(-MAX_VIEWED_ARTICLES);
  }

  // Shallow-copy the article before adding renderedContent so the original
  // DB query result object is never mutated in place (a mutated row could leak
  // across requests if better-sqlite3 ever caches result objects). Mirrors the
  // safeAsset / safeTicket shallow-copy patterns used throughout the codebase.
  const safeArticle = { ...article };
  safeArticle.renderedContent = renderMarkdown(article.content);
  res.render('pages/knowledge/show', { title: article.title, article: safeArticle, markedFallback });
});

// Edit article (author or admin/manager only)
router.get('/:id/edit', kbReadLimiter, (req, res) => {
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

  const isOwner = Number(article.author_id) === Number(req.session.user.id);
  if (!isOwner && !isPrivileged(req.session.user)) {
    req.audit('access_denied', 'knowledge_article', id, 'Unauthorized edit attempt on article');
    req.flash('error', 'You do not have permission to edit this article.');
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

  // Fail closed on HTTP parameter pollution: reject array payloads. is_featured
  // is intentionally excluded — see the POST handler for why (hidden value="0"
  // + checkbox submit an array when checked; resolveSafeFeatured takes the
  // last element).
  const hppErrors = rejectHppArrays(req, ['title', 'content', 'category', 'tags', 'status']);
  if (hppErrors.length > 0) {
    req.flash('error', 'Invalid request parameters');
    return res.redirect(`/knowledge/${id}/edit`);
  }

  // Authorization check
  const existing = _editArticleStmt.get(id);
  if (!existing) {
    req.flash('error', 'Article not found');
    return res.redirect('/knowledge');
  }
  const isOwner = Number(existing.author_id) === Number(req.session.user.id);
  if (!isOwner && !isPrivileged(req.session.user)) {
    req.audit('access_denied', 'knowledge_article', id, 'Unauthorized edit attempt on article');
    req.flash('error', 'You do not have permission to edit this article.');
    return res.redirect(`/knowledge/${id}`);
  }

  const title = trim(safeQueryValue(req.body.title));
  const content = trim(safeQueryValue(req.body.content));
  const category = trim(safeQueryValue(req.body.category));
  const tags = trim(safeQueryValue(req.body.tags));
  const status = trim(safeQueryValue(req.body.status));
  const is_featured = req.body.is_featured;

  // Fail closed on a present-but-non-string tags/status value (e.g. a JSON
  // number or object): trim() coerces it to '', which would silently wipe the
  // stored tags or preserve status with no feedback — inconsistent with the
  // fail-closed convention applied to every other present-but-invalid field on
  // this route. Absent/empty submissions are allowed (tags clears / status
  // falls back to the stored value).
  for (const field of ['tags', 'status']) {
    const v = req.body[field];
    if (v !== undefined && v !== null && v !== '' && typeof v !== 'string') {
      req.flash('error', 'Invalid request parameters');
      return res.redirect(`/knowledge/${id}/edit`);
    }
  }

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

  // resolveSafeFeatured / resolveSafeStatus are computed inside the transaction
  // from the rechecked row to avoid a TOCTOU where a concurrent admin action
  // (e.g. promoting is_featured or changing status) is silently overwritten.
  // The outer existing.is_featured / existing.status are only used for the
  // authorisation guard above and the resolution helpers inside the transaction.

  // Sanitize tags, title, and content for defense-in-depth (templates escape with <%=, but strip HTML at input too)
  const sanitized = sanitizeKnowledgeInput(title, content, tags);
  if (sanitized.error) {
    console.error('HTML sanitization error:', sanitized.error);
    req.flash('error', 'Error processing input. Please try again.');
    return res.redirect(`/knowledge/${id}/edit`);
  }
  const { safeTags, safeTitle, safeContent } = sanitized;
  if (!safeTitle) {
    req.flash('error', 'Title is required after removing invalid content');
    return res.redirect(`/knowledge/${id}/edit`);
  }
  if (!safeContent) {
    req.flash('error', 'Content is required after removing invalid content');
    return res.redirect(`/knowledge/${id}/edit`);
  }

  try {
    // Verify the article still exists and recheck authorization in a single
    // transaction to avoid TOCTOU races on the ARTICLE row: it could be deleted
    // (or its status/is_featured flags changed — consumed below from the
    // rechecked row) between the outer checks and the UPDATE. Note: the
    // authorization recheck reads the author id from the rechecked row but the
    // ROLE from req.session.user, a request-lifetime snapshot — a concurrent
    // role change cannot be detected inside this transaction; it takes effect
    // on the user's next request. What the recheck does close is the window
    // where the article's ownership changed between the outer check and the
    // UPDATE.
    const updateArticle = db.transaction(() => {
      const recheck = _editArticleStmt.get(id);
      if (!recheck) {
        throw new Error('NOT_FOUND');
      }
      // Recheck ownership inside the transaction against the re-fetched row so
      // a concurrent ownership/author change between the outer check and the
      // UPDATE cannot bypass the edit restriction.
      const txnIsOwner = Number(recheck.author_id) === Number(req.session.user.id);
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
    req.flash('success', 'Article updated.');
    invalidateDashboardCache();
    return res.redirect(`/knowledge/${id}`);
  } catch (err) {
    if (err.message === 'NOT_FOUND') {
      req.flash('error', 'Article not found');
      return res.redirect('/knowledge');
    }
    if (err.message === 'ACCESS_DENIED') {
      req.audit('access_denied', 'knowledge_article', id, 'Unauthorized edit attempt on article (concurrent ownership change)');
      req.flash('error', 'You do not have permission to edit this article.');
      return res.redirect(`/knowledge/${id}`);
    }
    console.error('Article update error:', err.message);
    req.flash('error', 'Error updating article. Please try again.');
    return res.redirect(`/knowledge/${id}/edit`);
  }
});

// Delete article
router.delete('/:id', kbWriteLimiter, (req, res) => {
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
  const isOwner = Number(existing.author_id) === Number(req.session.user.id);
  if (!isOwner && !isPrivileged(req.session.user)) {
    req.audit('access_denied', 'knowledge_article', id, 'Unauthorized delete attempt on article');
    req.flash('error', 'You do not have permission to delete this article.');
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
      const txnIsOwner = Number(recheck.author_id) === Number(req.session.user.id);
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
      req.flash('success', 'Article deleted.');
      invalidateDashboardCache();
    }
  } catch (err) {
    if (err.message === 'ACCESS_DENIED') {
      req.audit('access_denied', 'knowledge_article', id, 'Unauthorized delete attempt on article (concurrent ownership change)');
      req.flash('error', 'You do not have permission to delete this article.');
    } else {
      console.error('Article delete error:', err.message);
      req.flash('error', 'Error deleting article.');
    }
  }
  return res.redirect('/knowledge');
});

/**
 * Reset module-level cached prepared statements (test use only).
 * Ensures test isolation when using mock db instances — consistent with
 * the same-named export in all other route modules and in utils.js /
 * middleware/auth.js / middleware/audit.js.
 */
function resetCachedStatements() {
  // All cached statements are module-level const bindings from db.prepare(),
  // so there is no lazy-init to null out — the cache is unused when
  // the db mock is swapped. This function exists for API consistency
  // across all route modules.
}

module.exports = router;
// Exposed for unit testing (the route module is mocked in app.test.js).
module.exports.renderMarkdown = renderMarkdown;
module.exports.resolveSafeFeatured = resolveSafeFeatured;
module.exports.resolveSafeStatus = resolveSafeStatus;
module.exports.markedFallback = markedFallback;
module.exports.sanitizeKnowledgeInput = sanitizeKnowledgeInput;
module.exports.resetCachedStatements = resetCachedStatements;
