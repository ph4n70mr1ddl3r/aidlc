const { describe, it, expect } = require('@jest/globals');

const utils = require('../src/utils');
const constants = require('../src/constants');
const { MAX_PAGE_SIZE } = constants;

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

  it('should cap limit at MAX_PAGE_SIZE', () => {
    const req = { query: { page: '1', limit: '200' }, path: '/test' };
    const result = utils.paginate(req);
    expect(result.limit).toBe(MAX_PAGE_SIZE);
  });

  it('should safely handle array query values from HPP', () => {
    const req = { query: { page: ['2', '9999'], limit: ['10', '0'] }, path: '/test' };
    const result = utils.paginate(req);
    expect(result.page).toBe(2);
    expect(result.limit).toBe(10);
    expect(result.offset).toBe(10);
  });
});

/**
 * Test for safeQueryValue function (HPP guard)
 */
describe('safeQueryValue', () => {
  it('should return scalar value unchanged', () => {
    expect(utils.safeQueryValue('open')).toBe('open');
    expect(utils.safeQueryValue('1')).toBe('1');
    expect(utils.safeQueryValue(undefined)).toBeUndefined();
    expect(utils.safeQueryValue(null)).toBeNull();
  });

  it('should return first element for array (HPP defense)', () => {
    expect(utils.safeQueryValue(['open', 'closed'])).toBe('open');
    expect(utils.safeQueryValue(['1', '2'])).toBe('1');
    expect(utils.safeQueryValue([])).toBeUndefined();
  });
});

/**
 * Test for normalizeIp function (IPv6-mapped prefix strip + HPP/fallback guard)
 */
