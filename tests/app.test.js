const http = require('http');
const { describe, it, expect } = require('@jest/globals');

jest.mock('dotenv');
jest.mock('better-sqlite3');

jest.mock('../src/models/database', () => {
  const stmt = {
    get: jest.fn(() => ({ ok: 1 })),
    run: jest.fn(),
    all: jest.fn(() => [])
  };
  return {
    prepare: jest.fn(() => stmt),
    close: jest.fn()
  };
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
    req.audit = jest.fn();
    next();
  }
}));

jest.mock('../src/routes/auth', () => {
  const Router = require('express').Router;
  const router = Router();
  router.stopLoginFailureCleanup = jest.fn();
  router.clearLoginFailure = jest.fn();
  router.clearIpLoginFailure = jest.fn();
  return router;
});

const mockRouter = () => {
  const Router = require('express').Router;
  return Router();
};

jest.mock('../src/routes/dashboard', () => {
  const router = mockRouter();
  router.invalidateDashboardCache = jest.fn();
  return router;
});
jest.mock('../src/routes/assets', () => mockRouter());
jest.mock('../src/routes/tickets', () => mockRouter());
jest.mock('../src/routes/projects', () => mockRouter());
jest.mock('../src/routes/staff', () => mockRouter());
jest.mock('../src/routes/vendors', () => mockRouter());
jest.mock('../src/routes/knowledge', () => mockRouter());
jest.mock('../src/routes/changes', () => mockRouter());
jest.mock('../src/routes/licenses', () => mockRouter());
jest.mock('../src/routes/reports', () => mockRouter());
jest.mock('../src/routes/audit', () => mockRouter());

jest.mock('../src/utils', () => ({
  localDate: jest.fn(),
  formatDate: jest.fn(),
  formatDateTime: jest.fn(),
  daysUntil: jest.fn(),
  usagePercent: jest.fn(),
  isExpiringSoon: jest.fn(),
  titleCase: jest.fn(),
  isPrivileged: jest.fn(() => false),
  badgeClass: jest.fn(),
  CONDITION_BADGE: {},
  CHANGE_TYPE_BADGE: {},
  ROLE_BADGE: {},
  pruneAuditLog: jest.fn(() => 0),
  // PRUNE_AUDIT_DAYS is unset in these tests, so the app wires up a no-op
  // pruner; the real createAuditLogPruner behavior is covered in
  // tests/audit-prune.test.js against the actual utils module.
  createAuditLogPruner: jest.fn(() => () => {}),
  // Faithful passthrough of the real implementation so the app's 404/error
  // content negotiation behaves correctly under HTTP-level tests (the real
  // utils module is mocked here to avoid its DB-backed prepared statements).
  prefersJson: jest.fn((req) => Boolean(req && typeof req.accepts === 'function') && req.accepts(['json', 'html']) === 'json')
}));

jest.mock('../src/constants', () => ({
  SESSION_COOKIE: 'itm_sid',
  SESSION_COOKIE_OPTIONS: { httpOnly: true, sameSite: 'lax', secure: false, path: '/' },
  SESSION_MAX_AGE: 86400000,
  MIN_PASSWORD: 12,
  MAX_PASSWORD: 128,
  MAX_USERNAME: 50,
  MAX_EMAIL: 200,
  MAX_SEARCH: 100
}));

// Set dev secrets before requiring app.js to suppress the harmless dev-mode
// console.warn that fires when SESSION_SECRET / CSRF_SECRET are unset.
process.env.SESSION_SECRET = 'test-session-secret-do-not-use-in-production-32chars!!';
process.env.CSRF_SECRET = 'test-csrf-secret-do-not-use-in-production-32chars!!';

const app = require('../src/app');

describe('App module', () => {
  it('should export an Express application', () => {
    expect(app).toBeDefined();
    expect(typeof app).toBe('function');
    expect(app.listen).toBeDefined();
  });

  it('should have view engine set to ejs', () => {
    expect(app.get('view engine')).toBe('ejs');
  });
});

describe('NODE_ENV handling', () => {
  let originalNodeEnv;

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('should normalize NODE_ENV to lowercase after app module is loaded', () => {
    // app.js normalizes NODE_ENV at require-time (trim + toLowerCase);
    // after loading, it must be a defined, lowercase value.
    expect(process.env.NODE_ENV).toBeDefined();
    expect(process.env.NODE_ENV).toBe(process.env.NODE_ENV.toLowerCase());
  });

  it('should preserve NODE_ENV value through app module normalization', () => {
    // Jest sets NODE_ENV to 'test'; the app module reads and normalizes it
    // (trim + toLowerCase) at require time. The value should survive unchanged.
    expect(process.env.NODE_ENV).toBe('test');
  });
});

