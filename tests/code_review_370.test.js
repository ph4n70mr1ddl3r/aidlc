const http = require('http');
const fs = require('fs');
const path = require('path');
const { describe, it, expect, beforeAll, afterAll } = require('@jest/globals');

// Regression tests for review cycle 370 — two defects found by a full re-read:
//
// (1) src/routes/auth.js called `req.audit('read', 'user', ...)` on GET
//     /profile but the auth router never mounted `auditMiddleware`, so
//     `req.audit` was undefined and EVERY authenticated GET /profile request
//     died with "TypeError: req.audit is not a function" (a 500 on the My
//     Profile page the header links from every screen). The unit test that
//     pinned the read audit (tests/code_review_192.test.js) injected
//     `req.audit` into its fake request by hand, so it exercised the handler
//     but never the router's middleware chain — the missing wiring was
//     invisible to it.
//
// (2) The TRACE/TRACK guard in src/app.js ran BEFORE helmet(), so its 405
//     response was the only response the app produced that shipped without
//     any security headers (CSP, X-Frame-Options, nosniff, Referrer-Policy,
//     Permissions-Policy) and without the no-store cache policy.
//
// The env must be set BEFORE requiring the app: src/app.js reads DB_PATH at
// require time (src/models/database.js resolves it when the module loads).
process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-0123456789abcdef';
process.env.CSRF_SECRET = 'test-csrf-secret-0123456789abcdef';

const bcrypt = require('bcryptjs');
const db = require('../src/models/database');
const app = require('../src/app.js');

const ADMIN_USER = {
  id: 1,
  username: 'cr370admin',
  password: 'SeedAdminPass1!',
  email: 'cr370admin@company.com',
  first_name: 'Casey',
  last_name: 'Reviewer',
  role: 'admin'
};

// Insert a single admin account so the profile route has a real user to load.
db.prepare(`
  INSERT INTO users (id, username, password, email, first_name, last_name, role, department)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'IT')
`).run(
  ADMIN_USER.id,
  ADMIN_USER.username,
  bcrypt.hashSync(ADMIN_USER.password, 4),
  ADMIN_USER.email,
  ADMIN_USER.first_name,
  ADMIN_USER.last_name,
  ADMIN_USER.role
);

let server;
let port;

function request(method, urlPath, { cookies = '', body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const reqHeaders = { ...headers };
    if (cookies) {
      reqHeaders.Cookie = cookies;
    }
    if (body !== null) {
      reqHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
      reqHeaders['Content-Length'] = Buffer.byteLength(body);
    }
    const req = http.request({ port, method, path: urlPath, headers: reqHeaders }, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body: data });
      });
    });
    req.on('error', reject);
    if (body !== null) {
      req.write(body);
    }
    req.end();
  });
}

function cookieHeader(setCookie) {
  return (setCookie || []).map((c) => c.split(';')[0]).join('; ');
}

beforeAll((done) => {
  server = app.listen(0, () => {
    port = server.address().port;
    done();
  });
});
afterAll((done) => {
  if (server) {
    server.close(() => done());
  } else {
    done();
  }
});

