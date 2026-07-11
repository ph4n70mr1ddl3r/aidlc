const { describe, it, expect } = require('@jest/globals');

// Mock dependencies so the vendors route module loads in isolation (same pattern
// as tickets.test.js / knowledge.test.js).
jest.mock('../src/models/database', () => {
  const stmt = { get: jest.fn(() => null), all: jest.fn(() => []), run: jest.fn(() => ({ changes: 0 })) };
  return { prepare: jest.fn(() => stmt), exec: jest.fn(), pragma: jest.fn() };
});

jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => next(),
  requireAdminOrManager: (req, res, next) => next()
}));

jest.mock('../src/middleware/audit', () => ({
  audit: jest.fn(),
  auditMiddleware: (req, res, next) => {
    req.audit = jest.fn();
    next();
  }
}));

jest.mock('../src/routes/dashboard', () => {
  const Router = require('express').Router;
  const router = Router();
  router.invalidateDashboardCache = jest.fn();
  return router;
});

const { validateVendorRating, resolveClearableDate } = require('../src/routes/vendors');

describe('validateVendorRating', () => {
  it('parses a valid integer rating in range', () => {
    expect(validateVendorRating('4')).toEqual({ value: 4, error: null });
    expect(validateVendorRating('1')).toEqual({ value: 1, error: null });
    expect(validateVendorRating('5')).toEqual({ value: 5, error: null });
  });

  it('treats empty / absent / null as optional (no error, null value)', () => {
    expect(validateVendorRating('')).toEqual({ value: null, error: null });
    expect(validateVendorRating(undefined)).toEqual({ value: null, error: null });
    expect(validateVendorRating(null)).toEqual({ value: null, error: null });
  });

  it('rejects out-of-range ratings with a clear error', () => {
    expect(validateVendorRating('0')).toEqual({ value: null, error: 'Rating must be between 1 and 5' });
    expect(validateVendorRating('6')).toEqual({ value: null, error: 'Rating must be between 1 and 5' });
  });

  it('rejects non-numeric input', () => {
    expect(validateVendorRating('abc')).toEqual({ value: null, error: 'Rating must be a whole number between 1 and 5' });
  });

  it('trims whitespace before parsing', () => {
    expect(validateVendorRating(' 3 ')).toEqual({ value: 3, error: null });
    expect(validateVendorRating('4 ')).toEqual({ value: 4, error: null });
    expect(validateVendorRating(' 5')).toEqual({ value: 5, error: null });
  });

  it('rejects arrays from HTTP parameter pollution (regression: parseInt coerced ["3","99"] to 3)', () => {
    // Before the fix, parseInt(["3","99"]) === parseInt("3,99") === 3, so a
    // crafted ?rating[]=3&rating[]=99 payload was silently accepted. The array
    // guard mirrors safeId / safeInt / safePositiveFloat.
    expect(validateVendorRating(['3', '99'])).toEqual({ value: null, error: null });
    expect(validateVendorRating(['1'])).toEqual({ value: null, error: null });
  });
});

describe('resolveClearableDate (contract date clearing)', () => {
  // Regression: the vendor update route used `parsed !== null ? parsed : existing`,
  // so an empty submitted contract date fell back to the existing value — it was
  // impossible to clear a contract date via the edit form. The helper now
  // distinguishes absent (preserve existing) from empty (clear to null),
  // matching every other optional field on the form and the create route.
  it('preserves the existing value when the field is absent', () => {
    expect(resolveClearableDate(undefined, '2024-01-01')).toBe('2024-01-01');
  });

  it('clears the date (null) when an empty value is submitted', () => {
    expect(resolveClearableDate('', '2024-01-01')).toBeNull();
  });

  it('accepts a new valid date', () => {
    expect(resolveClearableDate('2025-06-30', '2024-01-01')).toBe('2025-06-30');
  });

  it('treats an invalid date the same as empty (clear to null), matching the create route', () => {
    expect(resolveClearableDate('not-a-date', '2024-01-01')).toBeNull();
  });

  it('preserves existing when given an array (parameter pollution)', () => {
    // Mirrors the array guards across the codebase: a polluted
    // ?contract_start[]=a&contract_start[]=b payload must not silently clear
    // the stored date (safeDate would otherwise null out a non-string input).
    expect(resolveClearableDate(['2025-01-01'], '2024-01-01')).toBe('2024-01-01');
  });
});
