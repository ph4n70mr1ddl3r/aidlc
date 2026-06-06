/**
 * Shared utilities for routes
 */

const DEFAULT_PAGE_SIZE = 25;

/**
 * Parse pagination params from query string
 */
function paginate(req) {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || DEFAULT_PAGE_SIZE));
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
  return allowedMap[value] || allowedMap[defaultKey];
}

/**
 * Build WHERE clause safely from whitelisted filters
 * @param {Object} filters - { column: { value, operator? } }
 * @returns {{ where: string[], params: any[] }}
 */
function buildFilters(filters) {
  const where = [];
  const params = [];
  for (const [column, config] of Object.entries(filters)) {
    if (config.value === undefined || config.value === null || config.value === '') continue;
    const op = config.operator || '=';
    where.push(`${column} ${op} ?`);
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
 * Add LIKE search conditions safely
 */
function addSearch(where, params, search, columns) {
  if (!search) return;
  const raw = String(search);
  // Escape SQL LIKE wildcards
  const escaped = raw.replace(/%/g, '\\%').replace(/_/g, '\\_');
  const term = `%${escaped}%`;
  const conditions = columns.map(c => `${c} LIKE ? ESCAPE '\\'`);
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
 * Safely parse a numeric form field, returning `fallback` for NaN / non-finite.
 * @param {*} value
 * @param {number} [fallback=0]
 * @returns {number}
 */
function safeFloat(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Safely parse a numeric form field, returning `fallback` for NaN / non-finite / negative.
 * Use for monetary values that should be non-negative.
 * @param {*} value
 * @param {number|null} [fallback=null]
 * @returns {number|null}
 */
function safePositiveFloat(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = parseFloat(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

/**
 * Safely parse an integer form field, returning `fallback` for NaN.
 */
function safeInt(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Validate a URL (http/https only). Returns true if valid.
 */
function isValidUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Validate a date string in YYYY-MM-DD format.
 * Returns true if valid.
 */
function isValidDate(value) {
  if (!value || typeof value !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + 'T00:00:00');
  return !isNaN(d.getTime());
}

/**
 * Validate a datetime string in YYYY-MM-DDTHH:MM format (from datetime-local input).
 * Returns true if valid.
 */
function isValidDateTimeLocal(value) {
  if (!value || typeof value !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return false;
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
  return isValidDateTimeLocal(value) ? value : null;
}

/**
 * Trim a string value from req.body. Returns '' for non-strings.
 */
function trim(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Safely encode a value for embedding in a <script> tag as JSON.
 * JSON.stringify handles quotes/escapes but does NOT escape </script>.
 */
function jsonScriptSafe(value) {
  return JSON.stringify(value).replace(/<\/script/gi, '<\\/script');
}

// Cached prepared statement for isActiveUser — called on almost every write route.
const _isActiveUserStmt = new WeakMap();
function _getIsActiveUserStmt(db) {
  let stmt = _isActiveUserStmt.get(db);
  if (!stmt) {
    stmt = db.prepare('SELECT 1 FROM users WHERE id = ? AND is_active = 1');
    _isActiveUserStmt.set(db, stmt);
  }
  return stmt;
}

/**
 * Check that a user ID exists and is active.
 * Used to validate assigned_to / owner_id / user_id before writing.
 * @param {import('better-sqlite3').Database} db
 * @param {number|null} userId
 * @returns {boolean}
 */
function isActiveUser(db, userId) {
  if (!userId) return false;
  const row = _getIsActiveUserStmt(db).get(userId);
  return !!row;
}

/**
 * Recalculate and persist project progress from task completion ratio.
 * Shared between projects.js (task CRUD) and staff.js (deactivation unassign).
 * @param {import('better-sqlite3').Database} db
 * @param {number} projectId
 */
function recalcProjectProgress(db, projectId) {
  const row = db.prepare(
    "SELECT COUNT(*) as total, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done FROM project_tasks WHERE project_id = ?"
  ).get(projectId);
  const progress = row.total > 0 ? Math.round((row.done / row.total) * 100) : 0;
  db.prepare("UPDATE projects SET progress = ?, updated_at = datetime('now') WHERE id = ?").run(progress, projectId);
}

// Cached prepared statement for getActiveStaff — called on every list/form route.
const _getActiveStaffStmt = new WeakMap();
function _getGetActiveStaffStmt(db) {
  let stmt = _getActiveStaffStmt.get(db);
  if (!stmt) {
    stmt = db.prepare('SELECT id, first_name, last_name FROM users WHERE is_active = 1 ORDER BY first_name');
    _getActiveStaffStmt.set(db, stmt);
  }
  return stmt;
}

/**
 * Fetch active staff list (id, first_name, last_name).
 * Centralized to avoid repeating the same query across routes.
 * @param {import('better-sqlite3').Database} db
 * @returns {Array<{id: number, first_name: string, last_name: string}>}
 */
function getActiveStaff(db) {
  return _getGetActiveStaffStmt(db).all();
}

/**
 * Prune old audit log entries beyond the retention period.
 * Call on startup (if PRUNE_AUDIT_DAYS is set) or from a scheduled job.
 * @param {import('better-sqlite3').Database} db
 * @param {number} retentionDays — delete entries older than this many days
 * @returns {number} number of rows deleted
 */
function pruneAuditLog(db, retentionDays) {
  const result = db.prepare(
    "DELETE FROM audit_log WHERE created_at < datetime('now', '-' || ? || ' days')"
  ).run(retentionDays);
  return result.changes;
}

module.exports = { paginate, paginationBaseUrl, safeSort, buildFilters, addSearch, safeId, safeFloat, safePositiveFloat, safeInt, validatePassword, isValidUsername, isValidEmail, isValidUrl, isValidDate, isValidDateTimeLocal, safeDate, safeDateTimeLocal, trim, jsonScriptSafe, getActiveStaff, isActiveUser, recalcProjectProgress, pruneAuditLog, DEFAULT_PAGE_SIZE };
