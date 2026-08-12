/**
 * Shared utilities for routes
 */

const { MIN_PASSWORD, MAX_PASSWORD, MAX_PASSWORD_BYTES, MAX_USERNAME, MAX_EMAIL, MAX_SEARCH, MAX_PAGE, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE, ASSET_TAG_RE, CONDITION_BADGE, CHANGE_TYPE_BADGE, ROLE_BADGE } = require('./constants');
let PAGE_SIZE;

const ACRONYMS = Object.freeze(new Set(['AD', 'AI', 'API', 'BIOS', 'CDN', 'CLI', 'CPU', 'CSV', 'DHCP', 'DNS', 'FAQ', 'GPU', 'GUI', 'HDD', 'HTML', 'HTTP', 'HTTPS', 'HVAC', 'IOT', 'IP', 'JSON', 'KVM', 'LDAP', 'MFA', 'ML', 'NAS', 'NAT', 'NVME', 'OAUTH', 'PCIE', 'PDF', 'RAID', 'RAM', 'RBAC', 'RMA', 'SAN', 'SATA', 'SCSI', 'SLA', 'SOP', 'SQL', 'SSD', 'SSH', 'SSL', 'SSO', 'UPS', 'USB', 'VPN', 'XML', 'YAML']));
const _MAX_ACRONYM_LENGTH = Math.max(0, ...Array.from(ACRONYMS, a => a.length));
const SAFE_COLUMN_RE = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?$/;

/**
 * Extract a scalar value from a query parameter. When the value is an array
 * (HTTP parameter pollution), returns the first element — this is the
 * fail-open fallback used by utilities that do not have an explicit HPP
 * guard at the call site. Route handlers that need fail-closed HPP defense
 * must use rejectHppArrays() before calling this function.
 */
function safeQueryValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Build a sanitized filters object from req.query for template rendering.
 * Each known parameter is run through safeQueryValue to strip HPP arrays,
 * preventing array values from leaking into the template context where
 * they would break === comparisons and produce misleading comma-separated
 * output in form fields.
 * @param {Object} query - req.query
 * @param {string[]} allowed - List of known filter parameter names
 * @returns {Object}
 */
function safeFilters(query, allowed) {
  const filters = {};
  for (const key of allowed) {
    if (Object.hasOwn(query, key)) {
      filters[key] = safeQueryValue(query[key]);
    }
  }
  return filters;
}

/**
 * Parse pagination params from query string
 */
function paginate(req) {
  const page = Math.max(1, Math.min(MAX_PAGE, parseInt(safeQueryValue(req.query.page), 10) || 1));
  const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, parseInt(safeQueryValue(req.query.limit), 10) || PAGE_SIZE));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

/**
 * Build a base URL for pagination links (strips `page` param from query).
 * Uses an explicit allowlist of known query parameters to prevent prototype
 * pollution from spreading user-controlled params into the URL.
 * Guards against array values from HTTP parameter pollution (HPP) by taking
 * only the first element, mirroring the array guards in safeId/safeInt/etc.
 */
function paginationBaseUrl(req) {
  const known = ['search', 'sort', 'status', 'category', 'priority', 'assigned_to', 'department', 'role', 'license_type', 'change_type', 'is_active', 'period', 'action', 'entity_type', 'limit'];
  const q = {};
  for (const key of known) {
    const v = req.query[key];
    if (v !== undefined) {
      // Guard against HPP arrays (e.g. ?sort[]=a&sort[]=b) the same way the
      // list routes sanitize every other query parameter. safeSort/
      // buildFilters whitelist their inputs downstream, but paginationBaseUrl
      // emits the raw value into the URL, so arrays must be stripped to avoid
      // leaking comma-joined junk into rendered links.
      q[key] = safeQueryValue(v);
    }
  }
  const qs = new URLSearchParams(q).toString();
  return req.path + (qs ? '?' + qs : '');
}

/**
 * Whitelisted sort options to prevent SQL injection
 */
function safeSort(value, allowedMap, defaultKey) {
  const keys = Object.keys(allowedMap);
  if (keys.length === 0) {
    throw new Error('safeSort: allowedMap must not be empty');
  }
  if (Object.hasOwn(allowedMap, value)) {
    return allowedMap[value];
  }
  // Fail closed if the supplied defaultKey is not a valid key in the map. The
  // previous implementation silently fell back to `keys[0]` (an arbitrary
  // first entry), which would mask a caller bug — e.g. a typo'd defaultKey —
  // and produce a sort order that contradicts the caller's intent. Callers
  // (tickets/reports/audit) always pass a constant valid key, so this only
  // hardens against future misuse; it never changes current behavior.
  if (!Object.hasOwn(allowedMap, defaultKey)) {
    throw new Error(`safeSort: defaultKey "${defaultKey}" is not a valid sort key`);
  }
  return allowedMap[defaultKey];
}

/**
 * Quote a column name that may include a table alias (e.g. "t"."status").
 *
 * Each segment is validated against SAFE_COLUMN_RE (the same allowlist pattern
 * addSearch uses) BEFORE quoting, so the function is safe-by-construction:
 * it can never emit a segment containing a quote, dash, or other character
 * that would break out of the double-quoted identifier. All current callers
 * pre-validate their inputs, but quoteColumn is the single choke-point that
 * builds identifier SQL and is publicly exported, so it must defend itself
 * against future misuse rather than relying on callers to stay disciplined.
 * @param {string} col
 * @returns {string}
 */
