const { describe, it, expect } = require('@jest/globals');

// Regression test for the login username-enumeration timing oracle.
// Before the fix, an oversized (>72-byte) password caused an early return
// BEFORE the constant-time bcrypt.compare, so a non-existent username with an
// oversized password returned instantly while an existing one ran the full
// ~200-300ms compare — leaking which usernames exist via response time.
//
// The fix moves the byte-length reject to AFTER bcrypt.compare, so the compare
// (against DUMMY_HASH for unknown users) always runs. This test asserts that
// bcrypt.compare is invoked even when the username does not exist and the
// password is oversized.

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

const bcrypt = require('bcryptjs');
jest.mock('bcryptjs', () => ({
  compare: jest.fn(() => Promise.resolve(false)),
  hash: jest.fn(() => Promise.resolve('hash')),
  hashSync: jest.fn(() => 'dummy-hash')
}));

const authRouter = require('../src/routes/auth');

function lastHandlerFor(router, method, pathPattern) {
  const layer = router.stack.find((l) => {
    const m = l.route && l.route.methods[method];
    return m && l.route.path === pathPattern;
  });
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function runLogin(body) {
  let redirectedTo = null;
  const flashCalls = [];
  const req = {
    body,
    params: {},
    method: 'POST',
    ip: '203.0.113.5',
    session: {},
    flash: (type, msg) => flashCalls.push([type, msg])
  };
  const res = { redirect: (to) => {
 redirectedTo = to;
}, render: () => {}, status: () => res, json: () => {} };
  const handler = lastHandlerFor(authRouter, 'post', '/login');
  handler(req, res, () => {});
  return { redirectedTo, flashCalls };
}

describe('login HPP/timing-oracle defense', () => {
  it('still runs bcrypt.compare for a non-existent user with an oversized password', async () => {
    bcrypt.compare.mockClear();
    const oversized = 'A'.repeat(100);
    runLogin({ username: 'does-not-exist-' + Date.now(), password: oversized });
    // Give the async handler a tick to reach the (await) bcrypt.compare.
    await new Promise((r) => setImmediate(r));
    expect(bcrypt.compare).toHaveBeenCalled();
    expect(bcrypt.compare.mock.calls[0][1]).toBeDefined();
  });

  it('rejects an empty password without throwing', () => {
    bcrypt.compare.mockClear();
    const { redirectedTo } = runLogin({ username: 'someone', password: '' });
    expect(redirectedTo).not.toBeNull();
  });

  it('rejects HTTP parameter pollution arrays on username/password (fail-closed)', () => {
    bcrypt.compare.mockClear();
    const { redirectedTo, flashCalls } = runLogin({ username: ['a', 'b'], password: 'secret' });
    expect(redirectedTo).toBe('/login');
    expect(bcrypt.compare).not.toHaveBeenCalled();
    expect(flashCalls.some(([t]) => t === 'error')).toBe(true);
  });

  it('rejects HTTP parameter pollution arrays on password', () => {
    bcrypt.compare.mockClear();
    const { redirectedTo } = runLogin({ username: 'someone', password: ['x', 'y'] });
    expect(redirectedTo).toBe('/login');
    expect(bcrypt.compare).not.toHaveBeenCalled();
  });
});
