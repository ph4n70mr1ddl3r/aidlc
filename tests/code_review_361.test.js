const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const { describe, it, expect, beforeAll, afterAll } = require('@jest/globals');

// Regression tests for the 361st review pass. Defects closed:
// (1) views/pages/error.ejs called escapeHtml() manually inside <%= %> —
//     double-escaping messages containing HTML metacharacters AND throwing a
//     secondary ReferenceError for errors raised BEFORE the res.locals
//     middleware ran (body-parser 413/400 leave escapeHtml genuinely
//     undefined), which downgraded the styled error page to a bare-text 500
//     with a wrong status code. EJS <%= %> already escapes, so the manual call
//     was removed (same class fixed for header.ejs's csrfToken in pass 141 and
//     the audit details column double-escape).
// (2) src/app.js's 405 Allow header omitted OPTIONS although the app serves it
//     (Express's automatic OPTIONS handler; doubleCsrfProtection skips OPTIONS),
//     making the advertised method set inaccurate per RFC 9110.

// ---------------------------------------------------------------------------
// App module mocks (mirrors tests/app.test.js so the real app.js — including
// its global error handler and view wiring — can be exercised over HTTP
// without a real database or session-backed auth).
// ---------------------------------------------------------------------------
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

const mockRouter = () => require('express').Router();
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
  normalizeIp: (ip) => ip,
  parseEnvInt: (raw) => (typeof raw === 'string' && /^\d+$/.test(raw)) ? parseInt(raw, 10) : NaN,
  pruneAuditLog: jest.fn(() => 0),
  createAuditLogPruner: jest.fn(() => () => {}),
  // Faithful passthrough of the real implementation so the error handler's
  // HTML-vs-JSON content negotiation behaves correctly under HTTP-level tests.
  prefersJson: jest.fn((req) => Boolean(req && typeof req.accepts === 'function') && req.accepts(['json', 'html']) === 'json')
}));

jest.mock('../src/constants', () => ({
  SESSION_COOKIE: 'itm_sid',
  SESSION_COOKIE_OPTIONS: { httpOnly: true, sameSite: 'lax', secure: false, path: '/' },
  SESSION_MAX_AGE: 86400000,
  MIN_PASSWORD: 12,
  MAX_PASSWORD: 128,
  MAX_PASSWORD_BYTES: 72,
  MAX_USERNAME: 50,
  MAX_EMAIL: 200,
  MAX_SEARCH: 100
}));

// Dev-mode secrets so app.js require-time production checks do not exit.
process.env.SESSION_SECRET = 'test-session-secret-do-not-use-in-production-32chars!!';
process.env.CSRF_SECRET = 'test-csrf-secret-do-not-use-in-production-32chars!!';

const app = require('../src/app');

const ERROR_PAGE = path.join(__dirname, '..', 'views', 'pages', 'error.ejs');

// ---------------------------------------------------------------------------
// 1. error.ejs no longer requires the escapeHtml res.locals helper
// ---------------------------------------------------------------------------
describe('code review 361: error.ejs escaping correctness', () => {
  it('renders without an escapeHtml local (errors thrown before the res.locals middleware)', () => {
    const src = fs.readFileSync(ERROR_PAGE, 'utf8');
    // The global error handler renders pages/error for errors thrown BEFORE
    // the res.locals middleware runs (e.g. a body-parser 413/400) — no
    // escapeHtml local exists there. The previous manual escapeHtml() call
    // threw a secondary ReferenceError that downgraded the styled page to a
    // bare-text 500.
    let html;
    expect(() => {
      html = ejs.render(src, { title: 'Error', statusCode: 413, error: { message: 'request entity too large' } }, { filename: ERROR_PAGE });
    }).not.toThrow();
    expect(html).toContain('request entity too large');
    // The pre-locals path has no user local either — the guarded CTA must
    // degrade to the anonymous "Go to Login" branch.
    expect(html).toContain('Go to Login');
  });

  it('escapes HTML metacharacters in the message exactly once (no double-escape)', () => {
    const src = fs.readFileSync(ERROR_PAGE, 'utf8');
    // escapeHtml provided (the normal post-res.locals render path) must NOT
    // combine with EJS's built-in <%= %> escaping: "a & b < c" previously
    // displayed as the literal text "a &amp; b &lt; c".
    const html = ejs.render(src, { title: 'Error', statusCode: 500, error: { message: 'a & b < c' } }, { filename: ERROR_PAGE });
    expect(html).toContain('a &amp; b &lt; c');
    expect(html).not.toContain('&amp;amp;');
    expect(html).not.toContain('&amp;lt;');
  });
});

// ---------------------------------------------------------------------------
// 2. End-to-end: a body-parser 413 keeps the styled error page (not a bare 500)
// ---------------------------------------------------------------------------
describe('code review 361: oversized body renders the styled error page', () => {
  let server;
  let port;

  beforeAll((done) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      done();
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  it('responds 413 with the HTML error page for an oversized urlencoded body', async () => {
    // >1 MB body trips express.urlencoded's limit BEFORE session/CSRF/routing
    // — and before the res.locals middleware, so the error page renders with
    // no helpers in scope. Accept: text/html steers the content-negotiated
    // handler onto the HTML branch (fetch's default Accept: */* would select
    // the JSON branch instead).
    const res = await fetch(`http://127.0.0.1:${port}/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'text/html'
      },
      body: 'x='.repeat(2 * 1024 * 1024)
    });
    // The status must NOT be downgraded to 500 by a secondary render error.
    expect(res.status).toBe(413);
    expect(res.headers.get('content-type')).toContain('text/html');
    const text = await res.text();
    expect(text).toContain('Request Error');
    expect(text).toContain('413');
    // No raw exception text from a secondary ReferenceError may leak through.
    expect(text).not.toContain('ReferenceError');
  });

  it('rejects TRACE with 405 and advertises OPTIONS in the Allow header', async () => {
    // Node's HTTP client refuses TRACE, so speak a raw socket. The Allow
    // header must list every method the app actually serves — OPTIONS is
    // served (Express auto-handler; CSRF validation skips it), so omitting it
    // was inaccurate per RFC 9110.
    const raw = await new Promise((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write('TRACE / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
      });
      let data = '';
      sock.on('data', (c) => {
        data += c.toString();
      });
      sock.on('end', () => resolve(data));
      sock.on('error', reject);
    });
    expect(raw).toMatch(/^HTTP\/1\.1 405/);
    // The Allow header lists the TARGET RESOURCE's methods (RFC 9110
    // §15.5.6), so the home redirect advertises only what it serves:
    // GET (and therefore HEAD) plus OPTIONS — not a global POST/PUT/DELETE.
    expect(raw).toContain('Allow: GET, HEAD, OPTIONS');
  });
});
