const { describe, it, expect } = require('@jest/globals');

const utils = require('../src/utils');

/**
 * Test for paginate function
 */
describe('paginate', () => {
  it('should return default values when no query params provided', () => {
    const req = { query: {}, path: '/test' };
    const result = utils.paginate(req);
    expect(result.page).toBe(1);
    expect(result.limit).toBe(25);
    expect(result.offset).toBe(0);
  });

  it('should parse page and limit from query', () => {
    const req = { query: { page: '2', limit: '10' }, path: '/test' };
    const result = utils.paginate(req);
    expect(result.page).toBe(2);
    expect(result.limit).toBe(10);
    expect(result.offset).toBe(10);
  });

  it('should handle page as 1 when less than 1', () => {
    const req = { query: { page: '0', limit: '10' }, path: '/test' };
    const result = utils.paginate(req);
    expect(result.page).toBe(1);
  });

  it('should cap limit at 100', () => {
    const req = { query: { page: '1', limit: '200' }, path: '/test' };
    const result = utils.paginate(req);
    expect(result.limit).toBe(100);
  });
});

/**
 * Test for paginationBaseUrl function
 */
describe('paginationBaseUrl', () => {
  it('should strip page param from query string', () => {
    const req = {
      query: { page: '2', filter: 'active', sort: 'name' },
      path: '/users'
    };
    const result = utils.paginationBaseUrl(req);
    expect(result).toBe('/users?filter=active&sort=name');
  });

  it('should return path without query when no params left', () => {
    const req = {
      query: { page: '1' },
      path: '/users'
    };
    const result = utils.paginationBaseUrl(req);
    expect(result).toBe('/users');
  });
});

/**
 * Test for safeSort function
 */
describe('safeSort', () => {
  it('should return mapped value when valid', () => {
    const allowedMap = { asc: 'first_name ASC', desc: 'first_name DESC' };
    const result = utils.safeSort('asc', allowedMap, 'desc');
    expect(result).toBe('first_name ASC');
  });

  it('should return default value when invalid', () => {
    const allowedMap = { asc: 'first_name ASC', desc: 'first_name DESC' };
    const result = utils.safeSort('invalid', allowedMap, 'desc');
    expect(result).toBe('first_name DESC');
  });

  it('should return first value when default is invalid', () => {
    const allowedMap = { asc: 'first_name ASC', desc: 'first_name DESC' };
    const result = utils.safeSort('invalid', allowedMap, 'invalid_default');
    expect(result).toBe('first_name ASC');
  });

  it('should throw for empty map', () => {
    const allowedMap = {};
    expect(() => utils.safeSort('asc', allowedMap, 'desc')).toThrow('safeSort: allowedMap must not be empty');
  });
});

/**
 * Test for quoteColumn function
 */
describe('quoteColumn', () => {
  it('should quote simple column name', () => {
    const result = utils.quoteColumn('name');
    expect(result).toBe('"name"');
  });

  it('should quote column with table alias', () => {
    const result = utils.quoteColumn('t.name');
    expect(result).toBe('"t"."name"');
  });

  it('should throw error for invalid column', () => {
    expect(() => utils.quoteColumn('')).toThrow('Invalid column name');
    expect(() => utils.quoteColumn(null)).toThrow('Invalid column name');
  });
});

/**
 * Test for buildFilters function
 */
describe('buildFilters', () => {
  it('should build simple filter', () => {
    const filters = { status: { value: 'active' } };
    const allowedColumns = ['status', 'name'];
    const result = utils.buildFilters(filters, allowedColumns);
    expect(result.where).toEqual(['"status" = ?']);
    expect(result.params).toEqual(['active']);
  });

  it('should skip null/undefined values', () => {
    const filters = { status: { value: null }, name: { value: 'test' } };
    const allowedColumns = ['status', 'name'];
    const result = utils.buildFilters(filters, allowedColumns);
    expect(result.where).toEqual(['"name" = ?']);
    expect(result.params).toEqual(['test']);
  });

  it('should skip invalid columns', () => {
    const filters = { status: { value: 'active' }, invalid: { value: 'test' } };
    const allowedColumns = ['status'];
    const result = utils.buildFilters(filters, allowedColumns);
    expect(result.where).toEqual(['"status" = ?']);
    expect(result.params).toEqual(['active']);
  });

  it('should support custom operators', () => {
    const filters = { count: { value: 5, operator: '>' } };
    const allowedColumns = ['count'];
    const result = utils.buildFilters(filters, allowedColumns);
    expect(result.where).toEqual(['"count" > ?']);
    expect(result.params).toEqual([5]);
  });

  it('should skip invalid operators', () => {
    const filters = { count: { value: 5, operator: 'INJECT' } };
    const allowedColumns = ['count'];
    const result = utils.buildFilters(filters, allowedColumns);
    expect(result.where).toEqual([]);
    expect(result.params).toEqual([]);
  });
});