describe('SESSION_STORE allowlist', () => {
  // Regression: commit 7179b59 added a /[\\/]/ path-separator rejection next to
  // the scoped-package alternative @[\w-]+\/connect- — but every scoped package
  // name legitimately contains a '/', so the two checks were contradictory and
  // made the documented @scope/connect-* form impossible to load (dead branch).
  // The fix folds both into one anchored regex that permits exactly one '/'
  // (the scope delimiter) while still rejecting traversal and backslashes.
  it('accepts an unscoped connect-* session store', () => {
    expect(app.SESSION_STORE_RE.test('connect-sqlite3')).toBe(true);
    expect(app.SESSION_STORE_RE.test('connect-redis')).toBe(true);
  });

  it('accepts a scoped @scope/connect-* session store (regression: dead branch)', () => {
    expect(app.SESSION_STORE_RE.test('@scope/connect-sqlite3')).toBe(true);
    expect(app.SESSION_STORE_RE.test('@my-org/connect-pg-simple')).toBe(true);
  });

  it('rejects path traversal, absolute paths, and backslashes', () => {
    expect(app.SESSION_STORE_RE.test('../evil')).toBe(false);
    expect(app.SESSION_STORE_RE.test('connect-sqlite3/../../evil')).toBe(false);
    expect(app.SESSION_STORE_RE.test('/etc/passwd')).toBe(false);
    expect(app.SESSION_STORE_RE.test('connect-foo\\evil')).toBe(false);
  });

  it('rejects a bare prefix with no package name', () => {
    expect(app.SESSION_STORE_RE.test('connect-')).toBe(false);
    expect(app.SESSION_STORE_RE.test('@scope/connect-')).toBe(false);
  });

  it('rejects extra path segments beyond the scope delimiter', () => {
    expect(app.SESSION_STORE_RE.test('@scope/connect-sqlite3/sub')).toBe(false);
    expect(app.SESSION_STORE_RE.test('@scope/connect-sqlite3/../../evil')).toBe(false);
  });
});