function quoteColumn(col) {
  if (!col || typeof col !== 'string' || !SAFE_COLUMN_RE.test(col)) {
    throw new Error(`Invalid column name: ${col}`);
  }
  // SAFE_COLUMN_RE guarantees every segment is a bare identifier, so it is now
  // safe to wrap each one in double quotes without risk of injection.
  return '"' + col.split('.').join('"."') + '"';
}

/**
 * Build WHERE clause safely from whitelisted filters.
 * Column names and operators are validated against allowlists to prevent SQL injection.
 * @param {Object} filters - { column: { value, operator? } }
 * @param {string[]} allowedColumns - List of allowed column names (e.g. ['a.category', 't.status'])
 * @param {string[]} [allowedOperators=['=', '!=', '<', '>', '<=', '>=']] - Allowed SQL operators
 * @returns {{ where: string[], params: any[] }}
 */
function buildFilters(filters, allowedColumns, allowedOperators = ['=', '!=', '<', '>', '<=', '>=']) {
  if (!allowedColumns || allowedColumns.length === 0) {
    throw new Error('buildFilters: allowedColumns must be non-empty');
  }
  const where = [];
  const params = [];
  for (const [column, config] of Object.entries(filters)) {
    if (config.value === undefined || config.value === null || config.value === '') {
      continue;
    }
    if (!allowedColumns.includes(column)) {
      console.warn(`buildFilters: skipping invalid column "${column}"`);
      continue;
    }
    const op = config.operator || '=';
    if (!allowedOperators.includes(op)) {
      console.warn(`buildFilters: skipping invalid operator "${op}"`);
      continue;
    }
    where.push(`${quoteColumn(column)} ${op} ?`);
    params.push(config.value);
  }
  return { where, params };
}

/**
 * Validate a password against the corporate password policy.
 * Returns an error message string if invalid, or null if valid.
 */
function validatePassword(password) {
  if (!password || password.length < MIN_PASSWORD) {
    return `Password must be at least ${MIN_PASSWORD} characters`;
  }
  if (password.length > MAX_PASSWORD) {
    return `Password must be at most ${MAX_PASSWORD} characters`;
  }
  // bcrypt silently truncates at 72 bytes, so two passwords that differ only
  // after that point hash identically — a silent credential-collision risk.
  // Enforce the byte length (UTF-8), not just the character length.
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    return `Password must be at most ${MAX_PASSWORD_BYTES} bytes`;
  }
  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
    return 'Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character';
  }
  return null;
}

const _USERNAME_RE = new RegExp(`^[a-zA-Z0-9._-]{2,${MAX_USERNAME}}$`);

/**
 * Validate that a string is a safe username (alphanumeric, dashes, underscores, dots).
 * Returns true if valid.
 */
function isValidUsername(username) {
  return typeof username === 'string' && _USERNAME_RE.test(username);
}

/**
 * Validate basic email format. Returns true if valid.
 */
function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= MAX_EMAIL;
}

/**
 * Add LIKE search conditions safely.
 * Column names are validated against a safe pattern to prevent SQL injection.
 * @param {string[]} columns - List of column names to search (must be non-empty)
 */
function addSearch(where, params, search, columns) {
  if (!search || typeof search !== 'string') {
    return;
  }
  if (!columns || !Array.isArray(columns) || columns.length === 0) {
    throw new Error('columns is required for addSearch');
  }
  // Trim whitespace so that a string of only spaces does not match every row.
  // A search of "   " would produce LIKE '%   %' which matches any string
  // containing at least one space — essentially returning all rows.
  const trimmed = search.trim();
  if (!trimmed) {
    return;
  }
  // Validate column names — only allow identifiers with letters, digits, underscores, and dots (for table aliases).
  for (const c of columns) {
    if (!SAFE_COLUMN_RE.test(c)) {
      throw new Error(`Invalid column name in addSearch: ${c}`);
    }
  }
  // Cap input length so a client cannot force expensive escaping plus a
  // pathological LIKE scan by submitting a multi-megabyte ?search= value.
  const raw = trimmed.slice(0, MAX_SEARCH);
  // Escape SQL LIKE wildcards — backslash must be escaped first to avoid
  // interfering with the ESCAPE clause
  const escaped = raw.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
  const term = `%${escaped}%`;
  const conditions = columns.map(c => `${quoteColumn(c)} LIKE ? ESCAPE '\\'`);
  where.push(`(${conditions.join(' OR ')})`);
  columns.forEach(() => params.push(term));
}

/**
 * Safely parse a route parameter as a positive integer
 * Returns null if invalid.
 *
 * Rejects arrays to defend against HTTP parameter pollution
 * (e.g. ?assigned_to[]=1&assigned_to[]=2) — parseInt() coerces an array to a
 * string and silently returns the first element, which is surprising and
 * inconsistent with safeInt / safePositiveFloat. Treat any array as invalid.
 */
