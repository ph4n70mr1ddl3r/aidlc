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

const { validateVendorRating, resolveClearableDate, resolveOptionalTextField, resolveVendorRatingOnUpdate } = require('../src/routes/vendors');

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
    // guard now fails closed and surfaces a validation error.
    expect(validateVendorRating(['3', '99'])).toEqual({ value: null, error: 'Rating must be a whole number between 1 and 5' });
    expect(validateVendorRating(['1'])).toEqual({ value: null, error: 'Rating must be a whole number between 1 and 5' });
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

  it('rejects a present but malformed (non-array) date as invalid input (fail closed)', () => {
    // A malformed date must NOT silently wipe the stored value to NULL — it must
    // surface as an error so the update fails closed. Previously this fell through
    // to safeDate() and returned NULL, overwriting a legitimate stored date.
    expect(resolveClearableDate('not-a-date', '2024-01-01')).toEqual({ error: true });
    expect(resolveClearableDate('2026-13-01', '2024-01-01')).toEqual({ error: true });
  });

  it('rejects arrays (parameter pollution) as invalid input', () => {
    // A polluted ?contract_start[]=a&contract_start[]=b payload must not be
    // silently accepted (preserving or clearing the stored date); it is invalid
    // input and must surface as an error so the update fails closed.
    expect(resolveClearableDate(['2025-01-01'], '2024-01-01')).toEqual({ error: true });
  });
});

describe('resolveOptionalTextField (absent-vs-empty clearing)', () => {
  it('preserves existing value when rawValue is absent (undefined)', () => {
    expect(resolveOptionalTextField(undefined, 'submitted', 100, 'existing')).toBe('existing');
  });

  it('clears field to null when processedValue is empty/null', () => {
    expect(resolveOptionalTextField('', '', 100, 'existing')).toBeNull();
    expect(resolveOptionalTextField(' ', '', 100, 'existing')).toBeNull();
    expect(resolveOptionalTextField('submitted', null, 100, 'existing')).toBeNull();
  });

  it('accepts a new value and truncates to maxLen', () => {
    expect(resolveOptionalTextField('submitted', 'submitted', 5, 'existing')).toBe('submi');
  });

  it('returns the value unchanged when maxLen is null', () => {
    expect(resolveOptionalTextField('hardware', 'hardware', null, 'existing')).toBe('hardware');
  });

  it('rejects arrays from HTTP parameter pollution (fails closed)', () => {
    // Mirrors the array guards across the codebase: a polluted payload must not
    // silently clear or apply stored data, so it returns { error: true }.
    expect(resolveOptionalTextField(['a'], 'a', null, 'existing')).toEqual({ error: true });
  });
});

describe('resolveVendorRatingOnUpdate (rating preservation)', () => {
  // Regression: the vendor update route previously cleared an existing rating
  // whenever the form's number input submitted an empty string (rawValue === ''),
  // because it routed rating through the generic "empty text clears" path. Since
  // rating is a discrete 1-5 value, an empty submission must PRESERVE the stored
  // rating so editing any other vendor field does not wipe it.
  it('preserves the existing rating when the field is absent (partial submission)', () => {
    expect(resolveVendorRatingOnUpdate(undefined, 4, 3)).toBe(3);
    expect(resolveVendorRatingOnUpdate(undefined, null, 5)).toBe(5);
  });

  it('preserves the existing rating when an empty value is submitted', () => {
    expect(resolveVendorRatingOnUpdate('', null, 3)).toBe(3);
    expect(resolveVendorRatingOnUpdate('  ', null, 5)).toBe(5);
  });

  it('replaces the rating with a validated non-empty value', () => {
    expect(resolveVendorRatingOnUpdate('4', 4, 2)).toBe(4);
    expect(resolveVendorRatingOnUpdate('1', 1, 5)).toBe(1);
  });
});
