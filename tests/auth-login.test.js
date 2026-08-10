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

// The db mock's prepared statement is exposed via a module-scoped variable so
// individual tests can override the returned row (e.g. to simulate a stored
// password hash on the success path) and to inspect the SQL passed to prepare().
let mockStmt;
jest.mock('../src/models/database', () => {
  mockStmt = { get: jest.fn(() => null), all: jest.fn(() => []), run: jest.fn(() => ({ changes: 1, lastInsertRowid: 1 })) };
  return { prepare: jest.fn(() => mockStmt), exec: jest.fn(), pragma: jest.fn(), transaction: jest.fn((fn) => fn), close: jest.fn() };
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

const { lastHandlerFor } = require('./helpers');

const authRouter = require('../src/routes/auth');

async function runLogin(body) {
  let redirectedTo = null;
  const flashCalls = [];
  const req = {
    body,
    params: {},
    method: 'POST',
    ip: '203.0.113.5',
    session: {
      // regenerate is exercised only on the successful-login path (fixation
      // protection); absent on failed paths which return before reaching it.
      regenerate: (cb) => cb()
    },
    flash: (type, msg) => flashCalls.push([type, msg])
  };
  const res = { redirect: (to) => {
    redirectedTo = to;
  }, render: () => {}, status: () => res, json: () => {} };
  const handler = lastHandlerFor(authRouter, 'post', '/login');
  await handler(req, res, () => {});
  // asyncHandler's wrapper does not return the inner async handler's promise,
  // so awaiting the wrapper alone resumes before the handler finishes (its
  // continuation is queued as a microtask). Flush the microtask queue so
  // post-await redirects/flashes are observable. setImmediate fires in the
  // check phase, after all pending microtasks have run.
  await new Promise((resolve) => setImmediate(resolve));
  return { redirectedTo, flashCalls };
}

describe('login HPP/timing-oracle defense', () => {
  it('still runs bcrypt.compare for a non-existent user with an oversized password', async () => {
    bcrypt.compare.mockClear();
    const oversized = 'A'.repeat(100);
    await runLogin({ username: 'does-not-exist-' + Date.now(), password: oversized });
    expect(bcrypt.compare).toHaveBeenCalled();
    expect(bcrypt.compare.mock.calls[0][1]).toBeDefined();
  });

  it('rejects an empty password without throwing', async () => {
    bcrypt.compare.mockClear();
    const { redirectedTo } = await runLogin({ username: 'someone', password: '' });
    expect(redirectedTo).not.toBeNull();
  });

  it('rejects HTTP parameter pollution arrays on username/password (fail-closed)', async () => {
    bcrypt.compare.mockClear();
    const { redirectedTo, flashCalls } = await runLogin({ username: ['a', 'b'], password: 'secret' });
    expect(redirectedTo).toBe('/login');
    expect(bcrypt.compare).not.toHaveBeenCalled();
    expect(flashCalls.some(([t]) => t === 'error')).toBe(true);
  });

  it('rejects HTTP parameter pollution arrays on password', async () => {
    bcrypt.compare.mockClear();
    const { redirectedTo } = await runLogin({ username: 'someone', password: ['x', 'y'] });
    expect(redirectedTo).toBe('/login');
    expect(bcrypt.compare).not.toHaveBeenCalled();
  });
});

describe('login success path (regression: password column dropped from SELECT)', () => {
  // Commit 0d176e0 excluded `password` from the login SELECT. Because
  // hashToCompare then always fell back to the pre-computed DUMMY_HASH, every
  // real login failed AND any active account could be signed into by submitting
  // the dummy hash's known plaintext ("dummy") — a complete auth bypass. The
  // existing suites never caught it because they mock bcrypt.compare to always
  // return false (so the success path is never exercised) and never assert the
  // query shape. These tests close both gaps.

  it('login SELECT includes the password column', () => {
    const db = jest.requireMock('../src/models/database');
    const loginSql = db.prepare.mock.calls.find(([sql]) => sql.includes('FROM users WHERE username'));
    expect(loginSql).toBeDefined();
    expect(loginSql[0]).toMatch(/\bpassword\b/);
  });

  it('redirects to /dashboard when the stored password hash matches', async () => {
    bcrypt.compare.mockClear();
    bcrypt.compare.mockResolvedValueOnce(true);
    mockStmt.get.mockReturnValueOnce({
      id: 5, username: 'admin', password: '$2a$12$fakehash',
      email: 'admin@company.com', first_name: 'Admin', last_name: 'User',
      role: 'admin', department: null, phone: null, avatar: null,
      is_active: 1, last_login: null, password_changed_at: null
    });
    const { redirectedTo, flashCalls } = await runLogin({ username: 'admin', password: 'CorrectP@ssw0rd!' });
    expect(redirectedTo).toBe('/dashboard');
    expect(flashCalls.some(([t, m]) => t === 'success' && m.includes('Admin'))).toBe(true);
  });

  it('rejects a wrong password even when the username exists (no known-hash bypass)', async () => {
    // This is the regression guard for the auth bypass: with the password column
    // restored, a correct stored hash + wrong password must NOT authenticate.
    bcrypt.compare.mockClear();
    bcrypt.compare.mockResolvedValueOnce(false);
    mockStmt.get.mockReturnValueOnce({
      id: 5, username: 'admin', password: '$2a$12$fakehash',
      email: 'admin@company.com', first_name: 'Admin', last_name: 'User',
      role: 'admin', department: null, phone: null, avatar: null,
      is_active: 1, last_login: null, password_changed_at: null
    });
    const { redirectedTo } = await runLogin({ username: 'admin', password: 'dummy' });
    expect(redirectedTo).toBe('/login');
  });
});

describe('profile password change bcrypt error handling', () => {
  // Regression: bcrypt.compare / bcrypt.hash previously ran outside any
  // try-catch in the profile-password-change route, so an unexpected error
  // (OOM, malformed stored hash) would surface as a generic 500 instead of a
  // user-facing flash message. The bcrypt calls are now wrapped so the handler
  // returns a flash error and redirects back to /profile.

  async function runPasswordChange(body) {
    const authRouterForTest = require('../src/routes/auth');
    const h = lastHandlerFor(authRouterForTest, 'put', '/profile/password');
    let redirectedTo = null;
    const flashCalls = [];
    let caughtErr = null;
    const req = {
      body,
      params: {},
      method: 'PUT',
      session: { user: { id: 1, role: 'admin', password_changed_at: null } },
      flash: (type, msg) => flashCalls.push([type, msg])
    };
    const res = {
      redirect: (to) => {
        redirectedTo = to;
      },
      render: () => {},
      status: () => res,
      json: () => {}
    };
    await h(req, res, (err) => {
      caughtErr = err;
    });
    await new Promise((resolve) => setImmediate(resolve));
    return { redirectedTo, flashCalls, caughtErr };
  }

  it('redirects to /profile with a flash error when bcrypt.compare throws', async () => {
    bcrypt.compare.mockClear();
    bcrypt.compare.mockRejectedValueOnce(new Error('bcrypt OOM'));
    mockStmt.get.mockReturnValueOnce({ password: '$2a$12$existinghash' });
    const { redirectedTo, flashCalls } = await runPasswordChange({
      current_password: 'old', new_password: 'NewP@ssw0rd!Aa1', confirm_password: 'NewP@ssw0rd!Aa1'
    });
    expect(redirectedTo).toBe('/profile');
    expect(flashCalls.some(([t, m]) => t === 'error' && /error/i.test(m))).toBe(true);
  });

  it('redirects to /profile with a flash error when bcrypt.hash throws', async () => {
    bcrypt.compare.mockClear();
    bcrypt.compare.mockResolvedValue(true);
    bcrypt.hash.mockClear();
    bcrypt.hash.mockRejectedValueOnce(new Error('bcrypt OOM'));
    mockStmt.get.mockReturnValueOnce({ password: '$2a$12$existinghash' });
    const { redirectedTo, flashCalls } = await runPasswordChange({
      current_password: 'old', new_password: 'NewP@ssw0rd!Aa1', confirm_password: 'NewP@ssw0rd!Aa1'
    });
    expect(redirectedTo).toBe('/profile');
    expect(flashCalls.some(([t, m]) => t === 'error' && /error/i.test(m))).toBe(true);
  });

  it('redirects to /login with a flash error when the password update affects 0 rows (concurrent deletion race)', async () => {
    bcrypt.compare.mockClear();
    bcrypt.compare.mockResolvedValue(true);
    bcrypt.hash.mockClear();
    bcrypt.hash.mockResolvedValue('new-hash');
    // First get() call: password SELECT for bcrypt.compare
    mockStmt.get.mockReturnValueOnce({ password: '$2a$12$existinghash' });
    // Second get() call: profile SELECT (after update) — not reached due to early return
    mockStmt.get.mockReturnValueOnce(null);
    // run the update with changes=0 to simulate concurrent deletion
    // Override the password update stmt to return changes=0
    const db = jest.requireMock('../src/models/database');
    const originalPrepare = db.prepare;
    db.prepare = jest.fn((sql) => {
      if (sql.includes('UPDATE users SET password')) {
        return { run: jest.fn(() => ({ changes: 0 })) };
      }
      return originalPrepare.call(db, sql);
    });
    try {
      const { redirectedTo, flashCalls } = await runPasswordChange({
        current_password: 'old', new_password: 'NewP@ssw0rd!Aa1', confirm_password: 'NewP@ssw0rd!Aa1'
      });
      expect(redirectedTo).toBe('/login');
      expect(flashCalls.some(([t, m]) => t === 'error' && /not found/i.test(m))).toBe(true);
    } finally {
      db.prepare = originalPrepare;
    }
  });
});

describe('profile update 0-row-update guard (regression)', () => {
  // Regression: the profile UPDATE route previously ran _getProfileUpdateStmt().run()
  // without checking result.changes. If the user row were deleted between the earlier
  // SELECT and the UPDATE, 0 rows would be affected but the handler would proceed to
  // regenerate the session and flash success — a TOCTOU gap inconsistent with the
  // password-change route which already guards with `if (updateResult.changes === 0)`.
  // Mirrors the pass-70 fix for the profile password-change route.

  async function runProfileUpdate(body) {
    const authRouterForTest = require('../src/routes/auth');
    const h = lastHandlerFor(authRouterForTest, 'put', '/profile');
    let redirectedTo = null;
    const flashCalls = [];
    let caughtErr = null;
    const req = {
      body,
      params: {},
      method: 'PUT',
      session: { user: { id: 1, role: 'admin', password_changed_at: null } },
      flash: (type, msg) => flashCalls.push([type, msg])
    };
    const res = {
      redirect: (to) => {
        redirectedTo = to;
      },
      render: () => {},
      status: () => res,
      json: () => {}
    };
    await h(req, res, (err) => {
      caughtErr = err;
    });
    await new Promise((resolve) => setImmediate(resolve));
    return { redirectedTo, flashCalls, caughtErr };
  }

  it('redirects to /login with a flash error when the profile update affects 0 rows (concurrent deletion race)', async () => {
    // Override the profile update stmt to return changes=0
    const db = jest.requireMock('../src/models/database');
    const originalPrepare = db.prepare;
    db.prepare = jest.fn((sql) => {
      if (sql.includes('UPDATE users SET first_name')) {
        return { run: jest.fn(() => ({ changes: 0 })) };
      }
      return originalPrepare.call(db, sql);
    });
    try {
      const { redirectedTo, flashCalls } = await runProfileUpdate({
        first_name: 'Ada', last_name: 'Lovelace', email: 'ada@company.com', phone: '555-0101'
      });
      expect(redirectedTo).toBe('/login');
      expect(flashCalls.some(([t, m]) => t === 'error' && /not found/i.test(m))).toBe(true);
    } finally {
      db.prepare = originalPrepare;
    }
  });
});
