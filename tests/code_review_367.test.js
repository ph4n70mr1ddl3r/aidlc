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

function runHandler(handler, { params = { id: '1' }, body = {}, sessionUser = { id: 99, role: 'admin' } } = {}) {
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
    render: () => {}, status: () => res, json: () => {}, end: () => {}
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

describe('staff no-op guards (pass 367)', () => {
  const staffRouter = require('../src/routes/staff');

  const STAFF = { id: 1, role: 'staff', username: 'staff1', is_active: 1, department: null, phone: null };
  const body = { email: 'staff1@example.com', first_name: 'Staff', last_name: 'One', role: 'staff' };

  beforeEach(() => resetStmt({ get: { ...STAFF } }));

  it('update reports not found and skips the success audit when changes === 0', () => {
    resetStmt({ get: { ...STAFF }, run: { changes: 0 } });
    const h = lastHandlerFor(staffRouter, 'put', '/:id');
    const { redirectCalls, flashCalls, auditCalls } = runHandler(h, { body });
    expect(redirectCalls).toEqual(['/staff']);
    expect(flashCalls).toContainEqual(['error', 'Staff member not found']);
    expect(auditCalls.some(([a]) => a === 'update')).toBe(false);
  });

  it('reactivate returns not found when changes === 0', () => {
    resetStmt({ get: { ...STAFF, is_active: 0 }, run: { changes: 0 } });
    const h = lastHandlerFor(staffRouter, 'put', '/:id/reactivate');
    const { redirectCalls, flashCalls, auditCalls } = runHandler(h);
    expect(redirectCalls).toEqual(['/staff']);
    expect(flashCalls).toContainEqual(['error', 'Staff member not found']);
    expect(auditCalls.some(([a]) => a === 'reactivate')).toBe(false);
  });

  it('deactivate returns not found and does not audit or unassign when changes === 0', () => {
    resetStmt({ get: { ...STAFF }, run: { changes: 0 } });
    const h = lastHandlerFor(staffRouter, 'delete', '/:id');
    const { redirectCalls, flashCalls, auditCalls } = runHandler(h);
    expect(redirectCalls).toEqual(['/staff']);
    expect(flashCalls).toContainEqual(['error', 'Staff member not found']);
    expect(auditCalls.some(([a]) => a === 'deactivate')).toBe(false);
    expect(jest.requireMock('../src/models/database').prepare().all).not.toHaveBeenCalled();
  });
});

describe('vendor no-op guards (pass 367)', () => {
  const vendorsRouter = require('../src/routes/vendors');

  beforeEach(() => resetStmt({ get: { id: 1, name: 'Acme', is_active: 1 } }));

  it('deactivate returns not found when changes === 0', () => {
    resetStmt({ get: { id: 1, name: 'Acme', is_active: 1 }, run: { changes: 0 } });
    const h = lastHandlerFor(vendorsRouter, 'put', '/:id/deactivate');
    const { redirectCalls, flashCalls, auditCalls } = runHandler(h);
    expect(redirectCalls).toEqual(['/vendors']);
    expect(flashCalls).toContainEqual(['error', 'Vendor not found']);
    expect(auditCalls.some(([a]) => a === 'deactivate')).toBe(false);
  });

  it('reactivate returns not found when changes === 0', () => {
    resetStmt({ get: { id: 1, name: 'Acme', is_active: 0 }, run: { changes: 0 } });
    const h = lastHandlerFor(vendorsRouter, 'put', '/:id/reactivate');
    const { redirectCalls, flashCalls, auditCalls } = runHandler(h);
    expect(redirectCalls).toEqual(['/vendors']);
    expect(flashCalls).toContainEqual(['error', 'Vendor not found']);
    expect(auditCalls.some(([a]) => a === 'reactivate')).toBe(false);
  });
});