function safeId(value) {
  if (Array.isArray(value)) {
    return null;
  }
  // Only accept strings or numbers; reject booleans, objects, etc.
  // This prevents unintended coercion (e.g. true → 1 via String(true)).
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Detect a present-but-invalid relational id (assigned_to / owner_id / asset_id).
 * Returns true when the submitted value is present yet cannot parse to a valid
 * positive integer — e.g. "abc", "3.5", "0", 12.5, or an array/object. Absent
 * (undefined/null) and empty-string values return false (treated as "clear /
 * unassign"). The write routes use this to fail closed on malformed present ids
 * instead of silently coercing them to NULL through safeId, which would wipe an
 * existing assignment with no user-visible error.
 * @param {*} value
 * @returns {boolean}
 */
function isPresentInvalidId(value) {
  if (value === undefined || value === null || value === '') {
    return false;
  }
  if (typeof value === 'number') {
    return !(Number.isInteger(value) && value > 0);
  }
  if (typeof value === 'string') {
    return !/^[1-9]\d*$/.test(value.trim());
  }
  return true;
}

/**
 * Safely parse a numeric form field, returning `fallback` for NaN / non-finite / negative.
 * Use for monetary values that should be non-negative.
 * @param {*} value
 * @param {number|null} [fallback=null]
 * @returns {number|null}
 */
function safePositiveFloat(value, fallback = null) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  // Reject arrays from HTTP parameter pollution
  if (Array.isArray(value)) {
    return fallback;
  }
  // Reject strings with trailing/leading garbage so malformed monetary values
  // are not silently stored. parseFloat("1,000") === 1 and
  // parseFloat("100abc") === 100, both of which would corrupt budget/cost/
  // price fields. Mirrors the strict regex validation in safeInt.
  // Reject strings with a leading '+' — inconsistent with other numeric parsers
  // in the codebase (safeInt, safePositiveInt) which reject non-canonical input.
  // Also blocks parseFloat("Infinity") masquerading as a number.
  if (typeof value === 'string') {
    if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) {
      return fallback;
    }
  }
  const n = parseFloat(value);
  // Reject Infinity/-Infinity (parseFloat("Infinity") === Infinity and would
  // pass the n < 0 check) — SQLite rejects non-finite values on write, but we
  // should fail closed here rather than rely on a downstream DB error.
  if (!Number.isFinite(n) || n < 0) {
    return fallback;
  }
  return n;
}

/**
 * Safely parse an integer form field, returning `fallback` for NaN.
 */
function safeInt(value, fallback = 0) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  // Reject arrays from HTTP parameter pollution
  if (Array.isArray(value)) {
    return fallback;
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      return fallback;
    }
    return value;
  }
  if (typeof value === 'string') {
    value = value.trim();
    if (!/^-?\d+$/.test(value)) {
      return fallback;
    }
  }
  // Reject non-string, non-number inputs (objects, booleans, symbols) that
  // fall through to parseInt — parseInt silently coerces them to NaN rather
  // than the explicit fallback, breaking the fail-closed contract of the
  // function. Guard here so callers that accidentally pass a non-primitive
  // (e.g. a form field that parsed as an object from a malformed JSON body)
  // get the fallback instead of an undefined/NaN result.
  if (typeof value !== 'string' && typeof value !== 'number') {
    return fallback;
  }
  const n = parseInt(value, 10);
  return n;
}

/**
 * Safely parse a non-negative integer form field for UNSIGNED SQLite columns
 * (e.g. seat counts, quantities). Rejects arrays, non-integers, negatives, and
 * values outside the 32-bit signed bound SQLite stores in an INTEGER column
 * (beyond that, integers are stored as floats with precision loss). Returns
 * `fallback` for invalid input. Mirrors safeInt's HPP/non-finite guards.
 * @param {*} value
 * @param {number} [fallback=0]
 * @returns {number}
 */
function safePositiveInt(value, fallback = 0) {
  const n = safeInt(value, NaN);
  if (!Number.isInteger(n) || n < 0) {
    return fallback;
  }
  if (n > 2147483647) {
    return fallback;
  }
  return n;
}

/**
 * Validate a URL (http/https only). Returns true if valid.
 */
function isValidUrl(url) {
  if (!url || typeof url !== 'string') {
    return false;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

const _ESCAPE_MAP = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
});

/**
 * Escape HTML special characters in a string for safe interpolation in HTML context.
 * Uses the standard OWASP 5-entity encoding set with ampersand first to prevent
 * double-encoding. Returns empty string for non-string input.
 * Pre-built lookup map avoids allocating an object on every match.
 * @param {*} value
 * @returns {string}
 */