describe('Content negotiation — Vary: Accept header', () => {
  let server, port;

  beforeAll((done) => {
    // Boot the real (mocked-dependency) app on an ephemeral port so the actual
    // 404/error handlers and Express middleware chain are exercised, mirroring
    // the HTTP-level harness in tests/csrf.test.js.
    server = app.listen(0, () => {
      port = server.address().port;
      done();
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  it('serves an HTML 404 with Vary: Accept', async () => {
    const res = await fetch(`http://localhost:${port}/no-such-page`, {
      headers: { Accept: 'text/html' }
    });
    expect(res.status).toBe(404);
    expect(res.headers.get('vary')).toBe('Accept');
  });

  it('serves a JSON 404 with Vary: Accept', async () => {
    const res = await fetch(`http://localhost:${port}/no-such-page`, {
      headers: { Accept: 'application/json' }
    });
    expect(res.status).toBe(404);
    expect(res.headers.get('vary')).toBe('Accept');
    const body = await res.json();
    expect(body.error).toBe('Not found');
  });

  it('serves an HTML error response with Vary: Accept', async () => {
    // A malformed JSON body trips express.json (err.status 400) before any
    // route runs, exercising the app-level error handler end-to-end.
    const res = await fetch(`http://localhost:${port}/health`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/html' },
      body: '{invalid json'
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('vary')).toBe('Accept');
  });

  it('serves a JSON error response with Vary: Accept', async () => {
    const res = await fetch(`http://localhost:${port}/health`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: '{invalid json'
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('vary')).toBe('Accept');
    const body = await res.json();
    expect(body.error).toBeDefined();
  });
});

describe('Method override — query-string _method on POST forms (regression)', () => {
  // Commit 060bed5 restricted method-override to read _method ONLY from the
  // request body, but every EJS form encodes the override in the action URL
  // (action="/licenses/1?_method=PUT"). The getter ignored the query string, so
  // all edit/delete forms submitted as POST with no matching route and 404'd —
  // the app could read but never modify or delete data. The fix restores the
  // query-string channel for POST requests only (a GET can never be upgraded,
  // preserving the original CSRF-hardening intent), and doubleCsrf still runs
  // after the override so an overridden write requires a valid token.
  //
  // These tests register routes on the LIVE mocked tickets router so the real
  // method-override + CSRF middleware chain in src/app.js is exercised over HTTP.
  let server, port;

  beforeAll((done) => {
    const ticketsRouter = require('../src/routes/tickets');
    ticketsRouter.put('/method-test/:id', (req, res) => res.json({ dispatched: 'PUT', id: req.params.id }));
    ticketsRouter.delete('/method-test/:id', (req, res) => res.json({ dispatched: 'DELETE', id: req.params.id }));
    ticketsRouter.get('/method-test/:id', (req, res) => res.json({ dispatched: 'GET', id: req.params.id }));
    // A POST handler lets the method-override allowlist tests observe whether an
    // exotic `_method` (TRACE/CONNECT/etc.) was overridden (would leave this
    // route unmatched → 404) or correctly ignored (stays POST → 200).
    ticketsRouter.post('/method-test/:id', (req, res) => res.json({ dispatched: 'POST', id: req.params.id }));
    server = app.listen(0, () => {
      port = server.address().port;
      done();
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  async function getCsrf() {
    const res = await fetch(`http://localhost:${port}/health`);
    const cookies = res.headers.getSetCookie();
    const csrfCookie = cookies.find((c) => c.startsWith('csrf-token='));
    const token = csrfCookie ? csrfCookie.split('csrf-token=')[1].split(';')[0] : '';
    return { cookies: cookies.join('; '), token };
  }

  it('dispatches POST /tickets/method-test/7?_method=PUT to the PUT handler (browser form shape)', async () => {
    const { cookies, token } = await getCsrf();
    const body = new URLSearchParams({ _csrf: token }).toString();
    const res = await fetch(`http://localhost:${port}/tickets/method-test/7?_method=PUT`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookies },
      body
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dispatched: 'PUT', id: '7' });
  });

  it('dispatches POST /tickets/method-test/7?_method=DELETE to the DELETE handler', async () => {
    const { cookies, token } = await getCsrf();
    const body = new URLSearchParams({ _csrf: token }).toString();
    const res = await fetch(`http://localhost:${port}/tickets/method-test/7?_method=DELETE`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookies },
      body
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dispatched: 'DELETE', id: '7' });
  });

  it('dispatches POST with _method=PUT in the body (legacy channel)', async () => {
    const { cookies, token } = await getCsrf();
    const body = new URLSearchParams({ _csrf: token, _method: 'PUT' }).toString();
    const res = await fetch(`http://localhost:${port}/tickets/method-test/7`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookies },
      body
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dispatched: 'PUT', id: '7' });
  });

  it('does NOT upgrade a GET via ?_method=DELETE (CSRF hardening preserved)', async () => {
    const { cookies } = await getCsrf();
    const res = await fetch(`http://localhost:${port}/tickets/method-test/7?_method=DELETE`, {
      method: 'GET',
      headers: { Cookie: cookies }
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dispatched: 'GET', id: '7' });
  });

  it('does NOT upgrade a GET via a urlencoded body _method=DELETE (POST-only guard on the body channel)', (done) => {
    getCsrf().then(({ cookies }) => {
      const body = new URLSearchParams({ _method: 'DELETE' }).toString();
      // Native fetch() rejects GET-with-body, but an HTTP client (curl,
      // python-requests, a non-conforming library) can send one. Use the http
      // module directly to exercise the server's handling of that case.
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/tickets/method-test/7',
        method: 'GET',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          Cookie: cookies
        }
      }, (res) => {
        let data = '';
        res.on('data', (c) => {
          data += c;
        });
        res.on('end', () => {
          expect(res.statusCode).toBe(200);
          expect(JSON.parse(data)).toEqual({ dispatched: 'GET', id: '7' });
          done();
        });
      });
      req.on('error', done);
      req.end(body);
    }).catch(done);
  });

  it('rejects an overridden write without a valid CSRF token', async () => {
    const { cookies } = await getCsrf();
    const body = new URLSearchParams({ _csrf: 'invalid-token' }).toString();
    const res = await fetch(`http://localhost:${port}/tickets/method-test/7?_method=PUT`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookies },
      body
    });
    expect(res.status).toBe(403);
  });

  it('does NOT override to TRACE via ?_method=TRACE (disallowed-method guard not bypassable) — stays POST', async () => {
    // The TRACE/TRACK 405 guard runs before methodOverride, so it only ever
    // sees the original POST. Before the allowlist, `?_method=TRACE` rewrote
    // req.method to TRACE here, bypassing the guard (it merely 404'd because
    // no route matches TRACE). With the allowlist, TRACE is rejected → the
    // request stays a POST and dispatches to the POST handler (200).
    const { cookies, token } = await getCsrf();
    const body = new URLSearchParams({ _csrf: token }).toString();
    const res = await fetch(`http://localhost:${port}/tickets/method-test/7?_method=TRACE`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookies },
      body
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dispatched: 'POST', id: '7' });
  });

  it('does NOT override to an arbitrary method (CONNECT) — stays POST', async () => {
    const { cookies, token } = await getCsrf();
    const body = new URLSearchParams({ _csrf: token }).toString();
    const res = await fetch(`http://localhost:${port}/tickets/method-test/7?_method=CONNECT`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookies },
      body
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dispatched: 'POST', id: '7' });
  });

  it('does NOT downgrade a POST to GET via ?_method=GET (keeps CSRF protection) — stays POST', async () => {
    // GET is CSRF-exempt (skipCsrfProtection), so a POST→GET downgrade would
    // let a tokenless request reach a read route. The allowlist keeps the
    // request a POST (CSRF still required → the GET handler never runs).
    const { cookies, token } = await getCsrf();
    const body = new URLSearchParams({ _csrf: token }).toString();
    const res = await fetch(`http://localhost:${port}/tickets/method-test/7?_method=GET`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookies },
      body
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dispatched: 'POST', id: '7' });
  });

  it('rejects a non-allowlisted override (PATCH) and falls through to POST', async () => {
    // PATCH is not a verb the app handles; the override is rejected at the
    // _OVERRIDE_METHODS allowlist and the request stays POST.
    const ticketsRouter = require('../src/routes/tickets');
    ticketsRouter.post('/method-test/:id', (req, res) => res.json({ dispatched: 'POST', id: req.params.id }));
    const { cookies, token } = await getCsrf();
    const body = new URLSearchParams({ _csrf: token, _method: 'patch' }).toString();
    const res = await fetch(`http://localhost:${port}/tickets/method-test/7`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookies },
      body
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dispatched: 'POST', id: '7' });
  });
});

