const { describe, it, expect, beforeEach } = require('@jest/globals');
const { lastHandlerFor } = require('./helpers');

// Regression tests for Number() coercion consistency in identity/self-checks.
// The codebase convention (established in staff.js line 322 and knowledge.js
// show/edit/update/delete routes) is to use Number(...) === Number(...) when
// comparing a route-param id against req.session.user.id, because safeId()
// returns a number but future callers or mocks might pass strings. These tests
// pin the convention so a future refactor cannot silently drop the coercion.

// ---------------------------------------------------------------------------
// canAccessResource — resource id coercion via Number()
// ---------------------------------------------------------------------------
describe('canAccessResource — Number() coercion on resource id', () => {
  // Clear any module cache so we get the real middleware (not the generic
  // test mock that returns true for everything).
  jest.resetModules();
  const { canAccessResource } = require('../src/middleware/auth');

  it('matches when resource id is a string and session user id is a number', () => {
    // A resource row from better-sqlite3 always returns numbers for INTEGER
    // columns, but mocks or future DB drivers could return strings. The
    // Number() coercion ensures both sides are compared as numbers.
    expect(canAccessResource(
      { session: { user: { id: 5 } } },
      { assigned_to: '5' }
    )).toBe(true);
  });

  it('matches when both ids are strings', () => {
    expect(canAccessResource(
      { session: { user: { id: '7' } } },
      { owner_id: '7' }
    )).toBe(true);
  });

  it('does not match when ids differ after coercion', () => {
    expect(canAccessResource(
      { session: { user: { id: 3 } } },
      { assigned_to: '9' }
    )).toBe(false);
  });

  it('returns false when resource field is null (short-circuits before Number())', () => {
    expect(canAccessResource(
      { session: { user: { id: 1 } } },
      { assigned_to: null }
    )).toBe(false);
  });

  it('returns false when resource field is undefined', () => {
    expect(canAccessResource(
      { session: { user: { id: 1 } } },
      { assigned_to: undefined }
    )).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// staff routes — self-check uses Number() coercion on id
// ---------------------------------------------------------------------------
describe('staff routes — self-check uses Number() coercion (regression)', () => {
  // Load the real route with the same mock pattern used by other route tests
  // (changes.test.js / code_review_114.test.js).
  jest.mock('better-sqlite3');
  jest.mock('../src/models/database', () => {
    const stmt = {
      get: jest.fn(),
      all: jest.fn(() => []),
      run: jest.fn(() => ({ changes: 1, lastInsertRowid: 1 }))
    };
    return {
      prepare: jest.fn(() => stmt),
      exec: jest.fn(),
      pragma: jest.fn(() => 1),
      transaction: jest.fn((fn) => fn()),
      close: jest.fn()
    };
  });
  jest.mock('../src/middleware/auth', () => ({
    requireAuth: (req, res, next) => next(),
    requireAdminOrManager: (req, res, next) => next(),
    requireAdmin: (req, res, next) => next()
  }));
  jest.mock('../src/middleware/audit', () => ({
    auditMiddleware: (req, res, next) => next()
  }));
  jest.mock('../src/routes/dashboard', () => {
    const Router = require('express').Router;
    const router = Router();
    router.invalidateDashboardCache = jest.fn();
    return router;
  });
  jest.mock('../src/routes/auth', () => ({
    clearLoginFailure: jest.fn()
  }));
  jest.mock('bcryptjs', () => ({
    hash: jest.fn(() => Promise.resolve('h')),
    hashSync: jest.fn(() => 'h'),
    compare: jest.fn(() => Promise.resolve(true))
  }));

  function runHandler(handler, body, params = {}, sessionUser = { id: 1, role: 'admin' }) {
    const redirectCalls = [];
    const flashCalls = [];
    const req = {
      params,
      method: 'PUT',
      body,
      session: { user: sessionUser },
      flash: (type, msg) => flashCalls.push([type, msg]),
      audit: jest.fn()
    };
    const res = {
      redirect: (to) => {
        redirectCalls.push(to);
      },
      render: () => {},
      status: () => res,
      json: () => {},
      end: () => {}
    };
    handler(req, res, () => {});
    return { redirectCalls, flashCalls, req };
  }

  function errorFlash(flashCalls) {
    const found = flashCalls.find(([t]) => t === 'error');
    return found ? found[1] : undefined;
  }

  beforeEach(() => {
    const db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    stmt.run.mockClear();
    stmt.get.mockClear();
    // The update route fetches the target user via _staffUserStmt.get(id).
    // Return a valid row so the handler reaches the self-role guard.
    stmt.get.mockReturnValue({ id: 1, role: 'admin', username: 'admin', is_active: 1 });
  });

  it('update route rejects role change when id is passed as a string matching the session user', () => {
    // The guard is: if (Number(id) === Number(req.session.user.id) && safeRole !== req.session.user.role)
    // Pass a string id that matches the numeric session user id — must still
    // trigger the self-role-change guard.
    const staffRouter = require('../src/routes/staff');
    const h = lastHandlerFor(staffRouter, 'put', '/:id');
    const { redirectCalls, flashCalls } = runHandler(h, {
      email: 'a@b.co', first_name: 'A', last_name: 'B', role: 'manager'
    }, { id: '1' }, { id: 1, role: 'admin' });
    expect(redirectCalls).toEqual(['/staff/1/edit']);
    expect(errorFlash(flashCalls)).toBe('You cannot change your own role');
  });

  it('password reset route rejects self-service when id is passed as a string', () => {
    // Guard: if (Number(id) === Number(req.session.user.id)) → redirect to /staff/:id
    const staffRouter = require('../src/routes/staff');
    const h = lastHandlerFor(staffRouter, 'put', '/:id/reset-password');
    const { redirectCalls, flashCalls } = runHandler(h, {
      new_password: 'NewPass1!xyz', current_password: 'OldPass1!xyz'
    }, { id: '1' }, { id: 1, role: 'admin' });
    expect(redirectCalls).toEqual(['/staff/1']);
    expect(errorFlash(flashCalls)).toBe('You cannot reset your own password via this route');
  });

  it('deactivate route rejects self-deactivation when id is passed as a string', () => {
    // Guard: if (Number(id) === Number(req.session.user.id)) → block
    const staffRouter = require('../src/routes/staff');
    const h = lastHandlerFor(staffRouter, 'delete', '/:id');
    const { redirectCalls, flashCalls } = runHandler(h, {}, { id: '1' }, { id: 1, role: 'admin' });
    expect(redirectCalls).toEqual(['/staff']);
    expect(errorFlash(flashCalls)).toBe('You cannot deactivate your own account');
  });
});