function escapeHtml(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.replace(/[&<>"']/g, c => _ESCAPE_MAP[c]);
}

/**
 * Sanitize a phone number: keep only digits, +, -, (, ), spaces.
 * Returns sanitized string or null if input is empty.
 */
function sanitizePhone(phone) {
  if (!phone || typeof phone !== 'string') {
    return null;
  }
  // Strip disallowed characters, then collapse internal whitespace so
  // something like "+1 (555)  123-4567" becomes "+1 (555) 123-4567"
  const sanitized = phone.replace(/[^\d+\-()\s.xX#]/g, '').trim().replace(/\s+/g, ' ');
  return sanitized || null;
}

/**
 * Validate a phone number format (basic).
 * Allows common formats: +1-555-123-4567, (555) 123-4567, 555-123-4567, etc.
 * Returns true if valid.
 */
function isValidPhone(phone) {
  if (!phone || typeof phone !== 'string') {
    return false;
  }
  // Must have at least 7 digits
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15;
}

/**
 * Validate a date string in YYYY-MM-DD format.
 * Returns true if valid.
 */
function isValidDate(value) {
  if (!value || typeof value !== 'string') {
    return false;
  }
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) {
    return false;
  }
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  const d = new Date(year, month - 1, day);
  return !isNaN(d.getTime()) && d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day;
}

/**
 * Validate a datetime string in YYYY-MM-DDTHH:MM format (from datetime-local input).
 * Also accepts YYYY-MM-DD HH:MM and YYYY-MM-DDTHH:MM:SS (seconds are stripped
 * by safeDateTimeLocal to match SQLite's space-separated format without seconds).
 * Returns true if valid.
 */
function isValidDateTimeLocal(value) {
  if (!value || typeof value !== 'string') {
    return false;
  }
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/.test(value)) {
    return false;
  }
  // Normalize to YYYY-MM-DDTHH:MM:SS for reliable Date parsing
  const iso = value.replace(' ', 'T');
  const isoForParse = iso.length === 16 ? iso + ':00' : iso;
  const d = new Date(isoForParse);
  if (isNaN(d.getTime())) {
    return false;
  }
  const [y, mo, da] = iso.slice(0, 10).split('-').map(Number);
  const [h, mi] = iso.slice(11, 16).split(':').map(Number);
  return d.getFullYear() === y && d.getMonth() === mo - 1 && d.getDate() === da &&
    d.getHours() === h && d.getMinutes() === mi;
}

/**
 * Validate an asset tag (e.g. AST-001). Returns true if valid.
 */
function isValidAssetTag(value) {
  return typeof value === 'string' && ASSET_TAG_RE.test(value);
}

/**
 * Sanitize a date field: return the value if valid, or null.
 */
function safeDate(value) {
  return isValidDate(value) ? value : null;
}

/**
 * Sanitize a datetime-local field: return the value if valid, or null.
 */
function safeDateTimeLocal(value) {
  // Normalize T separator to space for consistent comparison with SQLite
  // datetime() output (which uses space format). The HTML datetime-local input
  // sends YYYY-MM-DDTHH:MM, but storing with space avoids string-comparison bugs
  // when compared against datetime('now') and similar functions.
  // Strip seconds (":SS") if present, leaving "HH:MM".
  if (!isValidDateTimeLocal(value)) {
    return null;
  }
  return value.replace('T', ' ').replace(/(:\d{2}):\d{2}$/, '$1');
}

/**
 * Trim a string value from req.body. Returns '' for non-strings.
 */
function trim(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Format a date-only string ("YYYY-MM-DD" or "YYYY-MM-DDTHH:MM:SS") for display.
 * For date-only strings, uses the localDate() helper to avoid the UTC timezone
 * offset bug where `new Date("2024-01-15")` shows Jan 14 in negative-UTC-offset
 * timezones. For datetime strings (containing 'T'), delegates to `new Date()`
 * which handles them correctly.
 * Returns '-' for null/undefined input.
 */
function formatDate(value) {
  if (!value) {
    return '-';
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const d = localDate(value);
    return d ? d.toLocaleDateString() : '-';
  }
  const d = new Date(value);
  return isNaN(d.getTime()) ? '-' : d.toLocaleDateString();
}

/**
 * Format a datetime string for display.
 * Returns '-' for null/undefined input.
 */
function formatDateTime(value) {
  if (!value) {
    return '-';
  }
  // Normalize space-separated datetime (SQLite format) to ISO 8601 with 'T'
  // for reliable Date parsing across all JS engines
  const normalized = typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(value)
    ? value.replace(' ', 'T')
    : value;
  const d = new Date(normalized);
  return isNaN(d.getTime()) ? '-' : d.toLocaleString();
}

/**
 * Parse a date-only string ("YYYY-MM-DD") as a local-date midnight Date.
 * Using `new Date("YYYY-MM-DD")` treats it as UTC midnight, which causes
 * toLocaleDateString() to display the previous calendar day in negative-UTC
 * timezones (e.g. US/Eastern shows Jan 14 for "2024-01-15").
 * Splitting and using the Date(year, month, day) constructor avoids this.
 * Returns null for invalid/non-string input.
 */
function localDate(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) {
    return null;
  }
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) {
    return null;
  }
  return d;
}

// Cached prepared statement for isActiveUser — called on almost every write route.
// Module-level cache (safe because the app uses a single db instance).
let _isActiveUserStmt = null;
function _getIsActiveUserStmt(db) {
  if (!_isActiveUserStmt) {
    _isActiveUserStmt = db.prepare('SELECT 1 FROM users WHERE id = ? AND is_active = 1');
  }
  return _isActiveUserStmt;
}

/**
 * Check that a user ID exists and is active.
 * Used to validate assigned_to / owner_id / user_id before writing.
 * @param {import('better-sqlite3').Database} db
 * @param {number|null} userId
 * @returns {boolean}
 */
function isActiveUser(db, userId) {
  if (userId == null) {
    return false;
  }
  const row = _getIsActiveUserStmt(db).get(userId);
  return !!row;
}

// Cached prepared statements for recalcProjectProgress — called on every task CRUD
// and staff deactivation. Module-level cache (safe because the app uses a single db instance).
let _progressSelectStmt = null;
let _progressUpdateStmt = null;
function _getProgressSelectStmt(db) {
  if (!_progressSelectStmt) {
    _progressSelectStmt = db.prepare(
      "SELECT COUNT(*) as total, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done FROM project_tasks WHERE project_id = ?"
    );
  }
  return _progressSelectStmt;
}
function _getProgressUpdateStmt(db) {
  if (!_progressUpdateStmt) {
    _progressUpdateStmt = db.prepare("UPDATE projects SET progress = ?, updated_at = datetime('now') WHERE id = ?");
  }
  return _progressUpdateStmt;
}

/**
 * Recalculate and persist project progress from task completion ratio.
 * Shared between projects.js (task CRUD) and staff.js (deactivation unassign).
 * @param {import('better-sqlite3').Database} db
 * @param {number} projectId
 */
function recalcProjectProgress(db, projectId) {
  if (!Number.isInteger(projectId) || projectId <= 0) {
    return;
  }
  const row = _getProgressSelectStmt(db).get(projectId);
  if (!row) {
    return;
  }
  const progress = row.total > 0 ? Math.round((row.done / row.total) * 100) : 0;
  _getProgressUpdateStmt(db).run(progress, projectId);
}

/**
 * Resolve an optional text field on update: preserve the existing value when
 * the field is ABSENT from the request (partial submission). An empty submitted
 * value CLEARS the field (null), consistent with the create route.
 * When present and non-empty, the value is truncated to maxLen (if provided).
 * Extracted to eliminate the repeated raw !== undefined ? ... pattern across
 * vendors.js and licenses.js. Rejects arrays from HTTP parameter pollution
 * so a polluted payload fails closed instead of silently corrupting data.
 * @param {*} rawValue - the raw req.body[field] value (NOT collapsed by safeQueryValue)
 * @param {string|null} processedValue - the already-processed value or null
 * @param {number|null} maxLen - max string length to truncate to, or null
 * @param {*} existingValue - the current value from the DB
 * @returns {*|{error: boolean}|null}
 */
function resolveOptionalField(rawValue, processedValue, maxLen, existingValue) {
  if (rawValue === undefined || rawValue === null) {
    return existingValue;
  }
  if (Array.isArray(rawValue)) {
    return { error: true };
  }
  if (processedValue !== null && processedValue !== '') {
    // Guard against non-string processedValues (e.g. a numeric form field that
    // bypassed trim/safeQueryValue). Calling .substring on a non-string would
    // throw at runtime. Coerce to string so truncation is safe — callers that
    // need strict typing should validate upstream before reaching this helper.
    const str = typeof processedValue === 'string' ? processedValue : String(processedValue);
    return maxLen ? str.substring(0, maxLen) : str;
  }
  return null;
}

// Cached prepared statement for getActiveStaff — called on every list/form route.
// Module-level cache (safe because the app uses a single db instance).
let _activeStaffStmt = null;
function _getActiveStaffStmt(db) {
  if (!_activeStaffStmt) {
    _activeStaffStmt = db.prepare('SELECT id, first_name, last_name FROM users WHERE is_active = 1 ORDER BY first_name');
  }
  return _activeStaffStmt;
}

// TTL cache for getActiveStaff to avoid a DB query on every list/form request.
// Invalidation is handled by calling resetCachedStatements in route modules on write.
let _activeStaffCache = null;
let _activeStaffCacheTime = 0;
const ACTIVE_STAFF_CACHE_MS = 30_000; // 30 seconds

/**
 * Fetch active staff list (id, first_name, last_name).
 * Centralized to avoid repeating the same query across routes.
 * Results are cached for 30 seconds and invalidated on write operations.
 * @param {import('better-sqlite3').Database} db
 * @returns {Array<{id: number, first_name: string, last_name: string}>}
 */
function getActiveStaff(db) {
  const now = Date.now();
  if (_activeStaffCache && (now - _activeStaffCacheTime) < ACTIVE_STAFF_CACHE_MS) {
    return _activeStaffCache;
  }
  _activeStaffCache = _getActiveStaffStmt(db).all();
  _activeStaffCacheTime = now;
  return _activeStaffCache;
}

// Cached prepared statement for ensureAssigneeInList — fetches a single user's
// dropdown columns so a deactivated assignee/owner can still be shown as
// "selected" in edit forms. Module-level cache (single db instance).
let _assigneeByIdStmt = null;
function _getAssigneeByIdStmt(db) {
  if (!_assigneeByIdStmt) {
    _assigneeByIdStmt = db.prepare('SELECT id, first_name, last_name FROM users WHERE id = ?');
  }
  return _assigneeByIdStmt;
}

/**
 * Ensure the resource's current assignee/owner appears in the active-staff
 * dropdown even when they have since been deactivated (is_active = 0).
 * getActiveStaff() only returns active users, so without this an edit form
 * would render a <select> with no matching option — the browser silently falls
 * back to the first option ("Unassigned") and re-saving wipes the stored
 * assignment (data loss). Returns a new array (does not mutate the input); a
 * null/unknown assignee id returns the input unchanged. Mirrors
 * ensureLinkedAssetInList in tickets.js.
 * @param {Array} staff - active staff list from getActiveStaff(db)
 * @param {number|null} currentAssigneeId - the resource's stored assigned_to/owner_id
 * @param {import('better-sqlite3').Database} db
 * @returns {Array}
 */
function ensureAssigneeInList(staff, currentAssigneeId, db) {
  if (currentAssigneeId == null) {
    return staff;
  }
  const cid = Number(currentAssigneeId);
  if (staff.some(s => Number(s.id) === cid)) {
    return staff;
  }
  const assignee = _getAssigneeByIdStmt(db).get(cid);
  return assignee ? [assignee, ...staff] : staff;
}

// Cached prepared statements for pruneAuditLog — called on every startup.
let _pruneCutoffStmt = null;
let _pruneDeleteStmt = null;

/**
 * Prune old audit log entries beyond the retention period.
 * Call on startup (if PRUNE_AUDIT_DAYS is set) or from a scheduled job.
 * @param {import('better-sqlite3').Database} db
 * @param {number} retentionDays — delete entries older than this many days
 * @returns {number} number of rows deleted
 */
function pruneAuditLog(db, retentionDays) {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    return 0;
  }
  if (!_pruneCutoffStmt) {
    _pruneCutoffStmt = db.prepare("SELECT datetime('now', ? || ' days') AS cutoff");
  }
  if (!_pruneDeleteStmt) {
    _pruneDeleteStmt = db.prepare('DELETE FROM audit_log WHERE created_at < ?');
  }
  const cutoff = _pruneCutoffStmt.get(`-${retentionDays}`).cutoff;
  const result = _pruneDeleteStmt.run(cutoff);
  return result.changes;
}

