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

  it('should return empty string for empty map', () => {
    const allowedMap = {};
    const result = utils.safeSort('asc', allowedMap, 'desc');
    expect(result).toBe('');
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
