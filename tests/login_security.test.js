const { describe, it, expect } = require('@jest/globals');

// Regression coverage for the login brute-force defenses that previously had
// zero test coverage:
//   1. The per-account and per-IP lockout maps (MAX_LOGIN_FAILURES = 5 failures
//      within a window lock the account/IP for LOGIN_LOCKOUT_MINUTES).
//   2. The login rate limiter (10 POST /login requests per 15 minutes) and its
//      wiring ahead of the handler.
// A regression that disabled login throttling or the lockout maps would
// previously have passed the whole suite.

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
const loginHandler = lastHandlerFor(authRouter, 'post', '/login');

// The default keyGenerator for express-rate-limit uses req.ip, so each test
// uses a distinct IP to keep limiter state isolated between tests.
let ipCounter = 0;
function uniqueIp() {
  ipCounter += 1;
  return `203.0.113.${ipCounter + 100}`;
}

async function runLogin(body, ip = '203.0.113.5') {
  let redirectedTo = null;
  const flashCalls = [];
  const req = {
    body,
    params: {},
    method: 'POST',
    ip,
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
  await loginHandler(req, res, () => {});
  // asyncHandler's wrapper does not return the inner async handler's promise,
  // so awaiting the wrapper alone resumes before the handler finishes (its
  // continuation is queued as a microtask). Flush the microtask queue so
  // post-await redirects/flashes are observable. setImmediate fires in the
  // check phase, after all pending microtasks have run.
  await new Promise((resolve) => setImmediate(resolve));
  return { redirectedTo, flashCalls };
}

function audit() {
  return jest.requireMock('../src/middleware/audit').audit;
}

function blockedAudits() {
  return audit().mock.calls.filter((c) => c[0].action === 'login_blocked');
}

describe('login brute-force lockout maps', () => {
  beforeEach(() => {
    audit().mockClear();
  });

  it('locks the account after MAX_LOGIN_FAILURES failed attempts and blocks the 6th with a login_blocked audit', async () => {
    const username = 'acctlock-' + Date.now();
    const ip = uniqueIp();
    for (let i = 0; i < 5; i++) {
      await runLogin({ username, password: 'wrong-password' }, ip);
    }
    // The 6th attempt is rejected by the account lockout even though the
    // credential check itself would pass (bcrypt mock).
    const { redirectedTo } = await runLogin({ username, password: 'wrong-password' }, ip);
    expect(redirectedTo).toBe('/login');
    const blocked = blockedAudits();
    expect(blocked.length).toBe(1);
    expect(blocked[0][0].details).toContain(username.toLowerCase());
    expect(blocked[0][0].details).toContain('account or IP lockout');
  });

  it('does not block before the 5th failed attempt', async () => {
    const username = 'noearlyblock-' + Date.now();
    const ip = uniqueIp();
    for (let i = 0; i < 4; i++) {
      await runLogin({ username, password: 'wrong-password' }, ip);
    }
    // Exactly 4 failures: still below the threshold, so no login_blocked audit.
    expect(blockedAudits().length).toBe(0);
    // The failed attempts themselves are still audited as login_failed.
    const failed = audit().mock.calls.filter((c) => c[0].action === 'login_failed');
    expect(failed.length).toBe(4);
  });

  it('locks the client IP after 5 failed attempts even across different accounts', async () => {
    const ip = uniqueIp();
    const stamp = Date.now();
    // Distinct usernames so no single account hits the account lockout, but the
    // shared IP accumulates 5 failures and locks (defense against IP rotation).
    for (let i = 0; i < 5; i++) {
      await runLogin({ username: `ipacct${i}-${stamp}`, password: 'wrong-password' }, ip);
    }
    const { redirectedTo } = await runLogin({ username: `ipacct-final-${stamp}`, password: 'wrong-password' }, ip);
    expect(redirectedTo).toBe('/login');
    expect(blockedAudits().length).toBe(1);
  });

  it('resets the account and IP failure counters on a successful login', async () => {
    const username = 'clearonesuccess-' + Date.now();
    const ip = uniqueIp();
    for (let i = 0; i < 4; i++) {
      await runLogin({ username, password: 'wrong-password' }, ip);
    }
    // Successful login clears the account + IP failure counters.
    bcrypt.compare.mockClear();
    bcrypt.compare.mockResolvedValueOnce(true);
    mockStmt.get.mockReturnValueOnce({
      id: 9, username, password: '$2a$12$fakehash',
      email: 'clear@example.com', first_name: 'Clear', last_name: 'User',
      role: 'staff', department: null, phone: null, avatar: null,
      is_active: 1, last_login: null, password_changed_at: null
    });
    const { redirectedTo } = await runLogin({ username, password: 'correct-password' }, ip);
    expect(redirectedTo).toBe('/dashboard');
    // After the reset, a full 5 more failures are required before the account
    // locks again — so the 6th post-reset attempt is the first blocked one.
    audit().mockClear();
    for (let i = 0; i < 5; i++) {
      await runLogin({ username, password: 'wrong-password' }, ip);
    }
    const { redirectedTo: finalRedirect } = await runLogin({ username, password: 'wrong-password' }, ip);
    expect(finalRedirect).toBe('/login');
    expect(blockedAudits().length).toBe(1);
  });
});

describe('login rate limiter', () => {
  function loginRateLimiter() {
    const loginLayer = authRouter.stack.find((l) => l.route && l.route.path === '/login' && l.route.methods.post);
    if (!loginLayer || !loginLayer.route || loginLayer.route.stack.length < 2) {
      throw new Error('POST /login route is missing its rate limiter middleware');
    }
    return loginLayer.route.stack[0].handle;
  }

  it('is wired on POST /login ahead of the handler', () => {
    // lastHandlerFor always extracts the LAST route layer, so a limiter removed
    // from the stack would silently pass every handler-level test. Assert the
    // middleware is present directly on the route stack.
    const loginLayer = authRouter.stack.find((l) => l.route && l.route.path === '/login' && l.route.methods.post);
    expect(loginLayer).toBeDefined();
    expect(loginLayer.route.stack.length).toBeGreaterThanOrEqual(2);
  });

  it('redirects to /login with a login_rate_limited audit once the window max is exceeded', async () => {
    const limiter = loginRateLimiter();
    audit().mockClear();
    const ip = uniqueIp();
    const req = { ip, flash: jest.fn() };
    let lastError = null;
    const next = (err) => {
      if (err) {
        lastError = err;
      }
    };
    const res = {
      setHeader: jest.fn(),
      redirect: jest.fn(),
      status: jest.fn(() => res),
      send: jest.fn(),
      json: jest.fn(),
      render: jest.fn()
    };
    // 10 requests are within the window max (limit = 10).
    for (let i = 0; i < 10; i++) {
      await limiter(req, res, next);
    }
    expect(lastError).toBeNull();
    expect(res.redirect).not.toHaveBeenCalled();
    expect(audit().mock.calls.filter((c) => c[0].action === 'login_rate_limited').length).toBe(0);
    // The 11th request exceeds the limit and triggers the handler.
    await limiter(req, res, next);
    expect(lastError).toBeNull();
    expect(res.redirect).toHaveBeenCalledWith('/login');
    expect(req.flash).toHaveBeenCalled();
    const rateLimited = audit().mock.calls.filter((c) => c[0].action === 'login_rate_limited');
    expect(rateLimited.length).toBe(1);
    expect(rateLimited[0][0].entity).toBe('user');
  });
});
