const { describe, it, expect } = require('@jest/globals');
const { lastHandlerFor } = require('./helpers');

// Mock dependencies so the changes route module loads in isolation (same pattern
// as vendors.test.js / knowledge.test.js).
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
      expect(resolveDateTimeField(['2024-01-15T10:00'], null)).toEqual({ error: true });
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

    it('rejects arrays (parameter pollution) as invalid input', () => {
      expect(resolveDateTimeField(['2024-02-20T09:30'], existing)).toEqual({ error: true });
    });
  });
});

describe('Change update — absent description/impact preserves, empty clears (regression)', () => {
  const changesRouter = require('../src/routes/changes');

  // The change UPDATE run has 12 args; find it by length (no other update in
  // this handler is 12-arg).
  // [title(0), description(1), change_type(2), status(3), priority(4),
  //  scheduled_start(5), scheduled_end(6), actual_start(7), actual_end(8),
  //  impact(9), assigned_to(10), id(11)]
  function changeUpdateParams() {
    const db = jest.requireMock('../src/models/database');
    return db.prepare().run.mock.calls.find(c => c.length === 12);
  }

  const existingRow = {
    id: 1, title: 'Old title', description: 'Stored description', change_type: 'maintenance',
    status: 'scheduled', priority: 'medium', scheduled_start: null, scheduled_end: null,
    actual_start: null, actual_end: null, impact: 'Stored impact', assigned_to: null,
    created_at: null, updated_at: null
  };

  it('preserves stored description and impact when the fields are ABSENT (partial API submission)', () => {
    // Regression: previously the update used (description || '').substring(...)
    // || null and (impact || '').substring(...) || null, so absent fields wiped
    // the stored values to NULL on a partial submission — inconsistent with the
    // route's own absent-vs-empty convention for datetimes/assignee.
    const db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    stmt.get.mockReturnValue(existingRow);
    stmt.run.mockClear();
    const h = lastHandlerFor(changesRouter, 'put', '/:id');
    const req = { body: { title: 'New title', change_type: 'maintenance', status: 'scheduled' }, params: { id: '1' }, flash: () => {}, audit: jest.fn() };
    const res = { redirect: () => {}, render: () => {}, status: () => res, json: () => {} };
    h(req, res, () => {});
    const params = changeUpdateParams();
    expect(params).toBeDefined();
    expect(params[1]).toBe('Stored description'); // preserved — not wiped to NULL
    expect(params[9]).toBe('Stored impact');
  });

  it('clears stored description and impact when the fields are submitted empty', () => {
    const db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    stmt.get.mockReturnValue(existingRow);
    stmt.run.mockClear();
    const h = lastHandlerFor(changesRouter, 'put', '/:id');
    const req = { body: { title: 'New title', change_type: 'maintenance', status: 'scheduled', description: '', impact: '' }, params: { id: '1' }, flash: () => {}, audit: jest.fn() };
    const res = { redirect: () => {}, render: () => {}, status: () => res, json: () => {} };
    h(req, res, () => {});
    const params = changeUpdateParams();
    expect(params).toBeDefined();
    expect(params[1]).toBeNull(); // empty submitted value clears the field
    expect(params[9]).toBeNull();
  });

  it('updates description and impact when new values are submitted', () => {
    const db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    stmt.get.mockReturnValue(existingRow);
    stmt.run.mockClear();
    const h = lastHandlerFor(changesRouter, 'put', '/:id');
    const req = { body: { title: 'New title', change_type: 'maintenance', status: 'scheduled', description: 'New description', impact: 'New impact' }, params: { id: '1' }, flash: () => {}, audit: jest.fn() };
    const res = { redirect: () => {}, render: () => {}, status: () => res, json: () => {} };
    h(req, res, () => {});
    const params = changeUpdateParams();
    expect(params).toBeDefined();
    expect(params[1]).toBe('New description');
    expect(params[9]).toBe('New impact');
  });
});