/**
 * Create a function that prunes audit log entries on a schedule. Tracks whether
 * the first run has completed so the "initial prune failed" warning is emitted
 * only when the first run actually throws — previously the warning fired on
 * every startup whenever PRUNE_AUDIT_DAYS was set, even when the startup prune
 * succeeded (the interval handle was not yet assigned when the startup run
 * executed, so `!intervalHandle` was always true on the first call). Subsequent
 * interval runs that fail log only an error; the warning is first-run-only.
 * @param {Function} pruneFn - `(retentionDays) => number of rows deleted`
 * @param {Object} [opts]
 * @param {number} [opts.days] - retention period in days (non-finite or <=0 disables pruning)
 * @param {Object} [opts.logger] - logger with `log`/`error`/`warn`; defaults to console
 * @returns {Function}
 */
function createAuditLogPruner(pruneFn, { days, logger = console } = {}) {
  let firstRunDone = false;
  return function runAuditPrune() {
    if (!Number.isFinite(days) || days <= 0) {
      return;
    }
    try {
      const pruned = pruneFn(days);
      if (pruned > 0) {
        logger.log(`Pruned ${pruned} audit log entries older than ${days} days`);
      }
    } catch (err) {
      logger.error('Audit log pruning error:', err.message);
      if (!firstRunDone) {
        logger.warn('Initial audit log prune failed — will retry on next interval');
      }
    }
    firstRunDone = true;
  };
}

