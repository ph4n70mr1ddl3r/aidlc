const { describe, it, expect } = require('@jest/globals');

// Mock dependencies so the changes route module loads in isolation (same pattern
// as vendors.test.js / knowledge.test.js).
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

const { resolveDateTimeField } = require('../src/routes/changes');

describe('resolveDateTimeField', () => {
  // The create route calls resolveDateTimeField(value, null); the update route
  // passes the stored row. Both paths must agree on every input class, otherwise
  // a malformed datetime accepted (silently dropped) on create would be rejected
  // on edit — the exact inconsistency this regression test guards against.
  describe('create path (existingValue = null)', () => {
    it('accepts a valid datetime-local value', () => {
      expect(resolveDateTimeField('2024-01-15T10:00', null)).toEqual({ value: '2024-01-15 10:00' });
    });

    it('treats empty string as "no date" (null)', () => {
      expect(resolveDateTimeField('', null)).toEqual({ value: null });
    });

    it('treats absent / null as "no date" (null)', () => {
      expect(resolveDateTimeField(undefined, null)).toEqual({ value: null });
      expect(resolveDateTimeField(null, null)).toEqual({ value: null });
    });

    // Regression: previously the create route ran the raw value through
    // safeDateTimeLocal() directly, which returns null for malformed input, so
    // an invalid datetime was silently stored as "no date". The update route
    // rejected the same input. create must now reject it too.
    it('rejects a non-empty invalid datetime instead of silently dropping it', () => {
      expect(resolveDateTimeField('not-a-date', null)).toEqual({ error: true });
      expect(resolveDateTimeField('2024-13-99T99:99', null)).toEqual({ error: true });
    });

    it('rejects arrays from HTTP parameter pollution', () => {
      expect(resolveDateTimeField(['2024-01-15T10:00'], null)).toEqual({ value: null });
    });
  });

  describe('update path (existingValue preserved)', () => {
    const existing = '2024-01-15 10:00';

    it('preserves the existing value when the field is absent', () => {
      expect(resolveDateTimeField(undefined, existing)).toEqual({ value: existing });
      expect(resolveDateTimeField(null, existing)).toEqual({ value: existing });
    });

    it('clears the field when an empty value is submitted', () => {
      expect(resolveDateTimeField('', existing)).toEqual({ value: null });
    });

    it('accepts a new valid datetime', () => {
      expect(resolveDateTimeField('2024-02-20T09:30', existing)).toEqual({ value: '2024-02-20 09:30' });
    });

    it('rejects an invalid datetime', () => {
      expect(resolveDateTimeField('garbage', existing)).toEqual({ error: true });
    });

    it('rejects arrays (parameter pollution) by preserving existing', () => {
      expect(resolveDateTimeField(['2024-02-20T09:30'], existing)).toEqual({ value: existing });
    });
  });
});
