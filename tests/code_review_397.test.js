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

describe('auth no-op guards (pass 397)', () => {
  const authRouter = require('../src/routes/auth');

  const PROFILE = { id: 1, username: 'testuser', email: 'test@example.com', first_name: 'Test', last_name: 'User', role: 'staff', department: 'IT', phone: '555-1234', is_active: 1, last_login: null, password_changed_at: null, created_at: '2024-01-01', updated_at: '2024-01-01' };

  beforeEach(() => resetStmt({ get: { ...PROFILE } }));

  it('profile update reports not found and skips success audit when changes === 0', () => {
    resetStmt({ get: { ...PROFILE }, run: { changes: 0 } });
    const h = lastHandlerFor(authRouter, 'put', '/profile');
    const { redirectCalls, flashCalls, auditCalls } = runHandler(h, {});
    expect(redirectCalls).toEqual(['/login']);
    expect(flashCalls).toContainEqual(['error', 'User not found. Please log in again.']);
    expect(auditCalls.some(([a]) => a === 'update')).toBe(false);
  });

  it('profile update with absent fields preserves stored values but changes === 0 still reports not found', () => {
    resetStmt({ get: { ...PROFILE }, run: { changes: 0 } });
    const h = lastHandlerFor(authRouter, 'put', '/profile');
    const { redirectCalls, flashCalls } = runHandler(h, {
      body: { first_name: 'NewName' }
    });
    expect(redirectCalls).toEqual(['/login']);
    expect(flashCalls).toContainEqual(['error', 'User not found. Please log in again.']);
  });
});