/**
 * Title-case a string: replace underscores with spaces and capitalize each word.
 * Centralized helper to avoid repeating the regex pattern across templates.
 * Handles null/undefined gracefully.
 * @param {*} value
 * @returns {string}
 */
function titleCase(value) {
  if (!value || typeof value !== 'string') {
    return '';
  }
  return value.replace(/_/g, ' ').replace(/\b\w+/g, word => {
    const upper = word.toUpperCase();
    if (ACRONYMS.has(upper)) {
      return upper;
    }
    // Detect acronym with suffix (e.g. "SOPs", "APIv2", "IPs").
    // Check that the next character in the ORIGINAL word is not uppercase,
    // otherwise a word like "SOPHISTICATED" would be incorrectly split
    // into "SOP" + "HISTICATED".
    for (let i = Math.min(upper.length, _MAX_ACRONYM_LENGTH); i >= 1; i--) {
      const prefix = upper.slice(0, i);
      if (ACRONYMS.has(prefix)) {
        const next = word[i];
        // Guard against end-of-string (undefined) and uppercase continuation
        // (e.g. "SOPHISTICATED" should not match acronym "SOP").
        if (next !== undefined && next >= 'A' && next <= 'Z') {
          continue;
        }
        if (word === word.toLowerCase() && word.length - i > 2) {
          continue;
        }
        return prefix + word.slice(i);
      }
    }
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  });
}

/**
 * Async route handler wrapper to automatically catch errors and pass to Express error handler.
 * Eliminates try/catch boilerplate in route handlers.
 * @param {Function} fn - Async route handler function
 * @returns {Function} Express middleware function
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    try {
      Promise.resolve(fn(req, res, next)).catch(next);
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Calculate the number of days between today and a date string (YYYY-MM-DD).
 * Negative means the date is in the past. Returns null for invalid input.
 */
function daysUntil(dateStr) {
  const d = localDate(dateStr);
  if (!d) {
    return null;
  }
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((d - today) / (1000 * 60 * 60 * 24));
}

/**
 * Calculate seat/license usage as a percentage (0-100).
 * Returns 0 when total is 0 or invalid.
 */
function usagePercent(used, total) {
  const u = Number(used);
  const t = Number(total);
  if (!Number.isFinite(t) || t <= 0) {
    return 0;
  }
  if (!Number.isFinite(u) || u < 0) {
    return 0;
  }
  return Math.min(100, Math.round((u / t) * 100));
}

/**
 * Check if a date string is within N days from today.
 * Returns false for invalid input.
 */
