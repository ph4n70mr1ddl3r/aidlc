const db = require('../models/database');
const { requireAuth } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { paginate, paginationBaseUrl, addSearch, buildFilters, safeId, trim, countQuery, selectQuery, isPrivileged, parseBooleanFlag, safeQueryValue, safeFilters, escapeHtml, decodeHtmlEntities, rejectHppArrays, authKeyGenerator, logError, resolveOptionalField, resolveEnumField } = require('../utils');
const { KB_CATEGORIES: VALID_CATEGORIES, KB_STATUSES: VALID_STATUSES, MAX_MEDIUM_STR, MAX_CONTENT, MAX_LONG_STR } = require('../constants');
const { invalidateDashboardCache } = require('./dashboard');
// The package.json pins ^15.0.7 (marked v15 is the last CJS-compatible major).
// If loading fails, fall back to a static mock that logs a warning.
let marked;
let markedFallback = false;
try {
  marked = require('marked');
} catch (err) {
  console.error(`ERROR: marked package failed to load: ${(err && err.message) || String(err)}. Run \`npm install\` to ensure marked ^15.0.7 is installed (CJS compatible).`);
  console.error('Falling back to plain-text rendering for knowledge articles.');
  marked = { parse: (content) => content };
  markedFallback = true;
}
const sanitizeHtml = (() => {
  // NOTE: load errors (package missing/broken) and shape errors (module loaded
  // but is not the expected sanitizer function) must be distinguished — the IIFE
  // throw form previously caught BOTH, so a shape error silently fell back to
  // the identity function (pass-through), turning renderMarkdown into a
  // stored-XSS surface. The shape check therefore uses a plain if/throw so a
  // shape error propagates (crashing at startup is the fail-closed behavior),
  // while a load error still degrades to the escaped plain-text fallback.
  let loaded;
  try {
    loaded = require('sanitize-html');
  } catch (err) {
    console.error(`ERROR: sanitize-html package failed to load: ${(err && err.message) || String(err)}. Run \`npm install\` to ensure sanitize-html ^2.18.1 is installed.`);
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
  // sanitize-html 2.x exports the function as the default; some versions
  // also attach it as .default. Handle both shapes.
  if (typeof loaded === 'function') {
    return loaded;
  }
  if (loaded && typeof loaded.default === 'function') {
    return loaded.default;
  }
  // A loaded-but-unexpected shape cannot be verified as a sanitizer — fail
  // closed by crashing at startup rather than trusting an unknown object.
  console.error(`ERROR: sanitize-html loaded but has an unexpected shape: ${Object.keys(loaded).join(', ')}. Run \`npm install\` to ensure sanitize-html ^2.18.1 is installed.`);
  throw new Error('unexpected sanitize-html shape');
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
  // that omits the field), preserve the existing value. Null is treated as
  // absent too (mirrors tags absent-preserve and resolveOptionalField).
  if (is_featured === undefined || is_featured === null || is_featured === '') {
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

// Canonical values the is_featured checkbox may carry. The edit form pairs a
// hidden value="0" with a value="1" checkbox, so a submission arrives as
// either '0' or ['0','1'] — the LAST element encodes the checkbox state.
const _CANONICAL_FEATURED_VALUES = Object.freeze(new Set(['0', '1', 'false', 'true', 'off', 'on']));

/**
 * Check that a submitted is_featured value is one the app can interpret.
 *
 * parseBooleanFlag maps every non-canonical string to 0, so a value like
 * "yes" silently UN-featured a published article while the route flashed
 * "Article updated." — a present-but-invalid value was accepted and the
 * opposite of the caller's intent was applied. The app-wide rule is that a
 * present-but-invalid value is rejected, so the submission is validated
 * before it reaches the resolver.
 *
 * An absent / empty submission is "not submitted" and stays valid (the
 * resolver preserves the stored flag).
 *
 * @param {*} raw - the raw req.body.is_featured value
 * @returns {boolean} true when the value is absent or canonical
 */
function isCanonicalFeaturedSubmission(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return true;
  }
  const value = Array.isArray(raw) ? raw[raw.length - 1] : raw;
  if (value === true || value === false || value === 1 || value === 0) {
    return true;
  }
  if (typeof value !== 'string') {
    return false;
  }
  return _CANONICAL_FEATURED_VALUES.has(value.trim().toLowerCase());
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
    logError('Markdown render error:', err);
    try {
      return `<div>Article content could not be rendered. Showing plain text:</div><pre>${escapeHtml(content || '')}</pre>`;
    } catch (innerErr) {
      logError('Secondary escape error:', innerErr);
      return '<div>Article content could not be rendered.</div>';
    }
  }
}

/**
 * Truncate a sanitized string to `maxLen` characters without cutting an HTML
 * entity in half.
 *
 * sanitize-html expands the source characters (&, <, >, ", ') into entities
 * (e.g. "&" -> "&amp;"), so a plain substring() can land in the middle of an
 * entity and leave a literal "&am" in the stored text — the entity was never
 * completed, so it renders as text rather than as the character it stands for.
 * When the cut point falls inside a trailing entity, the partial entity is
 * dropped instead.
 *
 * @param {string} value - the already-sanitized string
 * @param {number} maxLen - the maximum number of characters to keep
 * @returns {string}
 */
function _truncateAtEntityBoundary(value, maxLen) {
  if (typeof value !== 'string' || value.length <= maxLen) {
    return value;
  }
  let cut = value.slice(0, maxLen);
  // A trailing "&" or "&<partial-entity>" is an incomplete entity — drop it.
  const amp = cut.lastIndexOf('&');
  if (amp !== -1) {
    const tail = cut.slice(amp);
    // A complete entity ends with ';' — keep it. Anything else is a partial
    // entity (or a bare '&') and is dropped.
    if (!tail.endsWith(';')) {
      cut = cut.slice(0, amp);
    }
  }
  return cut;
}

/**
 * Sanitize knowledge article input by stripping HTML and truncating to max lengths.
 * Returns { safeTitle, safeContent, safeTags, error }. Title/content empty strings
 * are preserved (surfaced as errors since the fields are required); empty tags
 * (optional) are normalized to null.
 *
 * The three fields are stored in TWO different representations, and the
 * difference matters:
 *
 *   - The CONTENT is rendered as HTML (marked -> sanitize-html -> `<%- %>`),
 *     so its stored form MUST stay entity-escaped: the entities are what make
 *     the rendered HTML display the author's characters.
 *   - The TITLE and the TAGS are PLAIN TEXT — every template renders them
 *     with EJS's escaping `<%= %>`. Storing them entity-escaped escaped them
 *     a SECOND time at render time, so the browser displayed "R&amp;D" where
 *     the author had written "R&D", and a search for the title the user could
 *     see matched nothing (the stored value held the literal text "&amp;").
 *     They are therefore decoded back to plain text after sanitization, which
 *     also makes their length limits exact: the stored length is the typed
 *     length, so the form's maxlength and the server-side limit agree.
 *
 * @param {string} title
 * @param {string} content
 * @param {string} tags
 * @returns {{ safeTitle: string, safeContent: string, safeTags: string|null, error: string|null, truncated: boolean, truncatedField: string|null }}
 *   `truncated` is true when the SANITIZED value had to be cut to fit its
 *   limit — the length limits apply to the stored value, so the caller must
 *   reject such a value rather than silently store a shortened one.
 *   `truncatedField` names the field that was cut ('title' | 'content' |
 *   'tags') so the caller can report the limit that actually applies to it.
 */
function sanitizeKnowledgeInput(title, content, tags) {
  let safeTags;
  let safeTitle;
  let safeContent;
  let truncated = false;
  let truncatedField = null;
  try {
    // Sanitize first, then truncate. Truncating before sanitizing would let a
    // value sitting exactly at the limit grow past it once sanitizeHtml escapes
    // characters (e.g. "&" -> "&amp;"), producing over-length stored data.
    //
    // The tags are plain text (rendered escaped), so the entities the
    // sanitizer introduced are decoded again — otherwise the stored value
    // would carry the literal text "&amp;" and the list would show it.
    safeTags = decodeHtmlEntities(sanitizeHtml(tags || '', STRIP_HTML_OPTIONS));
    // Trim whitespace from title and content AFTER sanitization (not before)
    // so that a title consisting solely of HTML tags (e.g. "<b></b>") is first
    // stripped to "" by sanitize-html, then safely trimmed. A title of only
    // whitespace characters (e.g. "   ") would otherwise survive sanitization
    // intact and pass the !safeTitle guard below, storing whitespace-only
    // titles that render as blank in templates.
    //
    // The truncation is applied to the SANITIZED string, and it must not cut an
    // HTML entity in half: a raw substring() left a trailing "&am" in the
    // stored text (the entity was never completed, so it rendered literally).
    // _truncateAtEntityBoundary drops a trailing partial entity.
    //
    // The title is plain text like the tags, so it is decoded after
    // sanitization: the stored title is then exactly the title the author
    // typed, which is what the list, the show page and the search all render.
    const cleanTitle = decodeHtmlEntities(sanitizeHtml(title, STRIP_HTML_OPTIONS)).trim();
    // The content is rendered as HTML, so it KEEPS the entity-escaped form.
    const cleanContent = sanitizeHtml(content, STRIP_HTML_OPTIONS).trim();
    safeTitle = _truncateAtEntityBoundary(cleanTitle, MAX_MEDIUM_STR);
    safeContent = _truncateAtEntityBoundary(cleanContent, MAX_CONTENT);
    if (safeTitle.length < cleanTitle.length) {
      truncated = true;
      truncatedField = 'title';
    }
    if (safeContent.length < cleanContent.length) {
      truncated = true;
      // The content is the field that can actually overflow: it is stored
      // entity-escaped, so a body of ampersands grows several-fold. It is
      // reported ahead of the other fields because it is the only one whose
      // stored form differs in length from what the author typed.
      truncatedField = truncatedField || 'content';
    }
    // Normalize empty tags to null (the column is nullable and a NULL is
    // cleaner than a stored '' — searches and template rendering treat them
    // identically, so this only affects what is written to the DB).
    if (safeTags) {
      const cleanTags = safeTags;
      safeTags = cleanTags.substring(0, MAX_LONG_STR);
      if (safeTags.length < cleanTags.length) {
        truncated = true;
        truncatedField = truncatedField || 'tags';
      }
      safeTags = safeTags || null;
    } else {
      safeTags = null;
    }
  } catch (sanitizeErr) {
    return { safeTitle: '', safeContent: '', safeTags: null, error: (sanitizeErr && sanitizeErr.message) || String(sanitizeErr), truncated: false, truncatedField: null };
  }
  return { safeTitle, safeContent, safeTags, error: null, truncated, truncatedField };
}

/**
 * Build the flash message for a value that did not fit its limit after
 * sanitization. The message names the field that overflowed and the limit
 * that applies to THAT field, so the author is told what to shorten.
 *
 * @param {string|null} field - 'title' | 'content' | 'tags' | null
 * @returns {string}
 */
function _truncationMessage(field) {
  if (field === 'title') {
    return `Title is too long after removing invalid markup (limit ${MAX_MEDIUM_STR} characters)`;
  }
  if (field === 'tags') {
    return `Tags are too long after removing invalid markup (limit ${MAX_LONG_STR} characters)`;
  }
  return `Content is too long after removing invalid markup (limit ${MAX_CONTENT} characters)`;
}

// List articles (paginated)
router.get('/', kbReadLimiter, (req, res) => {
  req.audit('read', 'knowledge_article', null, 'Viewed knowledge base list');
  // Fail closed on HTTP parameter pollution: reject array payloads on query
  // params. Mirrors the explicit HPP guard on GET /audit and the array-rejection
  // convention used by every write route in the app.
  const hppErrors = rejectHppArrays(req, ['search', 'category', 'status']);
  if (hppErrors.length > 0) {
    req.flash('error', 'Invalid request parameters');
    return res.redirect('/knowledge');
  }
  const { page: requestedPage, limit } = paginate(req);

  const qCategory = safeQueryValue(req.query.category);
  const qStatus = safeQueryValue(req.query.status);
  const filters = buildFilters({
    'k.category': { value: VALID_CATEGORIES.includes(qCategory) ? qCategory : '' },
    'k.status': { value: VALID_STATUSES.includes(qStatus) ? qStatus : '' }
  }, ['k.category', 'k.status']);

  const where = [...filters.where];
  const params = [...filters.params];
  // The search surface must cover exactly what the list renders: the title,
  // the tags and the AUTHOR's name (the row renders an author column, and
  // the list offers no author filter). The body is searchable too — the
  // list is scoped to the viewer, so every row it can return is readable in
  // full (the same rule the change list applies).
  //
  // The author column renders the author's name as ONE string ("<first>
  // <last>"), so the search matches that CONCATENATION rather than the two
  // halves separately — otherwise the name the user could read was
  // unfindable ("John Smith" matched nothing while "John" and "Smith" each
  // did). Both halves were already searchable, so the concatenation exposes
  // nothing the viewer cannot already read.
  addSearch(where, params, safeQueryValue(req.query.search), ['k.title', 'k.content', 'k.tags', { concat: ['u.first_name', 'u.last_name'] }]);

  // Visibility: non-privileged users can only see published articles and their own drafts/archived.
  // The show page already restricts access, but the index was leaking draft metadata
  // (titles, authors, categories) to all authenticated users.
  if (!isPrivileged(req.session.user)) {
    where.push("(k.status = 'published' OR k.author_id = ?)");
    params.push(req.session.user.id);
  }

  const whereClause = where.length ? where.join(' AND ') : '1=1';

  // The count query needs the same JOIN as the list query: the search now
  // covers the author's name, which lives in the joined users table.
  const total = countQuery(db, 'knowledge_articles', 'k', whereClause, params, 'LEFT JOIN users u ON k.author_id = u.id');
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
    ORDER BY k.updated_at DESC, k.id DESC
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
  const is_featured = req.body.is_featured;

  // Fail closed on a present-but-non-string tags/status value (e.g. a JSON
  // number or object): trim() coerces it to '', which would silently wipe or
  // default the stored value — for tags that means NULLing the stored tags on
  // update, for status it means silently falling back to the default. Absent/
  // empty submissions are allowed and preserve the stored value.
  // The REQUIRED columns are guarded too: without it a JSON number in
  // `title`, `content` or `category` collapsed to '' and was reported as a
  // MISSING field ("Title, content, and category are required"), while the
  // matching update route reported the identical submission as "Invalid
  // request parameters" — a type error masquerading as an absent one.
  for (const field of ['title', 'content', 'category', 'tags', 'status']) {
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
    req.flash('error', 'Invalid Category');
    return res.redirect('/knowledge/new');
  }

  // Enum resolution — a present-but-blank status (a whitespace-only value) is
  // an invalid value, not an omitted one: it used to trim to '' and silently
  // take the 'draft' default with a success flash. The `status` column is NOT
  // NULL, so an EMPTY value has no valid meaning either — the update route
  // rejects it, and the create route used to accept it and silently default.
  const createStatusEnum = resolveEnumField(req.body.status, VALID_STATUSES);
  if (createStatusEnum.state === 'blank' || createStatusEnum.state === 'invalid' || createStatusEnum.state === 'empty') {
    req.flash('error', 'Invalid Status');
    return res.redirect('/knowledge/new');
  }

  // Fail closed on a present-but-uninterpretable is_featured value (e.g. "yes").
  if (!isCanonicalFeaturedSubmission(req.body.is_featured)) {
    req.flash('error', 'Invalid Featured Flag');
    return res.redirect('/knowledge/new');
  }

  // Sanitize tags, title, and content for defense-in-depth (templates escape with <%=, but strip HTML at input too)
  const sanitized = sanitizeKnowledgeInput(title, content, tags);
  if (sanitized.error) {
    logError('HTML sanitization error:', sanitized.error);
    req.flash('error', 'Error processing input. Please try again.');
    return res.redirect('/knowledge/new');
  }
  const { safeTags, safeTitle, safeContent } = sanitized;
  // The length limits apply to the STORED (sanitized) value. sanitize-html
  // expands the source characters ("&" -> "&amp;"), so a body that is within
  // the raw limit can be several times longer once sanitized — the truncation
  // then silently discarded most of the author's text while the route flashed
  // a success. Fail closed instead: a value that had to be cut is rejected so
  // the author learns that their content did not fit.
  //
  // The message names the field that actually overflowed and ITS limit. It
  // used to always say "Content … (limit 50000 characters)", so a title that
  // did not fit was reported against the body limit — a limit the author
  // could not act on (their body was nine characters long).
  if (sanitized.truncated) {
    req.flash('error', _truncationMessage(sanitized.truncatedField));
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
    // Co-locate safeStatus/safeFeatured resolution with the INSERT in a single
    // transaction. Note: this does NOT protect against a concurrent ROLE change
    // — the role is read from req.session.user, a request-lifetime snapshot
    // that a transaction boundary cannot re-check (requireAuth re-syncs it once
    // per request at the very start). The transaction merely keeps the resolved
    // values and the INSERT atomic; role TOCTOU is accepted because a demotion
    // takes effect on the user's next request.
    const createArticle = db.transaction(() => {
      const txnSafeStatus = resolveSafeStatus(req.session.user, createStatusEnum.state === 'valid' ? createStatusEnum.value : null, null);
      const txnSafeFeatured = resolveSafeFeatured(req.session.user, is_featured);
      return _articleInsertStmt.run(safeTitle, safeContent, category, safeTags, req.session.user.id, txnSafeStatus, txnSafeFeatured);
    });
    const result = createArticle();

    req.audit('create', 'knowledge_article', result.lastInsertRowid, `Created article "${safeTitle}"`);
    req.flash('success', 'Article created.');
    invalidateDashboardCache();
    return res.redirect(`/knowledge/${result.lastInsertRowid}`);
  } catch (err) {
    logError('Article create error:', err);
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
  //
  // The rendered count is the count AFTER the increment: the row was read
  // before the UPDATE ran, so rendering `article.views` showed a number one
  // behind the stored one (the first-ever view of an article rendered
  // "0 views" while the row already read 1).
  let viewCount = article.views;
  if (!req.session || !req.session[VIEWED_KEY]) {
    req.session[VIEWED_KEY] = [];
  }
  const viewed = req.session[VIEWED_KEY];
  if (!viewed.includes(id) && req.session.user && Number(article.author_id) !== Number(req.session.user.id)) {
    try {
      const result = _viewCountStmt.run(id);
      if (result.changes > 0) {
        viewCount = article.views + 1;
      }
    } catch (err) {
      logError('View count update error:', err);
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
  const safeArticle = { ...article, views: viewCount };
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
    // Use the same non-enumerating wording as the show route: a distinct
    // "you do not have permission" message reveals that the article ID
    // exists even though the index deliberately hides non-published articles
    // from this viewer.
    req.flash('error', 'Article not found');
    // Redirect to the list, not the detail page: the show route denies
    // non-owners on non-published articles, so redirecting to detail would
    // trigger a second access_denied flash + audit. Mirrors the delete-denial
    // redirect on this route.
    return res.redirect('/knowledge');
  }

  // The body is stored ENTITY-ESCAPED (it is rendered as HTML on the show
  // page), while the edit form renders it in a plain <textarea> with EJS's
  // escaping <%= %>. Feeding the escaped stored value straight into the form
  // escaped it a SECOND time, so the author saw the literal text "a &amp; b"
  // where they had typed "a & b" — and re-saving it stored the doubly
  // escaped form. Decode the entities for the FORM ONLY: the textarea then
  // shows the author's own text, and re-submitting it re-sanitizes to exactly
  // the same stored value (the round trip is stable). The stored row is not
  // modified — the copy is handed to the template.
  const formArticle = {
    ...article,
    content: decodeHtmlEntities(article.content || '')
  };
  res.render('pages/knowledge/form', { title: 'Edit Article', article: formArticle, isEdit: true });
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
    // Use the same non-enumerating wording as the show route: a distinct
    // "you do not have permission" message reveals that the article ID
    // exists even though the index deliberately hides non-published articles
    // from this viewer.
    req.flash('error', 'Article not found');
    return res.redirect('/knowledge');
  }

  const title = trim(safeQueryValue(req.body.title));
  const content = trim(safeQueryValue(req.body.content));
  const category = trim(safeQueryValue(req.body.category));
  const tags = trim(safeQueryValue(req.body.tags));
  const is_featured = req.body.is_featured;

  // Fail closed on a present-but-non-string tags/status value (e.g. a JSON
  // number or object): trim() coerces it to '', which would silently wipe the
  // stored tags or preserve status with no feedback — inconsistent with the
  // fail-closed convention applied to every other present-but-invalid field
  // on this route. Absent/empty submissions are allowed (tags clears / status
  // falls back to the stored value).
  // The REQUIRED columns are guarded too: without it a JSON number in
  // `title`, `content` or `category` collapsed to '' and was reported as a
  // MISSING field ("Title, content, and category are required"), while the
  // sibling required columns on the assets/tickets update routes report the
  // identical submission as "Invalid request parameters" — a type error
  // masquerading as an absent one.
  for (const field of ['title', 'content', 'category', 'tags', 'status']) {
    const v = req.body[field];
    if (v !== undefined && v !== null && v !== '' && typeof v !== 'string') {
      req.flash('error', 'Invalid request parameters');
      return res.redirect(`/knowledge/${id}/edit`);
    }
  }

  // Absent-vs-present markers for the fields this route resolves. An ABSENT
  // field in a partial API submission preserves the stored value; a PRESENT
  // field must carry a valid value. This is the contract every other field on
  // this route already follows (status, is_featured, tags) and the one the
  // route's own comment states — "an absent field means 'keep what's stored'".
  // The three required columns (title / content / category) were the sole
  // exception: a partial PUT that only changed the tags was rejected with
  // "Title, content, and category are required" even though the stored values
  // were perfectly valid. The stored values are re-read inside the
  // transaction below, so an absent field resolves to the CURRENT row.
  const titleAbsent = req.body.title === undefined || req.body.title === null;
  const contentAbsent = req.body.content === undefined || req.body.content === null;
  const categoryAbsent = req.body.category === undefined || req.body.category === null;

  if ((!titleAbsent && !title) || (!contentAbsent && !content) || (!categoryAbsent && !category)) {
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

  if (!categoryAbsent && !VALID_CATEGORIES.includes(category)) {
    req.flash('error', 'Invalid Category');
    return res.redirect(`/knowledge/${id}/edit`);
  }

  // Enum resolution — the presence test runs against the RAW submitted value
  // so a present-but-blank status is rejected rather than silently ignored.
  // `status` is a NOT NULL column (an empty value has no valid meaning).
  const statusEnum = resolveEnumField(req.body.status, VALID_STATUSES);
  if (statusEnum.state === 'blank' || statusEnum.state === 'invalid' || statusEnum.state === 'empty') {
    req.flash('error', 'Invalid Status');
    return res.redirect(`/knowledge/${id}/edit`);
  }

  // Fail closed on a present-but-uninterpretable is_featured value (e.g. "yes").
  if (!isCanonicalFeaturedSubmission(req.body.is_featured)) {
    req.flash('error', 'Invalid Featured Flag');
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
    logError('HTML sanitization error:', sanitized.error);
    req.flash('error', 'Error processing input. Please try again.');
    return res.redirect(`/knowledge/${id}/edit`);
  }
  const { safeTitle, safeContent } = sanitized;
  // The length limits apply to the STORED (sanitized) value — see the create
  // route for the rationale. A value that had to be cut is rejected rather
  // than silently stored shortened, and the message names the field and the
  // limit that actually apply to it.
  if (sanitized.truncated) {
    req.flash('error', _truncationMessage(sanitized.truncatedField));
    return res.redirect(`/knowledge/${id}/edit`);
  }
  // Absent-vs-empty convention (mirrors resolveOptionalField on vendors/licenses/
  // projects/changes): an ABSENT tags field (partial API PUT omitting it) preserves
  // the stored value; an explicit empty string clears it to NULL. Previously an
  // absent field trimmed to '' and wiped the stored tags with a success flash.
  // Resolution happens inside the transaction against the rechecked row (see
  // below) so a concurrent tags edit cannot be overwritten by a stale value.
  //
  // A present-but-whitespace-only value is REJECTED rather than treated as a
  // clear: it is neither an absent field (preserve) nor an explicit empty
  // string (clear), yet it trims to an empty string — so it used to silently
  // wipe the stored tags while the route flashed "Article updated." That is
  // exactly the failure mode resolveOptionalField's blank-value rule exists
  // to prevent; the helper is used below so this route cannot regress again.
  if (!titleAbsent && !safeTitle) {
    req.flash('error', 'Title is required after removing invalid content');
    return res.redirect(`/knowledge/${id}/edit`);
  }
  if (!contentAbsent && !safeContent) {
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
    //
    // effectiveTitle is hoisted out of the transaction so the audit entry
    // names the EFFECTIVE (resolved) article title. The submitted `safeTitle`
    // is empty on a partial update that omits the title, which made the
    // audit log record `Updated article ""` for every such request.
    let effectiveTitle = safeTitle;
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
      // An ABSENT status preserves the stored one (the partial-update
      // contract) — the submitted value is only forwarded when the request
      // actually carried a valid one.
      const txnSafeStatus = resolveSafeStatus(req.session.user, statusEnum.state === 'valid' ? statusEnum.value : recheck.status, recheck.status);
      const txnSafeFeatured = resolveSafeFeatured(req.session.user, is_featured, recheck.is_featured);
      // Resolve the required columns from the transaction-consistent row: an
      // ABSENT field preserves the CURRENT stored value (the partial-update
      // contract every other field on this route already follows), while a
      // PRESENT field uses the submitted (sanitized) value. A present-but-blank
      // tags value is rejected by resolveOptionalField instead of silently
      // clearing the stored tags.
      const txnTitle = titleAbsent ? recheck.title : safeTitle;
      effectiveTitle = txnTitle;
      const txnContent = contentAbsent ? recheck.content : safeContent;
      const txnCategory = categoryAbsent ? recheck.category : category;
      const txnSafeTags = resolveOptionalField(req.body.tags, sanitized.safeTags, MAX_LONG_STR, recheck.tags);
      if (txnSafeTags && txnSafeTags.error) {
        throw new Error('INVALID_TAGS');
      }
      const result = _articleUpdateStmt.run(txnTitle, txnContent, txnCategory, txnSafeTags, txnSafeStatus, txnSafeFeatured, id);
      if (result.changes === 0) {
        throw new Error('NOT_FOUND');
      }
    });
    updateArticle();

    req.audit('update', 'knowledge_article', id, `Updated article "${effectiveTitle}"`);
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
      // Non-enumerating wording — mirrors the show route and the outer guard.
      req.flash('error', 'Article not found');
      return res.redirect('/knowledge');
    }
    if (err.message === 'INVALID_TAGS') {
      req.flash('error', 'Invalid Tags');
      return res.redirect(`/knowledge/${id}/edit`);
    }
    logError('Article update error:', err);
    req.flash('error', 'Error updating article. Please try again.');
    return res.redirect(`/knowledge/${id}/edit`);
  }
});

// Delete article
router.delete('/:id', kbWriteLimiter, (req, res) => {
  // Fail closed on HTTP parameter pollution: reject array payloads. Mirrors the
  // array-rejection guards on every other write route in the app.
  const hppErrors = rejectHppArrays(req, ['id']);
  if (hppErrors.length > 0) {
    req.flash('error', 'Invalid request parameters');
    return res.redirect('/knowledge');
  }

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
    // Non-enumerating wording — mirrors the show route and the outer guard.
    req.flash('error', 'Article not found');
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
        throw new Error('NOT_FOUND');
      }
      // Recheck authorization inside the transaction so a concurrent role
      // change between the outer check and the DELETE cannot bypass it.
      const txnIsOwner = Number(recheck.author_id) === Number(req.session.user.id);
      if (!txnIsOwner && !isPrivileged(req.session.user)) {
        throw new Error('ACCESS_DENIED');
      }
      const result = _deleteArticleStmt.run(id);
      // Fail closed when the DELETE affects no row. The recheck above makes this
      // unreachable today, but every sibling delete route (assets/changes/
      // licenses/projects/tickets) guards on changes === 0 so a future reorder
      // cannot turn a no-op DELETE into a success audit entry.
      if (result.changes === 0) {
        throw new Error('NOT_FOUND');
      }
      return { title: recheck.title };
    });
    const deleteResult = deleteArticle();
    req.audit('delete', 'knowledge_article', id, `Deleted article "${deleteResult.title}"`);
    req.flash('success', 'Article deleted.');
    invalidateDashboardCache();
  } catch (err) {
    if (err.message === 'NOT_FOUND') {
      req.flash('error', 'Article not found');
    } else if (err.message === 'ACCESS_DENIED') {
      req.audit('access_denied', 'knowledge_article', id, 'Unauthorized delete attempt on article (concurrent ownership change)');
      // Non-enumerating wording — mirrors the show route and the outer guard.
      req.flash('error', 'Article not found');
    } else {
      logError('Article delete error:', err);
      req.flash('error', 'Error deleting article.');
    }
  }
  return res.redirect('/knowledge');
});

module.exports = router;
module.exports.renderMarkdown = renderMarkdown;
module.exports.resolveSafeFeatured = resolveSafeFeatured;
module.exports.resolveSafeStatus = resolveSafeStatus;
module.exports.markedFallback = markedFallback;
module.exports.sanitizeKnowledgeInput = sanitizeKnowledgeInput;
module.exports._truncationMessage = _truncationMessage;
module.exports.resetCachedStatements = () => {};