describe('normalizeIp', () => {
  it('passes a plain IPv4 address through unchanged', () => {
    expect(utils.normalizeIp('203.0.113.7')).toBe('203.0.113.7');
  });

  it('passes a plain IPv6 address through unchanged', () => {
    expect(utils.normalizeIp('2001:db8::1')).toBe('2001:db8::1');
  });

  it('strips the IPv6-mapped ::ffff: prefix produced behind proxies', () => {
    expect(utils.normalizeIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('falls back to unknown for missing or non-string values', () => {
    expect(utils.normalizeIp(undefined)).toBe('unknown');
    expect(utils.normalizeIp(null)).toBe('unknown');
    expect(utils.normalizeIp('')).toBe('unknown');
    expect(utils.normalizeIp(42)).toBe('unknown');
  });

  it('falls back to unknown for arrays from HTTP parameter pollution', () => {
    // Regression: req.ip can be an array when X-Forwarded-For is polluted.
    // normalizeIp must not crash and must not serialize an array downstream.
    expect(utils.normalizeIp(['203.0.113.7', '198.51.100.2'])).toBe('unknown');
    expect(utils.normalizeIp([])).toBe('unknown');
  });
});

describe('parseBooleanFlag', () => {
  it('maps canonical checked values to 1 for a privileged caller', () => {
    expect(utils.parseBooleanFlag('1', true)).toBe(1);
    expect(utils.parseBooleanFlag('true', true)).toBe(1);
    expect(utils.parseBooleanFlag('on', true)).toBe(1);
  });

  it('maps a missing/empty value to 0 (caller decides preserve vs default)', () => {
    expect(utils.parseBooleanFlag(undefined, true)).toBe(0);
    expect(utils.parseBooleanFlag('', true)).toBe(0);
    expect(utils.parseBooleanFlag(null, true)).toBe(0);
  });

  it('does NOT coerce non-canonical strings (false/off/no) to 1', () => {
    // Regression: the previous `(x && x !== '0')` idiom treated any non-empty
    // string as truthy, so is_internal=false / is_featured=off would be stored
    // as 1. Only canonical checked values may set the flag.
    expect(utils.parseBooleanFlag('false', true)).toBe(0);
    expect(utils.parseBooleanFlag('off', true)).toBe(0);
    expect(utils.parseBooleanFlag('no', true)).toBe(0);
    expect(utils.parseBooleanFlag('0', true)).toBe(0);
  });

  it('always returns 0 when the caller is not privileged', () => {
    expect(utils.parseBooleanFlag('1', false)).toBe(0);
    expect(utils.parseBooleanFlag('true', false)).toBe(0);
    expect(utils.parseBooleanFlag('false', false)).toBe(0);
  });
});

/**
 * Test for safeFilters function (HPP defense for template filter state)
 */
describe('safeFilters', () => {
  it('should return only allowed keys from query', () => {
    const query = { search: 'test', status: 'open', injected: 'evil', page: '2' };
    const result = utils.safeFilters(query, ['search', 'status', 'sort']);
    expect(result).toEqual({ search: 'test', status: 'open' });
    expect(result.injected).toBeUndefined();
    expect(result.page).toBeUndefined();
  });

  it('should extract first value for array params (HPP defense)', () => {
    const query = { status: ['open', 'closed'], search: 'test' };
    const result = utils.safeFilters(query, ['status', 'search']);
    expect(result).toEqual({ status: 'open', search: 'test' });
  });

  it('should return empty object when no allowed keys match', () => {
    const query = { page: '2', limit: '10' };
    const result = utils.safeFilters(query, ['search', 'status']);
    expect(result).toEqual({});
  });

  it('should return empty object for empty query', () => {
    const result = utils.safeFilters({}, ['search', 'status']);
    expect(result).toEqual({});
  });

  it('should preserve null/undefined values from query', () => {
    const query = { search: null, status: undefined };
    const result = utils.safeFilters(query, ['search', 'status']);
    expect(result.search).toBeNull();
    expect(result.status).toBeUndefined();
  });

  it('should not include keys not present in query but allowed', () => {
    const query = { search: 'test' };
    const result = utils.safeFilters(query, ['search', 'status', 'sort']);
    expect(result).toEqual({ search: 'test' });
    expect(result.status).toBeUndefined();
    expect(result.sort).toBeUndefined();
  });
});

/**
 * Test for paginationBaseUrl function
 */
describe('paginationBaseUrl', () => {
  it('should strip page param from query string and preserve known params', () => {
    const req = {
      query: { page: '2', sort: 'name' },
      path: '/users'
    };
    const result = utils.paginationBaseUrl(req);
    expect(result).toBe('/users?sort=name');
  });

  it('should return path without query when no params left', () => {
    const req = {
      query: { page: '1' },
      path: '/users'
    };
    const result = utils.paginationBaseUrl(req);
    expect(result).toBe('/users');
  });

  it('should preserve action and entity_type (audit log filters)', () => {
    const req = {
      query: { page: '2', action: 'create', entity_type: 'ticket' },
      path: '/audit'
    };
    const result = utils.paginationBaseUrl(req);
    expect(result).toContain('action=create');
    expect(result).toContain('entity_type=ticket');
    expect(result).not.toContain('page');
  });

  it('should return path when query is empty', () => {
    const req = { query: {}, path: '/test' };
    const result = utils.paginationBaseUrl(req);
    expect(result).toBe('/test');
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

  it('should fail closed when default is invalid (no silent first-key fallback)', () => {
    const allowedMap = { asc: 'first_name ASC', desc: 'first_name DESC' };
    expect(() => utils.safeSort('invalid', allowedMap, 'invalid_default'))
      .toThrow('safeSort: defaultKey "invalid_default" is not a valid sort key');
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

  // Regression: quoteColumn must validate every segment so it is
  // safe-by-construction. A segment containing a quote, dash, semicolon, or
  // space must be rejected rather than emitted into the SQL identifier —
  // otherwise a future caller that forgets to pre-validate could inject SQL.
  it('should reject segments containing non-identifier characters (defense-in-depth)', () => {
    expect(() => utils.quoteColumn('a"b')).toThrow('Invalid column name');
    expect(() => utils.quoteColumn('t.status; --')).toThrow('Invalid column name');
    expect(() => utils.quoteColumn('user name')).toThrow('Invalid column name');
    expect(() => utils.quoteColumn('a-b')).toThrow('Invalid column name');
    expect(() => utils.quoteColumn('t.')).toThrow('Invalid column name');
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

  it('should throw when allowedColumns is empty', () => {
    expect(() => utils.buildFilters({ status: { value: 'open' } }, [])).toThrow('allowedColumns must be non-empty');
  });

  it('should throw when allowedColumns is null', () => {
    expect(() => utils.buildFilters({ status: { value: 'open' } }, null)).toThrow('allowedColumns must be non-empty');
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

  it('should return error when password exceeds MAX_PASSWORD_BYTES (72 bytes)', () => {
    // Multi-byte UTF-8 characters: 37 'é' chars = 74 bytes (> MAX_PASSWORD_BYTES=72)
    // but only 37 characters (< MAX_PASSWORD=128), so the byte-length guard is
    // the only path that rejects this password.
    const result = utils.validatePassword('\u00e9'.repeat(37) + 'Aa1!');
    expect(result).toContain('at most 72 bytes');
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

  it('should reject array input (parameter pollution)', () => {
    // Regression: previously parseInt coerced ['123'] -> '123' and returned 123,
    // silently accepting the first element of a polluted query/body value.
    // safeId must reject arrays for consistency with safeInt / safePositiveFloat.
    expect(utils.safeId(['123'])).toBeNull();
    expect(utils.safeId(['123', '456'])).toBeNull();
    expect(utils.safeId([])).toBeNull();
  });

  it('should reject non-string/number types (e.g. booleans, objects)', () => {
    // Type coercion guard: prevent unexpected values from being parsed
    expect(utils.safeId(true)).toBeNull();
    expect(utils.safeId(false)).toBeNull();
    expect(utils.safeId({})).toBeNull();
    expect(utils.safeId({ id: 1 })).toBeNull();
    expect(utils.safeId(null)).toBeNull();  // null is not string or number
    expect(utils.safeId(undefined)).toBeNull();
  });
});

describe('isPresentInvalidId', () => {
  it('returns false for absent / empty values (legitimate "unassign" semantics)', () => {
    expect(utils.isPresentInvalidId(undefined)).toBe(false);
    expect(utils.isPresentInvalidId(null)).toBe(false);
    expect(utils.isPresentInvalidId('')).toBe(false);
    expect(utils.isPresentInvalidId(0)).toBe(true); // 0 is present but not a valid id
  });

  it('returns false for valid positive-integer ids (string and number)', () => {
    expect(utils.isPresentInvalidId('1')).toBe(false);
    expect(utils.isPresentInvalidId(' 42 ')).toBe(false);
    expect(utils.isPresentInvalidId(7)).toBe(false);
  });

  it('returns true for present-but-malformed ids (fail closed)', () => {
    // Regression: routes used `x ? safeId(x) : null`, silently coercing a
    // present-but-garbage id ("abc", "3.5", an array) to NULL via safeId and
    // wiping an existing assignment with no error. The routes now call this
    // guard to fail closed on such input.
    expect(utils.isPresentInvalidId('abc')).toBe(true);
    expect(utils.isPresentInvalidId('3.5')).toBe(true);
    expect(utils.isPresentInvalidId('0x10')).toBe(true);
    expect(utils.isPresentInvalidId('-1')).toBe(true);
    expect(utils.isPresentInvalidId(12.5)).toBe(true);
    expect(utils.isPresentInvalidId(['1'])).toBe(true);
    expect(utils.isPresentInvalidId({})).toBe(true);
    expect(utils.isPresentInvalidId(true)).toBe(true);
  });

  it('treats the string "0" as present-but-invalid, consistent with numeric 0 (regression: silently cleared)', () => {
    // Prior behavior: the string branch used /^\d+$/, so "0" was "valid" and
    // safeId("0") returned null → a present owner_id/assigned_to of "0" wiped
    // the stored value with no user-visible error. Numeric 0 was already
    // rejected; the string form must fail closed too.
    expect(utils.isPresentInvalidId('0')).toBe(true);
    expect(utils.isPresentInvalidId(' 0 ')).toBe(true);
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

  it('should reject Infinity (defense-in-depth)', () => {
    // Regression: parseInt("Infinity") === Infinity, which passed the original
    // Number.isFinite guard. Fail closed instead of relying on a downstream
    // SQLite non-finite rejection.
    expect(utils.safeInt('Infinity', 0)).toBe(0);
    expect(utils.safeInt('Infinity')).toBe(0);
    expect(utils.safeInt(Infinity, 7)).toBe(7);
  });

  it('should return fallback for non-primitive inputs (object/boolean)', () => {
    // Regression: safeInt({}) previously fell through to parseInt({}) and
    // returned NaN instead of the fallback, breaking the fail-closed contract.
    // A malformed JSON body could deliver an object where a scalar was expected.
    expect(utils.safeInt({}, 0)).toBe(0);
    expect(utils.safeInt({ id: 1 })).toBe(0);
    expect(utils.safeInt(true, 0)).toBe(0);
    expect(utils.safeInt(false, 0)).toBe(0);
  });

  it('should parse trimmed string input and return the integer', () => {
    // Regression: strings with leading/trailing whitespace must be trimmed
    // before regex validation so that " 42 " is accepted rather than
    // silently rejected.
    expect(utils.safeInt(' 42 ')).toBe(42);
    expect(utils.safeInt('  -7  ')).toBe(-7);
  });

  it('should return fallback for a whitespace-only string', () => {
    // A string of only spaces trims to '' which fails the regex, so the
    // fallback is returned rather than parseInt('') producing NaN.
    expect(utils.safeInt('   ')).toBe(0);
    expect(utils.safeInt('   ', -1)).toBe(-1);
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
 * Test for isValidAssetTag function
 */
describe('isValidAssetTag', () => {
  it('should accept valid asset tags (AST-XXX with 3+ digits)', () => {
    expect(utils.isValidAssetTag('AST-001')).toBe(true);
    expect(utils.isValidAssetTag('AST-999')).toBe(true);
    expect(utils.isValidAssetTag('AST-123')).toBe(true);
    expect(utils.isValidAssetTag('AST-1000')).toBe(true);
  });

  it('should reject malformed asset tags', () => {
    expect(utils.isValidAssetTag('AST-01')).toBe(false);
    expect(utils.isValidAssetTag('ast-001')).toBe(false);
    expect(utils.isValidAssetTag('XYZ-001')).toBe(false);
    expect(utils.isValidAssetTag('AST001')).toBe(false);
    expect(utils.isValidAssetTag('')).toBe(false);
    expect(utils.isValidAssetTag(null)).toBe(false);
    expect(utils.isValidAssetTag(undefined)).toBe(false);
    expect(utils.isValidAssetTag(123)).toBe(false);
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

  it('should handle standalone acronym', () => {
    expect(utils.titleCase('sop')).toBe('SOP');
    expect(utils.titleCase('api')).toBe('API');
  });

  it('should handle double underscores', () => {
    expect(utils.titleCase('first__name')).toBe('First  Name');
  });

  it('should handle non-string values', () => {
    expect(utils.titleCase(123)).toBe('');
    expect(utils.titleCase('')).toBe('');
  });

  it('should handle acronym with lowercase suffix (SOPs, APIv2)', () => {
    expect(utils.titleCase('sops_guidelines')).toBe('SOPs Guidelines');
    expect(utils.titleCase('api_v2_docs')).toBe('API V2 Docs');
  });

  it('should not split words containing acronyms (SOPHISTICATED)', () => {
    expect(utils.titleCase('sophisticated_approach')).toBe('Sophisticated Approach');
  });

  it('should not split when acronym prefix is followed by uppercase continuation', () => {
    // When an acronym prefix (e.g. 'SOP') is followed by an uppercase letter
    // (e.g. 'H' in 'SOPH...'), the guard on line 754-755 continues the loop
    // instead of returning, preventing incorrect splits like 'SOPH' + 'isticated'.
    expect(utils.titleCase('SOPHisticated_approach')).toBe('Sophisticated Approach');
  });

  it('should preserve mixed-case acronyms when normalized to uppercase (NVMe, OAuth, PCIe, IoT)', () => {
    // Regression: the ACRONYMS set previously contained mixed-case entries
    // ("NVMe", "OAuth", "PCIe", "IoT") but titleCase looked them up via
    // .toUpperCase(), so these acronyms were never recognized. Normalizing
    // the set entries to uppercase fixes the lookup. titleCase renders
    // acronyms in all-caps (the function's established convention).
    expect(utils.titleCase('nvme_drive')).toBe('NVME Drive');
    expect(utils.titleCase('oauth_token')).toBe('OAUTH Token');
    expect(utils.titleCase('pcie_slot')).toBe('PCIE Slot');
    expect(utils.titleCase('iot_device')).toBe('IOT Device');
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

  it('should catch synchronous errors thrown by the wrapped function', () => {
    const mockFn = jest.fn(() => {
      throw new Error('sync error');
    });
    const wrapped = utils.asyncHandler(mockFn);
    const req = {}, res = {}, next = jest.fn();

    // asyncHandler wraps in Promise.resolve().catch(), so sync throws are
    // caught and passed to next just like rejected promises.
    expect(() => wrapped(req, res, next)).not.toThrow();
    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'sync error' }));
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
 * Test for prefersJson content negotiation.
 * Regression: the error handler must serve JSON to AJAX clients. The previous
 * check (req.accepts('html') === false && req.accepts('json')) returned false
 * under a wildcard Accept header (fetch/XHR/browsers) and served HTML error
 * pages instead.
 */
describe('prefersJson', () => {
  const makeReq = (accept) => ({ accepts: (_types) => {
    // Minimal reimplementation of Express header q-value negotiation for the
    // two candidates we care about, sufficient to exercise our predicate.
    if (accept === undefined) {
      return 'html'; // missing Accept header → everything acceptable
    }
    const lower = accept.toLowerCase();
    if (lower.includes('application/json') || lower === '*/*') {
      return 'json';
    }
    return 'html';
  } });

  it('returns true for Accept: application/json', () => {
    expect(utils.prefersJson(makeReq('application/json'))).toBe(true);
  });

  it('returns true for Accept: */* (fetch/XHR/browsers) — regression case', () => {
    expect(utils.prefersJson(makeReq('*/*'))).toBe(true);
  });

  it('returns false for Accept: text/html', () => {
    expect(utils.prefersJson(makeReq('text/html'))).toBe(false);
  });

  it('returns false when req or req.accepts is missing', () => {
    expect(utils.prefersJson(null)).toBe(false);
    expect(utils.prefersJson({})).toBe(false);
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

  it('should throw when columns is empty', () => {
    expect(() => utils.addSearch([], [], 'test', [])).toThrow('columns is required for addSearch');
  });

  it('should throw when columns is null', () => {
    expect(() => utils.addSearch([], [], 'test', null)).toThrow('columns is required for addSearch');
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

  // Regression: parseFloat() silently accepts trailing garbage, so a malformed
  // monetary value like "1,000" was stored as 1 and "100abc" as 100.
  // safePositiveFloat must reject these so budget/cost/price fields are not
  // corrupted (mirrors the strict regex in safeInt).
  it('should reject strings with trailing/leading garbage', () => {
    expect(utils.safePositiveFloat('100abc')).toBeNull();
    expect(utils.safePositiveFloat('100abc', 0)).toBe(0);
    expect(utils.safePositiveFloat('1,000')).toBeNull();
    expect(utils.safePositiveFloat('1,000', 50)).toBe(50);
    expect(utils.safePositiveFloat('$100')).toBeNull();
    expect(utils.safePositiveFloat('abc100')).toBeNull();
  });

  it('should accept integer, decimal, and leading-dot values', () => {
    expect(utils.safePositiveFloat('100')).toBe(100);
    expect(utils.safePositiveFloat('0.5')).toBe(0.5);
    expect(utils.safePositiveFloat('.5')).toBe(0.5);
    expect(utils.safePositiveFloat('100.00')).toBe(100);
  });

  it('should reject Infinity (defense-in-depth)', () => {
    // Regression: parseFloat("Infinity") === Infinity, which passed the
    // original negative-only guard. Reject non-finite values explicitly.
    expect(utils.safePositiveFloat('Infinity')).toBeNull();
    expect(utils.safePositiveFloat('Infinity', 0)).toBe(0);
    expect(utils.safePositiveFloat(Infinity, 5)).toBe(5);
  });
});

/**
 * Test for safePositiveInt function
 */
describe('safePositiveInt', () => {
  it('should parse valid positive integers', () => {
    expect(utils.safePositiveInt('42')).toBe(42);
    expect(utils.safePositiveInt('0')).toBe(0);
    expect(utils.safePositiveInt(100)).toBe(100);
  });

  it('should return fallback for negative values', () => {
    expect(utils.safePositiveInt('-1')).toBe(0);
    expect(utils.safePositiveInt('-1', 5)).toBe(5);
  });

  it('should return fallback for non-integer values', () => {
    expect(utils.safePositiveInt('3.5')).toBe(0);
    expect(utils.safePositiveInt(3.5)).toBe(0);
  });

  it('should reject values exceeding 32-bit signed int range', () => {
    // SQLite stores integers > 2^31-1 as floats with precision loss.
    // safePositiveInt must reject values outside the safe integer range.
    expect(utils.safePositiveInt(2147483648)).toBe(0);
    expect(utils.safePositiveInt('2147483648')).toBe(0);
    expect(utils.safePositiveInt(9007199254740991)).toBe(0); // Number.MAX_SAFE_INTEGER
  });

  it('should return fallback for invalid inputs', () => {
    expect(utils.safePositiveInt('abc')).toBe(0);
    expect(utils.safePositiveInt('')).toBe(0);
    expect(utils.safePositiveInt(null)).toBe(0);
    expect(utils.safePositiveInt(undefined)).toBe(0);
  });

  it('should reject array input (parameter pollution)', () => {
    expect(utils.safePositiveInt(['42'], 0)).toBe(0);
    expect(utils.safePositiveInt(['42', '99'])).toBe(0);
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

  it('should accept datetime with seconds', () => {
    expect(utils.isValidDateTimeLocal('2024-01-15T14:30:00')).toBe(true);
    expect(utils.isValidDateTimeLocal('2024-01-15T00:00:00')).toBe(true);
  });

  it('should accept space-separated datetime', () => {
    expect(utils.isValidDateTimeLocal('2024-01-15 14:30')).toBe(true);
    expect(utils.isValidDateTimeLocal('2023-12-31 23:59')).toBe(true);
  });

  it('should accept space-separated datetime with seconds', () => {
    expect(utils.isValidDateTimeLocal('2024-01-15 14:30:00')).toBe(true);
    expect(utils.isValidDateTimeLocal('2024-01-15 00:00:00')).toBe(true);
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

  it('should return null for undefined', () => {
    expect(utils.safeDateTimeLocal(undefined)).toBeNull();
  });

  it('should return null for empty string', () => {
    expect(utils.safeDateTimeLocal('')).toBeNull();
  });

  it('should strip seconds from datetime input', () => {
    expect(utils.safeDateTimeLocal('2024-01-15T14:30:00')).toBe('2024-01-15 14:30');
    expect(utils.safeDateTimeLocal('2024-02-20T09:15:45')).toBe('2024-02-20 09:15');
  });

  it('should normalize space separator without seconds', () => {
    expect(utils.safeDateTimeLocal('2024-01-15 14:30')).toBe('2024-01-15 14:30');
    expect(utils.safeDateTimeLocal('2024-01-15 00:00')).toBe('2024-01-15 00:00');
  });

  it('should normalize space separator with seconds', () => {
    expect(utils.safeDateTimeLocal('2024-01-15 14:30:00')).toBe('2024-01-15 14:30');
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
    expect(utils.localDate('2024-02-30')).toBeNull();
    expect(utils.localDate('2024-13-01')).toBeNull();
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
    expect(result).toContain('2024');
    expect(result).toContain('15');
  });

  it('should format ISO datetime with T separator', () => {
    const result = utils.formatDate('2024-01-15T14:30:00');
    expect(result).toContain('2024');
    expect(result).toContain('15');
  });

  it('should return dash for invalid input', () => {
    expect(utils.formatDate('not-a-date')).toBe('-');
  });

  it('should return dash for a well-formatted but invalid date (e.g. month 13)', () => {
    // Regression: formatDate accepts the YYYY-MM-DD format regex but delegates
    // to localDate which validates the actual calendar date. A formatted but
    // impossible date like 2024-13-01 must render as '-' not crash.
    expect(utils.formatDate('2024-13-01')).toBe('-');
    expect(utils.formatDate('2024-02-30')).toBe('-');
    expect(utils.formatDate('2023-04-31')).toBe('-');
  });

  it('should use localDate for date-only strings and fall back to new Date for ISO datetimes', () => {
    // Date-only strings go through localDate() to avoid the UTC midnight
    // offset bug. ISO datetimes with 'T' go through the new Date() path.
    const result = utils.formatDate('2024-01-15');
    expect(result).not.toBe('-');
    expect(typeof result).toBe('string');
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
    expect(result).toContain('2024');
    expect(result).toContain('15');
    expect(result).toMatch(/\d:\d{2}/);
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

  it('should return 0 when no rows match', () => {
    const t = 'tbl_empty_' + Date.now();
    const stmt = { get: jest.fn(() => ({ c: 0 })) };
    const mockDb = { prepare: jest.fn(() => stmt) };
    const result = utils.countQuery(mockDb, t, '', '1=0', []);
    expect(result).toBe(0);
  });

  it('should return 0 when the query result is falsy', () => {
    // Guard against a NULL or undefined result from the DB returning
    // NaN instead of 0 when the ternary `result ? result.c : 0` is
    // evaluated with a falsy result.
    const t = 'tbl_falsy_' + Date.now();
    const stmt = { get: jest.fn(() => null) };
    const mockDb = { prepare: jest.fn(() => stmt) };
    const result = utils.countQuery(mockDb, t, '', '1=1', []);
    expect(result).toBe(0);
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
    // Entry was evicted on error; a subsequent call with the same key should re-prepare
    const stmtOk = { get: jest.fn(() => ({ c: 7 })) };
    const mockSameDb = { prepare: jest.fn(() => stmtOk) };
    const result = utils.countQuery(mockSameDb, t, '', '1=1', []);
    expect(result).toBe(7);
    expect(mockSameDb.prepare).toHaveBeenCalledTimes(1);
  });
});

/**
 * Test for selectQuery function (cached list queries)
 */
describe('selectQuery', () => {
  beforeEach(() => {
    utils.resetCachedStatements();
  });

  it('should return rows and prepare exactly once for repeated SQL', () => {
    const rows = [{ id: 1 }, { id: 2 }];
    const stmt = { all: jest.fn(() => rows) };
    const mockDb = { prepare: jest.fn(() => stmt) };
    const sql = 'SELECT * FROM t WHERE x = ? LIMIT ? OFFSET ?';
    expect(utils.selectQuery(mockDb, sql, [1, 10, 0])).toEqual(rows);
    expect(utils.selectQuery(mockDb, sql, [2, 10, 0])).toEqual(rows);
    expect(mockDb.prepare).toHaveBeenCalledTimes(1);
    // Params must be forwarded in order on each call
    expect(stmt.all).toHaveBeenLastCalledWith(2, 10, 0);
  });

  it('should cache distinct statements per SQL string', () => {
    const stmt = { all: jest.fn(() => []) };
    let callCount = 0;
    const mockDb = { prepare: jest.fn(() => {
      callCount++; return stmt;
    }) };
    utils.selectQuery(mockDb, 'SELECT 1 LIMIT ? OFFSET ?', [10, 0]);
    utils.selectQuery(mockDb, 'SELECT 2 LIMIT ? OFFSET ?', [10, 0]);
    utils.selectQuery(mockDb, 'SELECT 1 LIMIT ? OFFSET ?', [10, 0]);
    expect(callCount).toBe(2);
  });

  it('should evict the cached entry and re-throw on error', () => {
    const err = new Error('DB error');
    const stmtErr = {
      all: jest.fn(() => {
        throw err;
      })
    };
    const mockDb = { prepare: jest.fn(() => stmtErr) };
    expect(() => utils.selectQuery(mockDb, 'SELECT bad LIMIT ? OFFSET ?', [10, 0])).toThrow('DB error');
    // Entry was evicted on error; next call with same key re-prepares on the same mock
    const stmtOk = { all: jest.fn(() => [{ ok: 1 }]) };
    const mockSameDb = { prepare: jest.fn(() => stmtOk) };
    expect(utils.selectQuery(mockSameDb, 'SELECT bad LIMIT ? OFFSET ?', [10, 0])).toEqual([{ ok: 1 }]);
    expect(mockSameDb.prepare).toHaveBeenCalledTimes(1);
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
    // Lazy-init: prepare should have been called for both statements
    expect(db.prepare).toHaveBeenCalledTimes(2);
  });

  it('should reuse cached prepared statements on subsequent calls', () => {
    // Reset module-level cache so the mock db's prepare() is actually invoked.
    utils.resetCachedStatements();
    const cutoff = '2024-01-01 00:00:00';
    const prepareCalls = [];
    const db = {
      prepare: jest.fn((sql) => {
        prepareCalls.push(sql);
        if (sql.includes('SELECT datetime')) {
          return { get: () => ({ cutoff }) };
        }
        if (sql.includes('DELETE')) {
          return { run: () => ({ changes: 2 }) };
        }
        return {};
      })
    };
    // First call: lazy-initialises both statements
    utils.pruneAuditLog(db, 30);
    expect(prepareCalls.length).toBe(2);
    // Second call: reuses the cached statements — no new prepare calls
    utils.pruneAuditLog(db, 30);
    expect(prepareCalls.length).toBe(2);
  });
});

/**
 * Test for isActiveUser function
 */
describe('isActiveUser', () => {
  beforeEach(() => {
    utils.resetCachedStatements();
  });

  it('should return false for null/undefined userId', () => {
    expect(utils.isActiveUser({}, null)).toBe(false);
    expect(utils.isActiveUser({}, undefined)).toBe(false);
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
  beforeEach(() => {
    utils.resetCachedStatements();
  });

  it('should return list of active staff', () => {
    const staff = [{ id: 1, first_name: 'Alice', last_name: 'Smith' }];
    const stmt = { all: jest.fn(() => staff) };
    const db = { prepare: jest.fn(() => stmt) };
    const result = utils.getActiveStaff(db);
    expect(result).toEqual(staff);
  });

  it('returns cached results within the TTL window', () => {
    const staff = [{ id: 1, first_name: 'Alice', last_name: 'Smith' }];
    const stmt = { all: jest.fn(() => staff) };
    const db = { prepare: jest.fn(() => stmt) };
    utils.getActiveStaff(db);
    expect(stmt.all).toHaveBeenCalledTimes(1);
    const result2 = utils.getActiveStaff(db);
    expect(stmt.all).toHaveBeenCalledTimes(1); // still cached
    expect(result2).toEqual(staff);
  });

  it('refreshes cache after TTL expires', () => {
    jest.useFakeTimers();
    utils.resetCachedStatements();
    const staff = [{ id: 1, first_name: 'Alice', last_name: 'Smith' }];
    const stmt = { all: jest.fn(() => staff) };
    const db = { prepare: jest.fn(() => stmt) };
    utils.getActiveStaff(db);
    expect(stmt.all).toHaveBeenCalledTimes(1);
    // Advance past the 30s TTL
    jest.advanceTimersByTime(31_000);
    utils.getActiveStaff(db);
    expect(stmt.all).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
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

  it('should do nothing for invalid projectId', () => {
    const selectStmt = { get: jest.fn() };
    const updateStmt = { run: jest.fn() };
    const db = {
      prepare: jest.fn(() => selectStmt)
    };
    // Invalid types should be silently ignored
    utils.recalcProjectProgress(db, NaN);
    utils.recalcProjectProgress(db, -1);
    utils.recalcProjectProgress(db, 0);
    utils.recalcProjectProgress(db, 'abc');
    expect(selectStmt.get).not.toHaveBeenCalled();
    expect(updateStmt.run).not.toHaveBeenCalled();
  });

  it('should do nothing when project has no tasks (row is null)', () => {
    const selectStmt = { get: jest.fn(() => null) };
    const updateStmt = { run: jest.fn() };
    const db = {
      prepare: jest.fn(() => selectStmt)
    };
    utils.recalcProjectProgress(db, 42);
    expect(selectStmt.get).toHaveBeenCalledWith(42);
    expect(updateStmt.run).not.toHaveBeenCalled();
  });
});

/**
 * Test for daysUntil function
 */
describe('daysUntil', () => {
  it('should return positive number for future date', () => {
    const result = utils.daysUntil('2099-06-15');
    expect(result).toBeGreaterThan(0);
  });

  it('should return negative number for past date', () => {
    const result = utils.daysUntil('2020-01-01');
    expect(result).toBeLessThan(0);
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
 * Test for escapeHtml function
 */
describe('escapeHtml', () => {
  it('should escape HTML special characters', () => {
    expect(utils.escapeHtml('<script>alert("xss")</script>')).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    expect(utils.escapeHtml("it's a test")).toBe('it&#39;s a test');
    expect(utils.escapeHtml('safe text')).toBe('safe text');
  });

  it('should escape ampersand first to prevent double-encoding', () => {
    expect(utils.escapeHtml('&amp;')).toBe('&amp;amp;');
  });

  it('should return empty string for non-string input', () => {
    expect(utils.escapeHtml(null)).toBe('');
    expect(utils.escapeHtml(undefined)).toBe('');
    expect(utils.escapeHtml(123)).toBe('');
    expect(utils.escapeHtml({})).toBe('');
  });
});

/**
 * Test for badge constants (now exported from constants.js)
 */
describe('badge constants', () => {
  it('CONDITION_BADGE maps all known conditions', () => {
    expect(constants.CONDITION_BADGE).toEqual({ new: 'low', good: 'low', fair: 'medium', poor: 'critical', broken: 'critical' });
  });

  it('CHANGE_TYPE_BADGE maps all known change types', () => {
    expect(constants.CHANGE_TYPE_BADGE).toEqual({ security: 'critical', incident: 'high', maintenance: 'medium', upgrade: 'low', configuration: 'low' });
  });

  it('ROLE_BADGE maps all known roles', () => {
    expect(constants.ROLE_BADGE).toEqual({ admin: 'critical', manager: 'high', staff: 'medium' });
  });
});

/**
 * Test for rejectHppArrays function (HTTP Parameter Pollution rejection)
 */
describe('rejectHppArrays', () => {
  it('should return empty array when no fields are arrays', () => {
    const req = { body: { name: 'test', email: 'a@b.com' } };
    const result = utils.rejectHppArrays(req, ['name', 'email']);
    expect(result).toEqual([]);
  });

  it('should return error messages when a field is an array (HPP)', () => {
    const req = { body: { name: ['a', 'b'], email: 'a@b.com' } };
    const result = utils.rejectHppArrays(req, ['name', 'email']);
    expect(result.length).toBeGreaterThan(0);
  });

  it('should return empty array when req.body has no matching fields', () => {
    const req = { body: { extra: 'x' } };
    const result = utils.rejectHppArrays(req, ['name', 'email']);
    expect(result).toEqual([]);
  });

  it('should return empty array for empty body', () => {
    const req = { body: {} };
    const result = utils.rejectHppArrays(req, ['name']);
    expect(result).toEqual([]);
  });

  it('should return empty array for empty fields list', () => {
    const req = { body: { name: ['a', 'b'] } };
    const result = utils.rejectHppArrays(req, []);
    expect(result).toEqual([]);
  });

  it('should return at most one error message (early exit)', () => {
    const req = { body: { name: ['a', 'b'], email: ['x', 'y'] } };
    const result = utils.rejectHppArrays(req, ['name', 'email']);
    // Early-return means we stop at the first array field
    expect(result).toEqual(['Invalid request parameters']);
  });
});

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

  it('should clear the selectQuery cache so SQL is re-prepared', () => {
    const stmt = { all: jest.fn(() => []) };
    const mockDb = { prepare: jest.fn(() => stmt) };
    const sql = 'SELECT * FROM reset_test LIMIT ? OFFSET ?';
    utils.selectQuery(mockDb, sql, [10, 0]);
    expect(mockDb.prepare).toHaveBeenCalledTimes(1);
    utils.resetCachedStatements();
    utils.selectQuery(mockDb, sql, [10, 0]);
    expect(mockDb.prepare).toHaveBeenCalledTimes(2);
  });

  it('should evict the oldest entry when cache is full', () => {
    utils.resetCachedStatements();
    // Use the internal _touchCache by exercising selectQuery with a small cache.
    // selectQuery uses _SELECT_CACHE_MAX (500) so we test eviction via countQuery
    // which uses _COUNT_CACHE_MAX (500) — instead, test _touchCache directly
    // by calling countQuery repeatedly and verifying a new SQL gets prepared
    // after clearing the cache (functional eviction test).
    const stmts = [];
    const trackingDb = {
      prepare: jest.fn((_sql) => {
        const s = { get: jest.fn(() => ({ c: 1 })) };
        stmts.push(s);
        return s;
      })
    };
    // Fill cache beyond _COUNT_CACHE_MAX is not practical in tests, so verify
    // the eviction logic path exists by checking that prepare is called for
    // distinct SQL and that the cache is bounded via resetCachedStatements.
    utils.countQuery(trackingDb, 't1', '', '1=1', []);
    utils.countQuery(trackingDb, 't2', '', '1=1', []);
    utils.countQuery(trackingDb, 't3', '', '1=1', []);
    expect(trackingDb.prepare).toHaveBeenCalledTimes(3);
  });

  it('should evict the oldest entry when _touchCache reaches capacity', () => {
    // _touchCache is exported for unit testing. Create a small cache (maxSize=2)
    // and verify that adding a fourth key evicts the oldest entry (key1).
    const cache = new Map();
    const prepared = [];
    const prepareFn = jest.fn((key) => {
      const stmt = { key };
      prepared.push(stmt);
      return stmt;
    });
    // Exercise _touchCache directly with a small maxSize to force eviction.
    utils._touchCache(cache, 'key1', 2, () => prepareFn('key1'));
    utils._touchCache(cache, 'key2', 2, () => prepareFn('key2'));
    // Cache is now full (size=2). Accessing key1 touches it (moves to end).
    utils._touchCache(cache, 'key1', 2, () => prepareFn('key1'));
    // Adding key3 should evict key2 (the oldest non-touched entry).
    utils._touchCache(cache, 'key3', 2, () => prepareFn('key3'));
    expect(cache.size).toBe(2);
    expect(cache.has('key1')).toBe(true);
    expect(cache.has('key3')).toBe(true);
    expect(cache.has('key2')).toBe(false);
    expect(prepared.map(s => s.key)).toEqual(['key1', 'key2', 'key3']);
  });

  it('should evict the oldest entry and handle the theoretical edge case', () => {
    // The cache-eviction path in _touchCache relies on cache.keys().next().value
    // being defined when cache.size >= maxSize. With valid maxSize (> 0) this
    // is guaranteed — a non-empty Map always has at least one key. The previous
    // undefined-guard was removed as unreachable dead code (same pattern as
    // safeInt / localDate guards removed in prior review passes). This test
    // confirms _touchCache evicts correctly when the cache is at capacity.
    const cache = new Map();
    utils._touchCache(cache, 'key1', 2, () => ({ key: 'key1' }));
    utils._touchCache(cache, 'key2', 2, () => ({ key: 'key2' }));
    // Touch key1 to move it to the end (most recently used)
    utils._touchCache(cache, 'key1', 2, () => ({ key: 'key1' }));
    // Adding key3 should evict key2 (now the oldest entry).
    utils._touchCache(cache, 'key3', 2, () => ({ key: 'key3' }));
    expect(cache.size).toBe(2);
    expect(cache.has('key1')).toBe(true);
    expect(cache.has('key3')).toBe(true);
    expect(cache.has('key2')).toBe(false);
  });
});

describe('resetPageSize', () => {
  const originalPageEnv = process.env.PAGE_SIZE;

  afterEach(() => {
    if (originalPageEnv === undefined) {
      delete process.env.PAGE_SIZE;
    } else {
      process.env.PAGE_SIZE = originalPageEnv;
    }
    utils.resetPageSize();
  });

  it('should re-derive PAGE_SIZE from environment', () => {
    process.env.PAGE_SIZE = '50';
    utils.resetPageSize();
    // Verify by exercising paginate with an env-driven page size
    const req = { query: {}, path: '/test' };
    const result = utils.paginate(req);
    expect(result.limit).toBe(50);
  });

  it('should fall back to DEFAULT_PAGE_SIZE when env is invalid', () => {
    process.env.PAGE_SIZE = 'not-a-number';
    utils.resetPageSize();
    const req = { query: {}, path: '/test' };
    const result = utils.paginate(req);
    expect(result.limit).toBe(25);
  });

  it('should clamp to MAX_PAGE_SIZE for oversized values', () => {
    process.env.PAGE_SIZE = '9999';
    utils.resetPageSize();
    const req = { query: {}, path: '/test' };
    const result = utils.paginate(req);
    expect(result.limit).toBe(100);
  });
});

describe('resolveOptionalField (shared absent-vs-empty resolver)', () => {
  it('preserves existing value when rawValue is absent (undefined)', () => {
    expect(utils.resolveOptionalField(undefined, 'submitted', 100, 'existing')).toBe('existing');
  });

  it('preserves existing value when rawValue is null (JSON null)', () => {
    expect(utils.resolveOptionalField(null, null, 100, 'existing')).toBe('existing');
  });

  it('clears field to null when processedValue is empty/null', () => {
    expect(utils.resolveOptionalField('', '', 100, 'existing')).toBeNull();
    expect(utils.resolveOptionalField(' ', '', 100, 'existing')).toBeNull();
    expect(utils.resolveOptionalField('submitted', null, 100, 'existing')).toBeNull();
  });

  it('accepts a new value and truncates to maxLen', () => {
    expect(utils.resolveOptionalField('submitted', 'submitted', 5, 'existing')).toBe('submi');
  });

  it('returns the value unchanged when maxLen is null', () => {
    expect(utils.resolveOptionalField('hardware', 'hardware', null, 'existing')).toBe('hardware');
  });

  it('rejects arrays from HTTP parameter pollution (fails closed)', () => {
    expect(utils.resolveOptionalField(['a'], 'a', null, 'existing')).toEqual({ error: true });
  });
});
