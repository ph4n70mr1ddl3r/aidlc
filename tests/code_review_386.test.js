const { describe, it, expect, beforeEach } = require('@jest/globals');
const { lastHandlerFor } = require('./helpers');

jest.mock('better-sqlite3');
jest.mock('../src/models/database', () => {
  const stmt = { get: jest.fn(() => null), all: jest.fn(() => []), run: jest.fn(() => ({ changes: 1, lastInsertRowid: 1 })) };
  return { prepare: jest.fn(() => stmt), exec: jest.fn(), pragma: jest.fn(), transaction: jest.fn((fn) => fn), close: jest.fn() };
});
jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => next(),
  requireAdminOrManager: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
  canAccessResource: jest.fn(() => true)
}));
jest.mock('../src/middleware/audit', () => ({
  audit: jest.fn(),
  auditMiddleware: (req, res, next) => {
    req.audit = jest.fn(); next();
  }
}));
jest.mock('../src/routes/dashboard', () => {
  const Router = require('express').Router;
  const router = Router();
  router.invalidateDashboardCache = jest.fn();
  return router;
});
jest.mock('../src/routes/auth', () => ({
  clearLoginFailure: jest.fn(),
  clearIpLoginFailure: jest.fn()
}));

function runHandler(handler, { params = { id: '1' }, body = {}, sessionUser = { id: 99, role: 'manager' } } = {}) {
  const redirectCalls = [];
  const flashCalls = [];
  const auditCalls = [];
  const req = {
    body, params, method: 'PUT', session: { user: sessionUser },
    flash: (type, msg) => flashCalls.push([type, msg]),
    audit: (...args) => auditCalls.push(args)
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
  return { redirectCalls, flashCalls, auditCalls };
}

function resetStmt({ get, run } = {}) {
  const db = jest.requireMock('../src/models/database');
  const stmt = db.prepare();
  stmt.get.mockReset();
  stmt.all.mockReset();
  stmt.run.mockReset();
  stmt.get.mockReturnValue(get === undefined ? null : get);
  stmt.all.mockReturnValue([]);
  stmt.run.mockReturnValue(run === undefined ? { changes: 1, lastInsertRowid: 1 } : run);
  return stmt;
}

describe('staff refusal wording (pass 386)', () => {
  const staffRouter = require('../src/routes/staff');

  // Source-level pin: every refusal branch in staff.js uses the single
  // non-enumerating wording, so a manager probing IDs cannot distinguish an
  // existing privileged account from a missing one.
  it('source pins the single non-enumerating refusal message', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../src/routes/staff'), 'utf8');
    // The three old denial wordings must no longer appear anywhere in staff.js.
    expect(src).not.toContain('You cannot modify administrator or manager accounts.');
    expect(src).not.toContain('Only administrators can assign the manager or admin role.');
    expect(src).not.toContain('You cannot change your own role.');
    // The single non-enumerating wording is used for every refusal branch.
    expect(src).toContain("req.flash('error', 'Staff member not found')");
  });

  const ADMIN_TARGET = { id: 1, username: 'admin', role: 'admin', is_active: 1 };
  const STAFF_TARGET = { id: 2, username: 'staff1', role: 'staff', is_active: 1 };

  beforeEach(() => resetStmt({ get: ADMIN_TARGET }));

  it('edit: manager probing an admin account gets "Staff member not found" (not a distinct denial)', () => {
    resetStmt({ get: ADMIN_TARGET });
    const h = lastHandlerFor(staffRouter, 'get', '/:id/edit');
    const { redirectCalls, flashCalls, auditCalls } = runHandler(h, { sessionUser: { id: 9, role: 'manager' } });
    expect(redirectCalls).toEqual(['/staff']);
    expect(flashCalls).toContainEqual(['error', 'Staff member not found']);
    expect(auditCalls.some(([a]) => a === 'access_denied')).toBe(true);
  });

  it('edit: missing account also gets "Staff member not found" (identical wording)', () => {
    resetStmt({ get: null });
    const h = lastHandlerFor(staffRouter, 'get', '/:id/edit');
    const { redirectCalls, flashCalls, auditCalls } = runHandler(h, { sessionUser: { id: 9, role: 'manager' } });
    expect(redirectCalls).toEqual(['/staff']);
    expect(flashCalls).toContainEqual(['error', 'Staff member not found']);
    expect(auditCalls.some(([a]) => a === 'access_denied')).toBe(false);
  });

  it('update: manager omitting role on a privileged account gets "Staff member not found"', () => {
    resetStmt({ get: ADMIN_TARGET, run: { changes: 1 } });
    const h = lastHandlerFor(staffRouter, 'put', '/:id');
    const { redirectCalls, flashCalls, auditCalls } = runHandler(h, {
      body: { email: 'admin@example.com', first_name: 'Admin', last_name: 'User', department: 'IT' },
      sessionUser: { id: 9, role: 'manager' }
    });
    expect(redirectCalls).toEqual(['/staff']);
    expect(flashCalls).toContainEqual(['error', 'Staff member not found']);
    expect(auditCalls.some(([a]) => a === 'access_denied')).toBe(true);
  });

  it('update: manager assigning a privileged role gets "Staff member not found"', () => {
    resetStmt({ get: STAFF_TARGET, run: { changes: 1 } });
    const h = lastHandlerFor(staffRouter, 'put', '/:id');
    const { redirectCalls, flashCalls, auditCalls } = runHandler(h, {
      body: { email: 'staff1@example.com', first_name: 'Staff', last_name: 'One', role: 'manager' },
      sessionUser: { id: 9, role: 'manager' }
    });
    expect(redirectCalls).toEqual(['/staff']);
    expect(flashCalls).toContainEqual(['error', 'Staff member not found']);
    expect(auditCalls.some(([a]) => a === 'access_denied')).toBe(true);
  });

  it('update: admin changing their own role gets "Staff member not found"', () => {
    resetStmt({ get: ADMIN_TARGET, run: { changes: 1 } });
    const h = lastHandlerFor(staffRouter, 'put', '/:id');
    const { redirectCalls, flashCalls, auditCalls } = runHandler(h, {
      body: { email: 'admin@example.com', first_name: 'Admin', last_name: 'User', role: 'staff' },
      sessionUser: { id: 1, role: 'admin' }
    });
    expect(redirectCalls).toEqual(['/staff']);
    expect(flashCalls).toContainEqual(['error', 'Staff member not found']);
    expect(auditCalls.some(([a]) => a === 'access_denied')).toBe(true);
  });

  it('update: manager editing another manager gets "Staff member not found"', () => {
    resetStmt({ get: ADMIN_TARGET, run: { changes: 1 } });
    const h = lastHandlerFor(staffRouter, 'put', '/:id');
    const { redirectCalls, flashCalls, auditCalls } = runHandler(h, {
      body: { email: 'admin@example.com', first_name: 'Admin', last_name: 'User' },
      sessionUser: { id: 9, role: 'manager' }
    });
    expect(redirectCalls).toEqual(['/staff']);
    expect(flashCalls).toContainEqual(['error', 'Staff member not found']);
    expect(auditCalls.some(([a]) => a === 'access_denied')).toBe(true);
  });
});