function isExpiringSoon(dateStr, withinDays = 30) {
  const d = daysUntil(dateStr);
  return d !== null && d >= 0 && d <= withinDays;
}

/**
 * Touch a key in a Map for LRU eviction.
 * Deletes and re-inserts the entry so it moves to the end of the
 * Map's insertion-order iteration. If the cache has reached its
 * capacity, evicts the oldest (least recently accessed) entry.
 * Calls prepareFn BEFORE evicting so that if it throws the cache is
 * not left one entry short.
 */
function _touchCache(cache, key, maxSize, prepareFn) {
  let stmt = cache.get(key);
  if (stmt) {
    cache.delete(key);
    cache.set(key, stmt);
  } else {
    stmt = prepareFn();
    if (cache.size >= maxSize) {
      const keyToEvict = cache.keys().next().value;
      // keyToEvict is always defined here because cache.size >= maxSize > 0
      // guarantees the Map is non-empty. This mirrors the unreachable
      // undefined-guard pattern removed from safeInt and localDate in prior
      // review passes — the branch could never fire with valid maxSize values.
      cache.delete(keyToEvict);
    }
    cache.set(key, stmt);
  }
  return stmt;
}

const _countQueryCache = new Map();
const _COUNT_CACHE_MAX = 500;
const _SAFE_TABLE_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
function countQuery(db, baseTable, alias, whereClause, params) {
  if (!_SAFE_TABLE_RE.test(baseTable)) {
    throw new Error(`Invalid table name: ${baseTable}`);
  }
  const safeAlias = alias ? ` ${quoteColumn(alias)}` : '';
  const key = `${baseTable}|${alias}|${whereClause}`;
  const stmt = _touchCache(_countQueryCache, key, _COUNT_CACHE_MAX, () => {
    return db.prepare(`SELECT COUNT(*) as c FROM ${baseTable}${safeAlias} WHERE ${whereClause}`);
  });
  try {
    const result = stmt.get(...params);
    return result ? result.c : 0;
  } catch (err) {
    _countQueryCache.delete(key);
    throw err;
  }
}

// Cached prepared statements for selectQuery (paginated list routes).
// The list SQL is built from validated/whitelisted fragments (filters, sort),
// so the resulting string is deterministic and safe to use as a cache key.
// As with countQuery, caching the Statement avoids recompiling the SQL via
// db.prepare() on every request. Cap the cache with LRU eviction to bound
// memory across unbounded filter/sort combinations.
const _selectQueryCache = new Map();
const _SELECT_CACHE_MAX = 500;
function selectQuery(db, sql, params) {
  const stmt = _touchCache(_selectQueryCache, sql, _SELECT_CACHE_MAX, () => {
    return db.prepare(sql);
  });
  try {
    return stmt.all(...params);
  } catch (err) {
    _selectQueryCache.delete(sql);
    throw err;
  }
}

/**
 * Parse a checkbox/flag form value into a strict boolean (0/1) for SQLite
 * INTEGER columns (is_internal, is_featured, etc.).
 *
 * Only the canonical "checked" strings ('1', 'true', 'on') map to 1. Any other
 * value — including non-empty strings like 'false', 'off', 'no' — maps to 0.
 * This prevents a form/API value of `is_internal=false` from being coerced
 * truthy (the previous `(x && x !== '0')` idiom treated any other string as 1).
 * Absent/empty values are left to the caller (they must decide whether to
 * preserve an existing value or default to 0), so they are coerced to 0 here.
 * @param {*} value
 * @param {boolean} [privileged=true] - gate caller-supplied flags (e.g. an
 *   internal comment flag) behind a privilege check before allowing 1.
 * @returns {0|1}
 */
function parseBooleanFlag(value, allowSet = true) {
  // When allowSet is false the caller is unprivileged — reject ALL inputs
  // (including '1') so that privilege checks gate the ability to set the flag.
  if (!allowSet) {
    return 0;
  }
  return (value === '1' || value === 'true' || value === 'on') ? 1 : 0;
}

/**
 * Determine whether the client prefers a JSON response over HTML.
 * Uses Express content negotiation directly: req.accepts returns the preferred
 * type ('json' or 'html') when both are acceptable, or the single matching type
 * when only one is acceptable. This is the correct idiom — a client sending the
 * wildcard Accept header (fetch/XHR/browsers) negotiates to 'json' when json is
 * offered, whereas the fragile check `req.accepts('html') === false && req.accepts('json')`
 * wrongly returned false under a wildcard Accept header and served HTML error
 * pages to AJAX callers.
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function prefersJson(req) {
  return Boolean(req && typeof req.accepts === 'function') && req.accepts(['json', 'html']) === 'json';
}

/**
 * Check if a user has admin or manager privileges.
 * Centralizes the repeated role-check pattern across routes.
 * @param {Object} user - Session user object with a `role` property
 * @returns {boolean}
 */
function isPrivileged(user) {
  return user != null && (user.role === 'admin' || user.role === 'manager');
}

/**
 * Map a value to a badge severity class using a whitelist mapping.
 * Falls back to the value itself if not found in the mapping.
 * Used in EJS templates to keep badge severity logic DRY.
 */
function badgeClass(value, mapping) {
  return (mapping && Object.hasOwn(mapping, value)) ? mapping[value] : value;
}