/**
 * Test for validatePassword function
 */
describe('validatePassword', () => {
  it('should return error for short password', () => {
    const result = utils.validatePassword('short');
    expect(result).toContain('at least 12 characters');
  });

  it('should return error for long password', () => {
    const result = utils.validatePassword('a'.repeat(129));
    expect(result).toContain('at most 128 characters');
  });

  it('should return error for missing complexity', () => {
    const result = utils.validatePassword('password12345678');
    expect(result).toContain('uppercase letter');
  });

  it('should return null for valid password', () => {
    const result = utils.validatePassword('Valid@123456');
    expect(result).toBeNull();
  });
});

/**
 * Test for isValidUsername function
 */
describe('isValidUsername', () => {
  it('should validate correct username', () => {
    expect(utils.isValidUsername('john_doe')).toBe(true);
    expect(utils.isValidUsername('jane-doe')).toBe(true);
    expect(utils.isValidUsername('user.name')).toBe(true);
  });

  it('should reject invalid username', () => {
    expect(utils.isValidUsername('a'.repeat(51))).toBe(false);
    expect(utils.isValidUsername('user@name')).toBe(false);
  });
});

/**
 * Test for isValidEmail function
 */
describe('isValidEmail', () => {
  it('should validate correct email', () => {
    expect(utils.isValidEmail('test@example.com')).toBe(true);
    expect(utils.isValidEmail('user.name@domain.co')).toBe(true);
  });

  it('should reject invalid email', () => {
    expect(utils.isValidEmail('invalid')).toBe(false);
    expect(utils.isValidEmail('test@')).toBe(false);
  });
});

/**
 * Test for safeId function
 */
describe('safeId', () => {
  it('should parse valid positive integer', () => {
    expect(utils.safeId('123')).toBe(123);
    expect(utils.safeId(456)).toBe(456);
  });

  it('should return null for invalid values', () => {
    expect(utils.safeId('abc')).toBeNull();
    expect(utils.safeId('-1')).toBeNull();
    expect(utils.safeId('0')).toBeNull();
    expect(utils.safeId('')).toBeNull();
  });
});

/**
 * Test for safeInt function
 */
describe('safeInt', () => {
  it('should parse valid integer', () => {
    expect(utils.safeInt('123')).toBe(123);
    expect(utils.safeInt('0')).toBe(0);
  });

  it('should return fallback for invalid values', () => {
    expect(utils.safeInt('abc')).toBe(0);
    expect(utils.safeInt('')).toBe(0);
    expect(utils.safeInt(null)).toBe(0);
  });

  it('should reject float number inputs', () => {
    expect(utils.safeInt(1.5)).toBe(0);
    expect(utils.safeInt(1.5, -1)).toBe(-1);
  });

  it('should reject string arrays (parameter pollution)', () => {
    expect(utils.safeInt(['123'], 0)).toBe(0);
    expect(utils.safeInt(['123', '456'])).toBe(0);
  });

  it('should accept integer number inputs', () => {
    expect(utils.safeInt(42)).toBe(42);
    expect(utils.safeInt(0, 10)).toBe(0);
  });
});

/**
 * Test for isValidUrl function
 */
