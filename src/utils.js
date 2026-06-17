/**
 * Shared utilities for routes
 */

const DEFAULT_PAGE_SIZE = 25;

/**
 * Parse pagination params from query string
 */
function paginate(req) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || DEFAULT_PAGE_SIZE));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

/**
 * Build a base URL for pagination links (strips `page` param from query)
 */
function paginationBaseUrl(req) {
  const q = { ...req.query };
  delete q.page;
  const qs = new URLSearchParams(q).toString();
  return req.path + (qs ? '?' + qs : '');
}

/**
 * Whitelisted sort options to prevent SQL injection
 */
function safeSort(value, allowedMap, defaultKey) {
  return Object.prototype.hasOwnProperty.call(allowedMap, value) ? allowedMap[value] : allowedMap[defaultKey];
}

/**
 * Quote a column name that may include a table alias (e.g. "t"."status").
 * Splitting on '.' and quoting each part ensures SQLite resolves it correctly.
 * @param {string} col
 * @returns {string}
 */
function quoteColumn(col) {
  return col.split('.').map(p => `"${p}"`).join('.');
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
  if (!password || password.length < 12) {
    return 'Password must be at least 12 characters';
  }
  if (password.length > 128) {
    return 'Password must be at most 128 characters';
  }
  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
    return 'Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character';
  }
  return null;
}

/**
 * Validate that a string is a safe username (alphanumeric, dashes, underscores, dots).
 * Returns true if valid.
 */
function isValidUsername(username) {
  return typeof username === 'string' && /^[a-zA-Z0-9._-]{2,50}$/.test(username);
}

/**
 * Validate basic email format. Returns true if valid.
 */
function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 200;
}

/**
 * Add LIKE search conditions safely.
 * Column names are validated against a safe pattern to prevent SQL injection.
 * @param {string[]} columns - List of column names to search (must be non-empty)
 */
