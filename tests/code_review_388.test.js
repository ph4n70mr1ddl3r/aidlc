const { describe, it, expect } = require('@jest/globals');
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

function runHandler(handler, { params = { id: '1' }, body = {}, sessionUser = { id: 9, role: 'manager' } } = {}) {
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

describe('staff non-enumerating create-route refusal (pass 388)', () => {
  const staffRouter = require('../src/routes/staff');

  it('a manager creating a privileged account gets the missing-record answer', () => {
    const h = lastHandlerFor(staffRouter, 'post', '/');
    const { redirectCalls, flashCalls, auditCalls } = runHandler(h, {
      body: {
        username: 'newmanager', password: 'Str0ngPass1!', email: 'nm@example.com',
        first_name: 'New', last_name: 'Manager', role: 'manager'
      },
      sessionUser: { id: 9, role: 'manager' }
    });
    // Exactly like a missing record: the same flash and the same redirect.
    expect(redirectCalls).toEqual(['/staff']);
    expect(flashCalls).toContainEqual(['error', 'Staff member not found']);
    // The denial is recorded for the audit trail (the admin-only surface).
    expect(auditCalls.some(([a]) => a === 'access_denied')).toBe(true);
  });

  it('a manager creating a staff account succeeds (no refusal, no access_denied)', () => {
    const h = lastHandlerFor(staffRouter, 'post', '/');
    const { redirectCalls, flashCalls, auditCalls } = runHandler(h, {
      body: {
        username: 'newstaff', password: 'Str0ngPass1!', email: 'ns@example.com',
        first_name: 'New', last_name: 'Staff', role: 'staff'
      },
      sessionUser: { id: 9, role: 'manager' }
    });
    // The refusal wording never fires, and the denial audit is never written.
    expect(redirectCalls.includes('/staff') && flashCalls.some(([t, m]) => t === 'error' && m === 'Staff member not found')).toBe(false);
    expect(flashCalls.some(([t]) => t === 'error')).toBe(false);
    expect(auditCalls.some(([a]) => a === 'access_denied')).toBe(false);
  });
});