describe('isValidUrl', () => {
  it('should validate http/https URLs', () => {
    expect(utils.isValidUrl('http://example.com')).toBe(true);
    expect(utils.isValidUrl('https://example.com/path')).toBe(true);
  });

  it('should reject invalid URLs', () => {
    expect(utils.isValidUrl('ftp://example.com')).toBe(false);
    expect(utils.isValidUrl('not-a-url')).toBe(false);
    expect(utils.isValidUrl('')).toBe(false);
  });
});

/**
 * Test for isValidDate function
 */
describe('isValidDate', () => {
  it('should validate correct date format', () => {
    expect(utils.isValidDate('2024-01-15')).toBe(true);
    expect(utils.isValidDate('2023-12-31')).toBe(true);
  });

  it('should reject invalid dates', () => {
    expect(utils.isValidDate('2024-13-01')).toBe(false);
    expect(utils.isValidDate('2024-02-30')).toBe(false);
    expect(utils.isValidDate('not-a-date')).toBe(false);
  });

  it('should reject null/undefined/non-string', () => {
    expect(utils.isValidDate(null)).toBe(false);
    expect(utils.isValidDate(undefined)).toBe(false);
    expect(utils.isValidDate(12345)).toBe(false);
  });
});

/**
 * Test for trim function
 */
describe('trim', () => {
  it('should trim strings', () => {
    expect(utils.trim('  test  ')).toBe('test');
    expect(utils.trim('hello')).toBe('hello');
  });

  it('should return empty string for non-strings', () => {
    expect(utils.trim(null)).toBe('');
    expect(utils.trim(undefined)).toBe('');
    expect(utils.trim(123)).toBe('');
  });
});

/**
 * Test for titleCase function
 */
describe('titleCase', () => {
  it('should convert snake_case to title case', () => {
    expect(utils.titleCase('first_name')).toBe('First Name');
    expect(utils.titleCase('user_role')).toBe('User Role');
  });

  it('should preserve acronyms', () => {
    expect(utils.titleCase('sop_description')).toBe('SOP Description');
    expect(utils.titleCase('api_endpoint')).toBe('API Endpoint');
  });

  it('should handle null/undefined', () => {
    expect(utils.titleCase(null)).toBe('');
    expect(utils.titleCase(undefined)).toBe('');
  });

  it('should handle double underscores', () => {
    expect(utils.titleCase('first__name')).toBe('First  Name');
  });

  it('should handle non-string values', () => {
    expect(utils.titleCase(123)).toBe('');
    expect(utils.titleCase('')).toBe('');
  });
});

/**
 * Test for asyncHandler function
 */
