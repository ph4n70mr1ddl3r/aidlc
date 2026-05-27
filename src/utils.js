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
 * Add LIKE search conditions safely
 */
function addSearch(where, params, search, columns) {
  if (!search) return;
  const term = `%${search}%`;
  const conditions = columns.map(c => `${c} LIKE ?`);
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
 * Safely parse an integer form field, returning `fallback` for NaN.
 */
function safeInt(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

module.exports = { paginate, paginationBaseUrl, safeSort, buildFilters, addSearch, safeId, safeFloat, safeInt, DEFAULT_PAGE_SIZE };