function addSearch(where, params, search, columns) {
  if (!search) {
    return;
  }
  if (!columns || !Array.isArray(columns) || columns.length === 0) {
    throw new Error('columns is required for addSearch');
  }
  // Validate column names — only allow identifiers with letters, digits, underscores, and dots (for table aliases).
  const SAFE_COLUMN_RE = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?$/;
  for (const c of columns) {
    if (!SAFE_COLUMN_RE.test(c)) {
      throw new Error(`Invalid column name in addSearch: ${c}`);
    }
  }
  const raw = String(search);
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
 * Returns null if invalid
 */
function safeId(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
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
  const n = parseFloat(value);
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
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
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

/**
 * Sanitize a phone number: keep only digits, +, -, (, ), spaces.
 * Returns sanitized string or null if input is empty.
 */
function sanitizePhone(phone) {
  if (!phone || typeof phone !== 'string') {
    return null;
  }
  const sanitized = phone.replace(/[^\d+\-()\s]/g, '').trim();
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
  const d = new Date(value + 'T00:00:00');
  return !isNaN(d.getTime()) &&
    d.getFullYear() === parseInt(m[1], 10) &&
    d.getMonth() === parseInt(m[2], 10) - 1 &&
    d.getDate() === parseInt(m[3], 10);
}

/**
 * Validate a datetime string in YYYY-MM-DDTHH:MM format (from datetime-local input).
 * Returns true if valid.
 */
function isValidDateTimeLocal(value) {
  if (!value || typeof value !== 'string') {
    return false;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) {
    return false;
  }
  const d = new Date(value);
  return !isNaN(d.getTime());
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
  return isValidDateTimeLocal(value) ? value.replace('T', ' ') : null;
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
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.slice(0, 10)) && value.length <= 10) {
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
  const d = new Date(value);
  return isNaN(d.getTime()) ? '-' : d.toLocaleString();
}

/**
 * Safely encode a value for embedding in a <script> tag as JSON.
 * JSON.stringify handles quotes/escapes but does NOT escape </script>.
 */
function jsonScriptSafe(value) {
  return JSON.stringify(value).replace(/<\/script/gi, '<\\/script');
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
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) {
    return null;
  }
  const d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
  return isNaN(d.getTime()) ? null : d;
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
  if (!userId) {
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
  const row = _getProgressSelectStmt(db).get(projectId);
  const progress = row.total > 0 ? Math.round((row.done / row.total) * 100) : 0;
  _getProgressUpdateStmt(db).run(progress, projectId);
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

/**
 * Fetch active staff list (id, first_name, last_name).
 * Centralized to avoid repeating the same query across routes.
 * @param {import('better-sqlite3').Database} db
 * @returns {Array<{id: number, first_name: string, last_name: string}>}
 */
function getActiveStaff(db) {
  return _getActiveStaffStmt(db).all();
}

/**
 * Prune old audit log entries beyond the retention period.
 * Call on startup (if PRUNE_AUDIT_DAYS is set) or from a scheduled job.
 * @param {import('better-sqlite3').Database} db
 * @param {number} retentionDays — delete entries older than this many days
 * @returns {number} number of rows deleted
 */
function pruneAuditLog(db, retentionDays) {
  const cutoff = db.prepare("SELECT datetime('now', ? || ' days') AS cutoff").get(`-${retentionDays}`).cutoff;
  const result = db.prepare(
    'DELETE FROM audit_log WHERE created_at < ?'
  ).run(cutoff);
  return result.changes;
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
  const ACRONYMS = new Set(['SOP', 'FAQ', 'SLA', 'VPN', 'IP', 'MFA', 'HVAC', 'CDN', 'API', 'DNS', 'SSL', 'SSH', 'LDAP', 'DHCP', 'NAT']);
  return value.replace(/_/g, ' ').replace(/\b\w+/g, word => {
    const upper = word.toUpperCase();
    if (ACRONYMS.has(upper)) {
      return upper;
    }
    // Detect acronym with suffix (e.g. "SOPs", "APIv2", "IPs").
    // Check that the next character in the ORIGINAL word is not uppercase,
    // otherwise a word like "SOPHISTICATED" would be incorrectly split
    // into "SOP" + "HISTICATED".
    for (let i = Math.min(upper.length - 1, 4); i >= 1; i--) {
      const prefix = upper.slice(0, i);
      if (ACRONYMS.has(prefix)) {
        const next = word[i];
        if (next >= 'A' && next <= 'Z') {
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
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// Cached prepared statements for countQuery — one per base table + where combination.
// better-sqlite3 caches prepared statements internally, but this avoids the
// overhead of string-concatenating the SQL and calling prepare() on every request.
const _countQueryCache = new Map();
const _COUNT_CACHE_MAX = 500;
const _SAFE_TABLE_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
function countQuery(db, baseTable, alias, whereClause, params) {
  if (!_SAFE_TABLE_RE.test(baseTable)) {
    throw new Error(`Invalid table name: ${baseTable}`);
  }
  const safeAlias = alias ? ` ${quoteColumn(alias)}` : '';
  const key = `${baseTable}|${alias}|${whereClause}`;
  let stmt = _countQueryCache.get(key);
  if (stmt) {
    // Re-insert to update insertion order (true LRU)
    _countQueryCache.delete(key);
    _countQueryCache.set(key, stmt);
  } else {
    if (_countQueryCache.size >= _COUNT_CACHE_MAX) {
      const oldestKey = _countQueryCache.keys().next().value;
      if (oldestKey !== undefined) {
        _countQueryCache.delete(oldestKey);
      }
    }
    stmt = db.prepare(`SELECT COUNT(*) as c FROM ${baseTable}${safeAlias} WHERE ${whereClause}`);
    _countQueryCache.set(key, stmt);
  }
  return stmt.get(...params).c;
}

/**
 * Check if a user has admin or manager privileges.
 * Centralizes the repeated role-check pattern across routes.
 * @param {Object} user - Session user object with a `role` property
 * @returns {boolean}
 */
function isPrivileged(user) {
  return user && (user.role === 'admin' || user.role === 'manager');
}

module.exports = { paginate, paginationBaseUrl, safeSort, buildFilters, addSearch, safeId, safePositiveFloat, safeInt, validatePassword, isValidUsername, isValidEmail, isValidUrl, sanitizePhone, isValidPhone, isValidDate, isValidDateTimeLocal, safeDate, safeDateTimeLocal, trim, jsonScriptSafe, localDate, formatDate, formatDateTime, titleCase, getActiveStaff, isActiveUser, recalcProjectProgress, pruneAuditLog, asyncHandler, countQuery, isPrivileged };