describe('code review 370 — auth router audit wiring + 405 header parity', () => {
  describe('GET /profile serves 200 (req.audit is wired on the auth router)', () => {
    let sessionCookie;

    beforeAll(async () => {
      const loginPage = await request('GET', '/login');
      const csrf = (loginPage.body.match(/name="_csrf" value="([^"]+)"/) || [])[1];
      expect(csrf).toBeTruthy();
      const login = await request('POST', '/login', {
        cookies: cookieHeader(loginPage.headers['set-cookie']),
        body: `username=${encodeURIComponent(ADMIN_USER.username)}&password=${encodeURIComponent(ADMIN_USER.password)}&_csrf=${encodeURIComponent(csrf)}`
      });
      expect(login.status).toBe(302);
      sessionCookie = cookieHeader(login.headers['set-cookie']);
      expect(sessionCookie).toContain('itm_sid');
    });

    it('returns 200 for an authenticated GET /profile instead of throwing req.audit', async () => {
      const res = await request('GET', '/profile', { cookies: sessionCookie });
      // Before the fix the route threw "TypeError: req.audit is not a function"
      // and the error handler answered 500 for every profile view.
      expect(res.status).toBe(200);
      expect(res.body).not.toMatch(/req\.audit is not a function/);
      expect(res.body).toContain('My Profile');
      expect(res.body).toContain(ADMIN_USER.email);
    });

    it('records the read audit entry for the profile view', async () => {
      const row = db.prepare(`
        SELECT action, entity_type, entity_id, details
        FROM audit_log
        WHERE action = 'read' AND entity_type = 'user' AND details = 'Viewed own profile'
        ORDER BY id DESC LIMIT 1
      `).get();
      expect(row).toBeTruthy();
      expect(Number(row.entity_id)).toBe(ADMIN_USER.id);
    });
  });

  describe('every route module that calls req.audit() mounts auditMiddleware', () => {
    const routesDir = path.join(__dirname, '..', 'src', 'routes');

    it('no route module calls req.audit() without installing the audit middleware', () => {
      const offenders = [];
      for (const file of fs.readdirSync(routesDir).filter((f) => f.endsWith('.js'))) {
        const src = fs.readFileSync(path.join(routesDir, file), 'utf8');
        if (!/req\.audit\(/.test(src)) {
          continue;
        }
        if (!/auditMiddleware/.test(src)) {
          offenders.push(file);
        }
      }
      expect(offenders).toEqual([]);
    });
  });

  describe('TRACE/TRACK 405 carries the app security headers', () => {
    it('answers 405 with the Allow header and the full helmet + no-store header set', async () => {
      const res = await request('TRACE', '/health');
      expect(res.status).toBe(405);
      expect(res.headers.allow).toBe('GET, HEAD, POST, PUT, DELETE, OPTIONS');
      // helmet() headers — the 405 used to be the only response without them.
      expect(res.headers['content-security-policy']).toBeTruthy();
      expect(res.headers['x-frame-options']).toBeTruthy();
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBeTruthy();
      // helmet v8 dropped its Permissions-Policy middleware, so the app sets
      // the header explicitly — the old `permissionsPolicy` helmet option was
      // silently ignored and no header was ever emitted.
      expect(res.headers['permissions-policy']).toContain('camera=()');
      expect(res.headers['permissions-policy']).toContain('geolocation=()');
      expect(res.headers['cross-origin-resource-policy']).toBeTruthy();
      // The app-wide no-store policy.
      expect(res.headers['cache-control']).toBe('no-store, must-revalidate, private');
      expect(res.headers.pragma).toBe('no-cache');
      expect(res.headers['surrogate-control']).toBe('no-store');
    });

    it('answers TRACK the same way (Node may reject the method before it reaches Express)', async () => {
      const res = await request('TRACK', '/tickets');
      // Node's HTTP parser only accepts a fixed set of request methods, so
      // TRACK can be rejected by the parser itself (400) before Express ever
      // sees it. Either way the request must not reach a route and must not
      // produce a server error.
      expect(res.status).toBeLessThan(500);
      if (res.status === 405) {
        expect(res.headers.allow).toBe('GET, HEAD, POST, PUT, DELETE, OPTIONS');
        expect(res.headers['content-security-policy']).toBeTruthy();
        expect(res.headers['cache-control']).toBe('no-store, must-revalidate, private');
      }
    });

    it('does not let a TRACE request reach the routes (no session cookie issued, no route side effects)', async () => {
      const before = db.prepare('SELECT COUNT(*) AS c FROM audit_log').get().c;
      const res = await request('TRACE', '/dashboard');
      expect(res.status).toBe(405);
      // The guard still short-circuits before the routes, so no audit entry and
      // no session cookie are produced for the rejected request.
      const after = db.prepare('SELECT COUNT(*) AS c FROM audit_log').get().c;
      expect(after).toBe(before);
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('sends the Permissions-Policy header on ordinary responses too', async () => {
      const res = await request('GET', '/health');
      expect(res.status).toBe(200);
      expect(res.headers['permissions-policy']).toContain('camera=()');
      expect(res.headers['permissions-policy']).toContain('microphone=()');
    });
  });
});
