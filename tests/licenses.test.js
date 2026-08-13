const { describe, it, expect } = require('@jest/globals');
const { lastHandlerFor } = require('./helpers');

// Mock dependencies so the licenses route module loads in isolation (same pattern
// as vendors.test.js / changes.test.js).
jest.mock('../src/models/database', () => {
  const stmt = { get: jest.fn(() => null), all: jest.fn(() => []), run: jest.fn(() => ({ changes: 0 })) };
  return { prepare: jest.fn(() => stmt), exec: jest.fn(), pragma: jest.fn(), transaction: jest.fn((fn) => fn) };
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

    it('clamps total seats to a minimum of 1 when a non-negative value is given', () => {
      expect(resolveSeats('0', '0', null)).toEqual({ seats: 1, used: 0, error: null });
    });

    it('rejects a present negative total seats (fail-closed)', () => {
      expect(resolveSeats('-5', '0', null).error).toBe('Invalid total seats');
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
    it('rejects negative used seats (fail-closed, no silent coercion)', () => {
      // A PRESENT non-numeric/negative value must be rejected rather than
      // silently collapsed to the default count.
      const r = resolveSeats('10', '-1', null);
      expect(r.error).toBe('Invalid used seats');
    });

    it('rejects used exceeding total', () => {
      expect(resolveSeats('5', '6', null).error).toBe('Used seats cannot exceed total seats');
    });

    it('rejects garbled total_seats (fail-closed)', () => {
      expect(resolveSeats('abc', '3', null).error).toBe('Invalid total seats');
    });

    it('rejects garbled used_seats (fail-closed)', () => {
      expect(resolveSeats('10', '12.5', null).error).toBe('Invalid used seats');
    });

    it('rejects garbled seats on partial update (fail-closed, not coerced to existing)', () => {
      const existing = { total_seats: 25, used_seats: 7 };
      expect(resolveSeats('garbage', '', existing).error).toBe('Invalid total seats');
      expect(resolveSeats('', 'oops', existing).error).toBe('Invalid used seats');
    });

    it('rejects HPP arrays (fail-closed, not coerced)', () => {
      const r = resolveSeats(['3', '9'], ['1'], null);
      expect(r.error).toBe('Invalid total seats');
    });
  });
});

describe('License update — date range validated against resolved values (regression)', () => {
  const licensesRouter = require('../src/routes/licenses');

  it('rejects a partial update that would persist expiry_date before purchase_date', () => {
    // Stored: purchase=2026-01-01, expiry=2026-06-01. The edit moves purchase_date
    // forward to 2026-12-01 and leaves expiry_date empty. The submitted-only
    // range check (submitted sExpiry is null) passes, but the RESOLVED expiry is
    // still the stored 2026-06-01 → expiry < purchase must be rejected (mirrors
    // the assets.js / projects.js resolved-value fix), not silently persisted.
    const db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    stmt.get.mockReturnValue({
      id: 1, software_name: 'Adobe Photoshop', vendor: null, license_key: null, license_type: null,
      total_seats: 25, used_seats: 7, purchase_date: '2026-01-01', expiry_date: '2026-06-01',
      cost: 100, notes: null, created_at: null, updated_at: null
    });
    stmt.run.mockClear();
    const h = lastHandlerFor(licensesRouter, 'put', '/:id');
    const redirectCalls = [];
    const flashCalls = [];
    const req = { body: { software_name: 'Adobe Photoshop', purchase_date: '2026-12-01' }, params: { id: '1' }, flash: (t, m) => flashCalls.push([t, m]), audit: jest.fn() };
    const res = { redirect: (to) => redirectCalls.push(to), render: () => {}, status: () => res, json: () => {} };
    h(req, res, () => {});
    expect(redirectCalls).toEqual(['/licenses/1/edit']);
    const errorFlash = flashCalls.find(([t]) => t === 'error');
    expect(errorFlash).toBeDefined();
    expect(errorFlash[1]).toBe('Expiry date must be on or after purchase date');
    expect(stmt.run).not.toHaveBeenCalled();
  });
});