describe('asyncHandler', () => {
  it('should wrap async function and catch errors', async () => {
    const mockFn = jest.fn().mockRejectedValue(new Error('test error'));
    const wrapped = utils.asyncHandler(mockFn);
    const req = {}, res = {}, next = jest.fn();

    await wrapped(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  it('should pass through successful execution', async () => {
    const mockFn = jest.fn().mockResolvedValue('success');
    const wrapped = utils.asyncHandler(mockFn);
    const req = {}, res = { json: jest.fn() }, next = jest.fn();

    await wrapped(req, res, next);
    expect(mockFn).toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
});

/**
 * Test for isPrivileged function
 */
describe('isPrivileged', () => {
  it('should return true for admin role', () => {
    expect(utils.isPrivileged({ role: 'admin' })).toBe(true);
  });

  it('should return true for manager role', () => {
    expect(utils.isPrivileged({ role: 'manager' })).toBe(true);
  });

  it('should return false for staff role', () => {
    expect(utils.isPrivileged({ role: 'staff' })).toBe(false);
  });

  it('should return false for null/undefined', () => {
    expect(utils.isPrivileged(null)).toBe(false);
    expect(utils.isPrivileged(undefined)).toBe(false);
  });
});

/**
 * Test for addSearch function
 */
describe('addSearch', () => {
  it('should add LIKE conditions for search term', () => {
    const where = [];
    const params = [];
    utils.addSearch(where, params, 'test', ['name', 'email']);
    expect(where.length).toBe(1);
    expect(where[0]).toContain('LIKE');
    expect(where[0]).toContain('ESCAPE');
    expect(params).toEqual(['%test%', '%test%']);
  });

  it('should skip empty search', () => {
    const where = [];
    const params = [];
    utils.addSearch(where, params, '', ['name']);
    expect(where.length).toBe(0);
  });

  it('should skip whitespace-only search', () => {
    const where = [];
    const params = [];
    utils.addSearch(where, params, '   ', ['name']);
    expect(where.length).toBe(0);
  });

  it('should escape LIKE wildcards', () => {
    const where = [];
    const params = [];
    utils.addSearch(where, params, '100%_complete', ['name']);
    expect(params[0]).toContain('100\\%\\_complete');
  });

  it('should validate column names', () => {
    expect(() => {
      utils.addSearch([], [], 'test', ['invalid-column!']);
    }).toThrow('Invalid column name');
  });
});

/**
 * Test for safePositiveFloat function
 */
describe('safePositiveFloat', () => {
  it('should parse valid positive float', () => {
    expect(utils.safePositiveFloat('123.45')).toBe(123.45);
    expect(utils.safePositiveFloat('0')).toBe(0);
  });

  it('should return fallback for negative values', () => {
    expect(utils.safePositiveFloat('-1')).toBeNull();
    expect(utils.safePositiveFloat('-1', 0)).toBe(0);
  });

  it('should return null for invalid values', () => {
    expect(utils.safePositiveFloat('abc')).toBeNull();
    expect(utils.safePositiveFloat('')).toBeNull();
    expect(utils.safePositiveFloat(null)).toBeNull();
  });

  it('should return default fallback for undefined/null', () => {
    expect(utils.safePositiveFloat(undefined, 10)).toBe(10);
    expect(utils.safePositiveFloat(null, 5)).toBe(5);
  });

  it('should reject array input (parameter pollution)', () => {
    expect(utils.safePositiveFloat(['1.5'], 0)).toBe(0);
    expect(utils.safePositiveFloat(['1.5', '2.5'])).toBeNull();
  });
});

/**
 * Test for sanitizePhone function
 */
describe('sanitizePhone', () => {
  it('should keep digits, +, -, (, ), spaces', () => {
    const result = utils.sanitizePhone('+1 (555) 123-4567');
    expect(result).toBe('+1 (555) 123-4567');
  });

  it('should strip invalid characters', () => {
    const result = utils.sanitizePhone('555-ABC-1234');
    expect(result).toBe('555--1234');
  });

  it('should normalize internal whitespace', () => {
    const result = utils.sanitizePhone('+1 (555)  123-4567');
    expect(result).toBe('+1 (555) 123-4567');
  });

  it('should handle multiple spaces and leading/trailing whitespace', () => {
    const result = utils.sanitizePhone('  555  123  4567  ');
    expect(result).toBe('555 123 4567');
  });

  it('should return null for empty input', () => {
    expect(utils.sanitizePhone('')).toBeNull();
    expect(utils.sanitizePhone(null)).toBeNull();
  });

  it('should keep extension characters x, X, #', () => {
    const result = utils.sanitizePhone('555-1234 x123');
    expect(result).toBe('555-1234 x123');
    const result2 = utils.sanitizePhone('555-1234 X456');
    expect(result2).toBe('555-1234 X456');
    const result3 = utils.sanitizePhone('555-1234 #789');
    expect(result3).toBe('555-1234 #789');
  });
});

/**
 * Test for isValidPhone function
 */
describe('isValidPhone', () => {
  it('should validate standard phone formats', () => {
    expect(utils.isValidPhone('+1-555-123-4567')).toBe(true);
    expect(utils.isValidPhone('(555) 123-4567')).toBe(true);
    expect(utils.isValidPhone('555-123-4567')).toBe(true);
  });

  it('should reject phone with too few digits', () => {
    expect(utils.isValidPhone('123-45')).toBe(false);
  });

  it('should reject empty/null', () => {
    expect(utils.isValidPhone('')).toBe(false);
    expect(utils.isValidPhone(null)).toBe(false);
  });
});

/**
 * Test for isValidDateTimeLocal function
 */
describe('isValidDateTimeLocal', () => {
  it('should validate correct datetime-local format', () => {
    expect(utils.isValidDateTimeLocal('2024-01-15T14:30')).toBe(true);
    expect(utils.isValidDateTimeLocal('2023-12-31T00:00')).toBe(true);
  });

  it('should reject invalid datetime values', () => {
    expect(utils.isValidDateTimeLocal('2024-13-01T14:30')).toBe(false);
    expect(utils.isValidDateTimeLocal('2024-01-15T25:00')).toBe(false);
    expect(utils.isValidDateTimeLocal('not-a-datetime')).toBe(false);
  });

  it('should reject missing time', () => {
    expect(utils.isValidDateTimeLocal('2024-01-15')).toBe(false);
  });
});

/**
 * Test for safeDate function
 */
describe('safeDate', () => {
  it('should return valid date unchanged', () => {
    expect(utils.safeDate('2024-01-15')).toBe('2024-01-15');
  });

  it('should return null for invalid date', () => {
    expect(utils.safeDate('2024-13-01')).toBeNull();
    expect(utils.safeDate('not-a-date')).toBeNull();
    expect(utils.safeDate('')).toBeNull();
  });
});

/**
 * Test for safeDateTimeLocal function
 */
describe('safeDateTimeLocal', () => {
  it('should normalize T separator to space', () => {
    expect(utils.safeDateTimeLocal('2024-01-15T14:30')).toBe('2024-01-15 14:30');
  });

  it('should return null for invalid datetime', () => {
    expect(utils.safeDateTimeLocal('not-valid')).toBeNull();
  });
});

/**
 * Test for localDate function
 */
describe('localDate', () => {
  it('should parse date string as local midnight Date', () => {
    const d = utils.localDate('2024-01-15');
    expect(d).toBeInstanceOf(Date);
    expect(d.getFullYear()).toBe(2024);
    expect(d.getMonth()).toBe(0); // January is 0
    expect(d.getDate()).toBe(15);
  });

  it('should return null for invalid date string', () => {
    expect(utils.localDate('not-a-date')).toBeNull();
    expect(utils.localDate('')).toBeNull();
  });

  it('should return null for non-string input', () => {
    expect(utils.localDate(null)).toBeNull();
    expect(utils.localDate(undefined)).toBeNull();
  });
});

/**
 * Test for formatDate function
 */
describe('formatDate', () => {
  it('should return dash for null/undefined', () => {
    expect(utils.formatDate(null)).toBe('-');
    expect(utils.formatDate(undefined)).toBe('-');
  });

  it('should format date-only string', () => {
    const result = utils.formatDate('2024-01-15');
    expect(typeof result).toBe('string');
    expect(result).not.toBe('-');
  });

  it('should format datetime string', () => {
    const result = utils.formatDate('2024-01-15T14:30:00');
    expect(typeof result).toBe('string');
    expect(result).not.toBe('-');
  });
});

/**
 * Test for formatDateTime function
 */
describe('formatDateTime', () => {
  it('should return dash for null/undefined', () => {
    expect(utils.formatDateTime(null)).toBe('-');
    expect(utils.formatDateTime(undefined)).toBe('-');
  });

  it('should format a datetime string', () => {
    const result = utils.formatDateTime('2024-01-15T14:30:00');
    expect(typeof result).toBe('string');
    expect(result).not.toBe('-');
  });

  it('should return dash for invalid input', () => {
    expect(utils.formatDateTime('not-a-date')).toBe('-');
  });
});

/**
 * Test for badgeClass function
 */
describe('badgeClass', () => {
  it('should return mapped badge class', () => {
    const mapping = { active: 'success', inactive: 'danger' };
    expect(utils.badgeClass('active', mapping)).toBe('success');
    expect(utils.badgeClass('inactive', mapping)).toBe('danger');
  });

  it('should return value itself if not in mapping', () => {
    const mapping = { active: 'success' };
    expect(utils.badgeClass('unknown', mapping)).toBe('unknown');
  });

  it('should handle null/undefined mapping', () => {
    expect(utils.badgeClass('active', null)).toBe('active');
    expect(utils.badgeClass('active', undefined)).toBe('active');
  });
});

/**
 * Test for countQuery function
 */
describe('countQuery', () => {
  it('should reject invalid table names', () => {
    expect(() => utils.countQuery({}, 'invalid-table', '', '', [])).toThrow('Invalid table name');
    expect(() => utils.countQuery({}, '1table', '', '', [])).toThrow('Invalid table name');
  });

  it('should count rows returned by query', () => {
    const t = 'tbl_cnt_' + Date.now();
    const stmt = { get: jest.fn(() => ({ c: 42 })) };
    const mockDb = { prepare: jest.fn(() => stmt) };
    const result = utils.countQuery(mockDb, t, '', '1=1', []);
    expect(result).toBe(42);
    expect(mockDb.prepare).toHaveBeenCalledTimes(1);
  });

  it('should cache prepared statements and reuse them by key', () => {
    const t = 'tbl_cache_' + Date.now();
    const stmt = { get: jest.fn(() => ({ c: 10 })) };
    const mockDb = { prepare: jest.fn(() => stmt) };
    const result1 = utils.countQuery(mockDb, t, 'x', 'x.status = ?', ['open']);
    expect(result1).toBe(10);
    const result2 = utils.countQuery(mockDb, t, 'x', 'x.status = ?', ['open']);
    expect(result2).toBe(10);
    expect(mockDb.prepare).toHaveBeenCalledTimes(1);
  });

  it('should use different cache entries for different where clauses', () => {
    const t = 'tbl_where_' + Date.now();
    let callCount = 0;
    const stmt = { get: jest.fn(() => ({ c: 0 })) };
    const mockDb = {
      prepare: jest.fn(() => {
        callCount++;
        return stmt;
      })
    };
    utils.countQuery(mockDb, t, '', 'x = 1', []);
    utils.countQuery(mockDb, t, '', 'y = 2', []);
    expect(callCount).toBe(2);
  });

  it('should use alias in generated SQL when provided', () => {
    const t = 'tbl_alias_' + Date.now();
    const stmt = { get: jest.fn(() => ({ c: 0 })) };
    const mockDb = { prepare: jest.fn(() => stmt) };
    utils.countQuery(mockDb, t, 'u', '1=1', []);
    expect(mockDb.prepare).toHaveBeenCalledWith('SELECT COUNT(*) as c FROM ' + t + ' "u" WHERE 1=1');
  });

  it('should generate correct SQL without alias', () => {
    const t = 'tbl_noalias_' + Date.now();
    const stmt = { get: jest.fn(() => ({ c: 0 })) };
    const mockDb = { prepare: jest.fn(() => stmt) };
    utils.countQuery(mockDb, t, '', '1=1', []);
    expect(mockDb.prepare).toHaveBeenCalledWith('SELECT COUNT(*) as c FROM ' + t + ' WHERE 1=1');
  });

  it('should evict cache entry and re-throw on error', () => {
    const t = 'tbl_err_' + Date.now();
    const err = new Error('DB error');
    const stmtErr = {
      get: jest.fn(() => {
        throw err;
      })
    };
    const mockDb = { prepare: jest.fn(() => stmtErr) };
    expect(() => utils.countQuery(mockDb, t, '', '1=1', [])).toThrow('DB error');
    // Subsequent call with different key should work (prior error entry was evicted)
    const stmtOk = { get: jest.fn(() => ({ c: 7 })) };
    const mockDb2 = { prepare: jest.fn(() => stmtOk) };
    const result = utils.countQuery(mockDb2, t + '_ok', '', '1=1', []);
    expect(result).toBe(7);
  });
});

/**
 * Test for pruneAuditLog function
 */
describe('pruneAuditLog', () => {
  it('should return 0 for invalid retentionDays', () => {
    expect(utils.pruneAuditLog({}, -1)).toBe(0);
    expect(utils.pruneAuditLog({}, 0)).toBe(0);
    expect(utils.pruneAuditLog({}, null)).toBe(0);
    expect(utils.pruneAuditLog({}, NaN)).toBe(0);
  });

  it('should compute cutoff and delete old entries', () => {
    const cutoff = '2024-01-01 00:00:00';
    const db = {
      prepare: jest.fn((sql) => {
        if (sql.includes('SELECT datetime')) {
          return { get: () => ({ cutoff }) };
        }
        if (sql.includes('DELETE')) {
          return { run: () => ({ changes: 5 }) };
        }
        return {};
      })
    };
    const result = utils.pruneAuditLog(db, 30);
    expect(result).toBe(5);
  });
});

/**
 * Test for isActiveUser function
 */
describe('isActiveUser', () => {
  it('should return false for falsy userId', () => {
    expect(utils.isActiveUser({}, null)).toBe(false);
    expect(utils.isActiveUser({}, undefined)).toBe(false);
    expect(utils.isActiveUser({}, 0)).toBe(false);
  });

  it('should return true when user is active', () => {
    // Note: due to module-level prepared statement caching, the first call
    // seeds the cache. Subsequent calls within the same process use the
    // cached statement regardless of which db handle is passed.
    const stmt = { get: jest.fn(() => ({ '1': 1 })) };
    const db = { prepare: jest.fn(() => stmt) };
    expect(utils.isActiveUser(db, 1)).toBe(true);
  });
});

/**
 * Test for getActiveStaff function
 */
describe('getActiveStaff', () => {
  it('should return list of active staff', () => {
    const staff = [{ id: 1, first_name: 'Alice', last_name: 'Smith' }];
    const stmt = { all: jest.fn(() => staff) };
    const db = { prepare: jest.fn(() => stmt) };
    const result = utils.getActiveStaff(db);
    expect(result).toEqual(staff);
  });
});

/**
 * Test for recalcProjectProgress function
 */
describe('recalcProjectProgress', () => {
  beforeEach(() => {
    utils.resetCachedStatements();
  });

  it('should calculate progress from task completion ratio', () => {
    const selectStmt = { get: jest.fn(() => ({ total: 4, done: 3 })) };
    const updateStmt = { run: jest.fn() };
    let callCount = 0;
    const db = {
      prepare: jest.fn(() => {
        callCount++;
        return callCount === 1 ? selectStmt : updateStmt;
      })
    };
    utils.recalcProjectProgress(db, 1);
    expect(updateStmt.run).toHaveBeenCalledWith(75, 1);
  });

  it('should handle zero tasks (progress = 0)', () => {
    const selectStmt = { get: jest.fn(() => ({ total: 0, done: 0 })) };
    const updateStmt = { run: jest.fn() };
    let callCount = 0;
    const db = {
      prepare: jest.fn(() => {
        callCount++;
        return callCount === 1 ? selectStmt : updateStmt;
      })
    };
    utils.recalcProjectProgress(db, 1);
    expect(updateStmt.run).toHaveBeenCalledWith(0, 1);
  });
});

/**
 * Test for countQuery with empty result
 */
describe('countQuery with no matches', () => {
  it('should return 0 when no rows match', () => {
    const t = 'tbl_empty_' + Date.now();
    const stmt = { get: jest.fn(() => ({ c: 0 })) };
    const mockDb = { prepare: jest.fn(() => stmt) };
    const result = utils.countQuery(mockDb, t, '', '1=0', []);
    expect(result).toBe(0);
  });
});

/**
 * Additional edge case tests for formatDate
 */
describe('formatDate with T-separator datetime', () => {
  it('should handle ISO datetime with T separator', () => {
    const result = utils.formatDate('2024-01-15T14:30:00');
    expect(typeof result).toBe('string');
    expect(result).not.toBe('-');
  });

  it('should return dash for invalid input', () => {
    expect(utils.formatDate('not-a-date')).toBe('-');
  });
});

/**
 * Additional safeDateTimeLocal edge cases
 */
describe('safeDateTimeLocal edge cases', () => {
  it('should return null for undefined', () => {
    expect(utils.safeDateTimeLocal(undefined)).toBeNull();
  });

  it('should return null for empty string', () => {
    expect(utils.safeDateTimeLocal('')).toBeNull();
  });
});

/**
 * Test for daysUntil function
 */
describe('daysUntil', () => {
  it('should return positive number for future date', () => {
    const future = new Date();
    future.setDate(future.getDate() + 30);
    const str = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, '0')}-${String(future.getDate()).padStart(2, '0')}`;
    const result = utils.daysUntil(str);
    expect(result).toBe(30);
  });

  it('should return negative number for past date', () => {
    const past = new Date();
    past.setDate(past.getDate() - 5);
    const str = `${past.getFullYear()}-${String(past.getMonth() + 1).padStart(2, '0')}-${String(past.getDate()).padStart(2, '0')}`;
    const result = utils.daysUntil(str);
    expect(result).toBe(-5);
  });

  it('should return null for invalid input', () => {
    expect(utils.daysUntil(null)).toBeNull();
    expect(utils.daysUntil('not-a-date')).toBeNull();
  });

  it('should return null for empty string', () => {
    expect(utils.daysUntil('')).toBeNull();
  });
});

/**
 * Test for usagePercent function
 */
describe('usagePercent', () => {
  it('should calculate percentage correctly', () => {
    expect(utils.usagePercent(25, 100)).toBe(25);
    expect(utils.usagePercent(200, 100)).toBe(100);
    expect(utils.usagePercent(0, 50)).toBe(0);
  });

  it('should return 0 when total is 0', () => {
    expect(utils.usagePercent(10, 0)).toBe(0);
    expect(utils.usagePercent(0, 0)).toBe(0);
  });

  it('should cap at 100', () => {
    expect(utils.usagePercent(150, 100)).toBe(100);
  });

  it('should handle invalid inputs', () => {
    expect(utils.usagePercent(null, 100)).toBe(0);
    expect(utils.usagePercent('abc', 100)).toBe(0);
    expect(utils.usagePercent(10, null)).toBe(0);
  });
});

/**
 * Test for isExpiringSoon function
 */
describe('isExpiringSoon', () => {
  it('should return true for date within 30 days', () => {
    const future = new Date();
    future.setDate(future.getDate() + 15);
    const str = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, '0')}-${String(future.getDate()).padStart(2, '0')}`;
    expect(utils.isExpiringSoon(str)).toBe(true);
  });

  it('should return false for date beyond 30 days', () => {
    const future = new Date();
    future.setDate(future.getDate() + 60);
    const str = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, '0')}-${String(future.getDate()).padStart(2, '0')}`;
    expect(utils.isExpiringSoon(str)).toBe(false);
  });

  it('should return false for past date', () => {
    const past = new Date();
    past.setDate(past.getDate() - 1);
    const str = `${past.getFullYear()}-${String(past.getMonth() + 1).padStart(2, '0')}-${String(past.getDate()).padStart(2, '0')}`;
    expect(utils.isExpiringSoon(str)).toBe(false);
  });

  it('should return false for invalid input', () => {
    expect(utils.isExpiringSoon(null)).toBe(false);
    expect(utils.isExpiringSoon('')).toBe(false);
  });

  it('should respect custom withinDays parameter', () => {
    const future = new Date();
    future.setDate(future.getDate() + 7);
    const str = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, '0')}-${String(future.getDate()).padStart(2, '0')}`;
    expect(utils.isExpiringSoon(str, 5)).toBe(false);
    expect(utils.isExpiringSoon(str, 10)).toBe(true);
  });
});

/**
 * Test for resetCachedStatements function
 */
describe('resetCachedStatements', () => {
  it('should clear all cached prepared statements', () => {
    utils.resetCachedStatements();
    const selectStmt = { get: jest.fn(() => ({ total: 2, done: 1 })) };
    const updateStmt = { run: jest.fn() };
    let callCount = 0;
    const db = {
      prepare: jest.fn(() => {
        callCount++;
        return callCount === 1 ? selectStmt : updateStmt;
      })
    };
    utils.recalcProjectProgress(db, 1);
    expect(db.prepare).toHaveBeenCalledTimes(2);
  });
});

/**
 * Test for titleCase with acronym suffixes
 */
describe('titleCase with acronym suffixes', () => {
  it('should handle acronym with lowercase suffix (SOPs, APIv2)', () => {
    expect(utils.titleCase('sops_guidelines')).toBe('SOPs Guidelines');
    expect(utils.titleCase('api_v2_docs')).toBe('API V2 Docs');
  });

  it('should not split words containing acronyms (SOPHISTICATED)', () => {
    expect(utils.titleCase('sophisticated_approach')).toBe('Sophisticated Approach');
  });
});