/**
 * Normalize an Express req.ip value: strip the IPv6-mapped ::ffff: prefix
 * (produced behind proxies) and fall back to 'unknown' when the value is
 * absent, non-string, or an array (HPP on X-Forwarded-For). Consistent
 * across audit.js, auth.js, and any future caller.
 * @param {*} ip
 * @returns {string}
 */
function normalizeIp(ip) {
  if (!ip || typeof ip !== 'string') {
    return 'unknown';
  }
  if (ip.startsWith('::ffff:')) {
    return ip.slice(7);
  }
  return ip;
}

/**
 * Reset module-level cached prepared statements (test use only).
 * Ensures test isolation when using mock db instances.
 */
function resetCachedStatements() {
  _isActiveUserStmt = null;
  _progressSelectStmt = null;
  _progressUpdateStmt = null;
  _activeStaffStmt = null;
  _activeStaffCache = null;
  _activeStaffCacheTime = 0;
  _assigneeByIdStmt = null;
  _pruneCutoffStmt = null;
  _pruneDeleteStmt = null;
  _countQueryCache.clear();
  _selectQueryCache.clear();
  _resetPageSize();
}

/**
 * Derive PAGE_SIZE from environment (testable helper).
 * Returns the effective page size (shared between module init and resetPageSize).
 * Logs a warning if PAGE_SIZE is set but invalid (non-finite or non-positive),
 * so operators notice misconfiguration rather than silently falling back to
 * the default. Values that exceed MAX_PAGE_SIZE are clamped without warning.
 */
function _derivePageSize() {
  const raw = process.env.PAGE_SIZE;
  const p = parseInt(raw, 10);
  if (raw !== undefined && raw !== '' && (!Number.isFinite(p) || p <= 0)) {
    console.warn(
      `WARNING: Invalid PAGE_SIZE "${raw}" — must be a positive integer. Using default ${DEFAULT_PAGE_SIZE}.`
    );
  }
  const env = (Number.isFinite(p) && p > 0) ? Math.min(p, MAX_PAGE_SIZE) : null;
  return env || DEFAULT_PAGE_SIZE;
}

/**
 * Reset the env-derived PAGE_SIZE (test use only).
 * Called by resetCachedStatements(), but also exported separately so tests
 * that change process.env.PAGE_SIZE can re-derive it without clearing all
 * cached prepared statements.
 */
function _resetPageSize() {
  PAGE_SIZE = _derivePageSize();
}
// Initialize PAGE_SIZE at module load
PAGE_SIZE = _derivePageSize();
// Public alias so tests can call it directly.
const resetPageSize = _resetPageSize;

/**
 * Reject HTTP parameter pollution (HPP) array payloads on a list of fields.
 * Returns an array of error messages for fields that were arrays, or an empty
 * array when all fields are clean. Mirrors the inline array-rejection loops
 * used across every write route in the codebase, but centralises the pattern
 * so new routes can call this helper instead of repeating the for-loop.
 *
 * Both req.body and req.query are inspected. The query side matters because
 * the app uses Express's built-in "simple" querystring parser, which turns
 * duplicate keys (?action=a&action=b) into arrays — so list routes that read
 * filter params (e.g. /audit) need the same fail-closed rejection as the write
 * routes. Write routes also benefit: a duplicate query key that happens to
 * collide with a body field name is now rejected instead of silently ignored.
 * @param {import('express').Request} req
 * @param {string[]} fields - Field names to check in req.body and req.query
 * @returns {string[]} Array of error messages (empty if all clean)
 */
function rejectHppArrays(req, fields) {
  // req.body may be undefined (e.g. GET requests that never ran urlencoded,
  // or handlers invoked directly in tests) — skip missing sources rather than
  // throwing, so the query side is still checked.
  const sources = [req.body, req.query];
  for (const source of sources) {
    if (!source) {
      continue;
    }
    for (const f of fields) {
      if (Array.isArray(source[f])) {
        return ['Invalid request parameters'];
      }
    }
  }
  return [];
}

module.exports = {
  paginate, paginationBaseUrl, safeSort, buildFilters, addSearch,
  safeId, isPresentInvalidId, safePositiveFloat, safeInt, safePositiveInt,
  validatePassword, isValidUsername, isValidEmail, isValidUrl,
  sanitizePhone, isValidPhone, isValidDate, isValidDateTimeLocal,
  safeDate, safeDateTimeLocal, trim, localDate, formatDate, formatDateTime,
  daysUntil, usagePercent, isExpiringSoon, titleCase,
  getActiveStaff, isActiveUser, recalcProjectProgress, pruneAuditLog,
  createAuditLogPruner,
  ensureAssigneeInList,
  asyncHandler, countQuery, selectQuery,
  isPrivileged, badgeClass, quoteColumn, safeQueryValue, safeFilters,
  isValidAssetTag, escapeHtml, prefersJson, parseBooleanFlag,
  CONDITION_BADGE, CHANGE_TYPE_BADGE, ROLE_BADGE,
  resetCachedStatements, resetPageSize,
  rejectHppArrays, normalizeIp,
  // Exported for unit testing only — mirrors the pattern used by route modules
  // that expose internal helpers (e.g. _resolveDateTimeField in changes.js).
  _touchCache,
  // Shared across vendors.js and licenses.js for absent-vs-empty partial-update
  // resolution; also tested directly in utils.test.js for regression coverage.
  resolveOptionalField
};
