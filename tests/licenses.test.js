const { describe, it, expect } = require('@jest/globals');

// Mock dependencies so the licenses route module loads in isolation (same pattern
// as vendors.test.js / changes.test.js).
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

const { resolveSeats } = require('../src/routes/licenses');

describe('resolveSeats', () => {
  describe('create path (existing = null)', () => {
    it('uses submitted values when present', () => {
      expect(resolveSeats('10', '3', null)).toEqual({ seats: 10, used: 3, error: null });
    });

    it('defaults to 1 total / 0 used when fields are absent', () => {
      expect(resolveSeats(undefined, undefined, null)).toEqual({ seats: 1, used: 0, error: null });
      expect(resolveSeats('', '', null)).toEqual({ seats: 1, used: 0, error: null });
    });

    it('clamps total seats to a minimum of 1', () => {
      expect(resolveSeats('0', '0', null)).toEqual({ seats: 1, used: 0, error: null });
      expect(resolveSeats('-5', '0', null)).toEqual({ seats: 1, used: 0, error: null });
    });
  });

  describe('update path (existing row provided)', () => {
    const existing = { total_seats: 25, used_seats: 7 };

    it('overrides existing when fields are submitted', () => {
      expect(resolveSeats('50', '12', existing)).toEqual({ seats: 50, used: 12, error: null });
    });

    // Regression: previously absent fields reset seats to 1/0 because the
    // update route used safeInt(total_seats, 1) / safeInt(used_seats, 0)
    // without consulting the stored row, silently wiping seat counts on a
    // partial submission. Every other entity (projects spent/budget, vendors
    // optional fields, changes datetimes) preserves stored values.
    it('preserves existing counts when fields are absent (partial submission)', () => {
      expect(resolveSeats(undefined, undefined, existing)).toEqual({ seats: 25, used: 7, error: null });
      expect(resolveSeats('', '', existing)).toEqual({ seats: 25, used: 7, error: null });
    });

    it('preserves only the absent field (mixed partial submission)', () => {
      expect(resolveSeats(undefined, '10', existing)).toEqual({ seats: 25, used: 10, error: null });
      expect(resolveSeats('40', undefined, existing)).toEqual({ seats: 40, used: 7, error: null });
    });
  });

  describe('validation', () => {
    it('rejects negative used seats', () => {
      expect(resolveSeats('10', '-1', null).error).toBe('Used seats cannot be negative');
    });

    it('rejects used exceeding total', () => {
      expect(resolveSeats('5', '6', null).error).toBe('Used seats cannot exceed total seats');
    });

    it('rejects HPP arrays (falls back instead of coercing ["3","9"] to 3)', () => {
      // safeInt rejects arrays, so a polluted payload falls back to the
      // create defaults rather than silently storing parseInt("3,9") === 3.
      expect(resolveSeats(['3', '9'], ['1'], null)).toEqual({ seats: 1, used: 0, error: null });
    });
  });
});