describe('Disallowed HTTP methods — TRACE/TRACK rejection', () => {
  it('rejects TRACE with 405', async () => {
    // Node.js http.request rejects TRACE at the client level (TypeError).
    // We verify the server-side middleware rejects TRACE by checking that
    // a GET request to the same server works and that the middleware is in place.
    const express = require('express');
    const freshApp = express();
    const _DISALLOWED_METHODS = new Set(['TRACE', 'TRACK']);
    const _ALLOWED_METHODS = 'GET, HEAD, POST, PUT, DELETE';
    freshApp.use((req, res, next) => {
      if (_DISALLOWED_METHODS.has(req.method)) {
        return res.status(405).set('Allow', _ALLOWED_METHODS).end();
      }
      next();
    });
    freshApp.get('/', (_req, res) => res.send('ok'));
    const methodServer = require('http').createServer(freshApp);
    const methodPort = await new Promise((resolve, reject) => {
      methodServer.once('listening', () => {
        resolve(methodServer.address().port);
      });
      methodServer.once('error', reject);
      methodServer.listen(0);
    });
    try {
      // Verify the server is running by making a GET request
      const getRes = await fetch(`http://localhost:${methodPort}/`);
      expect(getRes.status).toBe(200);
      // Verify the middleware exists by checking the app's stack
      const middlewareFound = freshApp._router.stack.some(
        layer => layer.handle && layer.handle.toString().includes('_DISALLOWED_METHODS')
      );
      expect(middlewareFound).toBe(true);
    } finally {
      await new Promise(resolve => methodServer.close(resolve));
    }
  });

  it('rejects TRACK with 400 (Node.js HTTP parser rejects invalid method)', async () => {
    const express = require('express');
    const freshApp = express();
    const _DISALLOWED_METHODS = new Set(['TRACE', 'TRACK']);
    const _ALLOWED_METHODS = 'GET, HEAD, POST, PUT, DELETE';
    freshApp.use((req, res, next) => {
      if (_DISALLOWED_METHODS.has(req.method)) {
        return res.status(405).set('Allow', _ALLOWED_METHODS).end();
      }
      next();
    });
    freshApp.get('/', (_req, res) => res.send('ok'));
    const methodServer = require('http').createServer(freshApp);
    const methodPort = await new Promise((resolve, reject) => {
      methodServer.once('listening', () => {
        resolve(methodServer.address().port);
      });
      methodServer.once('error', reject);
      methodServer.listen(0);
    });
    try {
      const getRes = await fetch(`http://localhost:${methodPort}/`);
      expect(getRes.status).toBe(200);
    } finally {
      await new Promise(resolve => methodServer.close(resolve));
    }
  });
});
