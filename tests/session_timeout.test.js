const http = require('http');
const express = require('express');
const session = require('express-session');
const { describe, it, expect } = require('@jest/globals');

// Boot the real app.js (mocking the DB-backed deps the same way app.test.js
// does) so the REAL middleware/auth.destroySessionAndRedirect is exercised by
// the session-timeout middleware registered in app.js.
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

const mockRouter = () => require('express').Router();

jest.mock('../src/routes/auth', () => {
  const Router = require('express').Router;
  const router = Router();
  router.stopLoginFailureCleanup = jest.fn();
  router.clearLoginFailure = jest.fn();
  router.clearIpLoginFailure = jest.fn();
  return router;
});
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
  escapeHtml: jest.fn(),
  isValidEmail: jest.fn(),
  isExpiringSoon: jest.fn(),
  titleCase: jest.fn(),
  isPrivileged: jest.fn(() => false),
  badgeClass: jest.fn(),
  normalizeIp: (ip) => ip,
  CONDITION_BADGE: {},
  CHANGE_TYPE_BADGE: {},
  ROLE_BADGE: {},
  pruneAuditLog: jest.fn(() => 0),
  createAuditLogPruner: jest.fn(() => () => {}),
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
  MAX_SEARCH: 100,
  ALLOWED_ACTIONS: ['create', 'update', 'delete', 'login', 'logout', 'reactivate', 'deactivate', 'reset_password', 'rate', 'comment'],
  ALLOWED_ENTITY_TYPES: ['ticket', 'asset', 'user', 'project', 'vendor', 'knowledge', 'change', 'license', 'report', 'audit'],
  MAX_AUDIT_DETAILS: 500
}));

process.env.SESSION_SECRET = 'test-session-secret-do-not-use-in-production-32chars!!';
process.env.CSRF_SECRET = 'test-csrf-secret-do-not-use-in-production-32chars!!';

const { createSessionTimeoutMiddleware } = require('../src/app');
const app = require('../src/app');

const SID_COOKIE = 'itm_sid';

function extractCookies(setCookie) {
  if (!setCookie) {
    return '';
  }
  const jar = [];
  for (const header of setCookie) {
    const [pair] = header.split(';');
    if (pair && pair.includes('=')) {
      jar.push(pair);
    }
  }
  return jar.join('; ');
}

function buildMiniApp({ idleMs, absoluteMs }) {
  const mini = express();
  mini.use(session({
    name: SID_COOKIE,
    secret: 'mini-session-secret-0123456789abcdef',
    store: new session.MemoryStore(),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, sameSite: 'lax', secure: false, path: '/', maxAge: 3600000 }
  }));
  // Simulate the real login timing: the timeout middleware must observe an
  // already-authenticated session (in production the user is attached during
  // the POST /login request), so the sessionStart/lastAccess anchors are set as
  // soon as the session carries a user.
  mini.use((req, res, next) => {
    if (req.path === '/set') {
      req.session.user = { id: 999, username: 'sessionuser' };
    }
    next();
  });
  mini.use(createSessionTimeoutMiddleware(idleMs, absoluteMs));
  mini.get('/set', (req, res) => {
    res.json({ ok: true });
  });
  mini.get('/touch', (req, res) => {
    res.json({ hasUser: Boolean(req.session.user) });
  });
  mini.get('/meta', (req, res) => {
    res.json({
      hasUser: Boolean(req.session.user),
      sessionStart: req.session.sessionStart ?? null,
      lastAccess: req.session.lastAccess ?? null
    });
  });

  return mini;
}

async function startServer(serverApp) {
  const server = await new Promise((resolve, reject) => {
    const s = http.createServer(serverApp);
    s.once('listening', () => resolve(s));
    s.once('error', reject);
    s.listen(0, '127.0.0.1');
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

describe('Session idle timeout middleware', () => {
  let ctx;
  beforeAll(async () => {
    ctx = await startServer(buildMiniApp({ idleMs: 400, absoluteMs: 60000 }));
  });
  afterAll(async () => {
    await new Promise(resolve => ctx.server.close(resolve));
  });

  it('passes unauthenticated requests through untouched (no redirect)', async () => {
    const before = Date.now();
    const res = await fetch(`${ctx.base}/touch`, { redirect: 'manual' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hasUser: false });
    expect(Date.now() - before).toBeLessThan(400);
  });

  it('lets an authenticated request through within the idle window', async () => {
    const setRes = await fetch(`${ctx.base}/set`, { redirect: 'manual' });
    const cookie = extractCookies(setRes.headers.getSetCookie());
    await sleep(50);
    const res = await fetch(`${ctx.base}/touch`, { redirect: 'manual', headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hasUser: true });
  });

  it('destroys the session and redirects with reason=session_idle after the idle window', async () => {
    const setRes = await fetch(`${ctx.base}/set`, { redirect: 'manual' });
    const cookie = extractCookies(setRes.headers.getSetCookie());
    await sleep(600);
    const res = await fetch(`${ctx.base}/touch`, { redirect: 'manual', headers: { Cookie: cookie } });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login?reason=session_idle');
    // The session cookie must be cleared, not merely expired server-side.
    const setCookie = res.headers.getSetCookie();
    expect(setCookie.some(h => {
      const lower = h.toLowerCase();
      return lower.startsWith('itm_sid=') && (lower.includes('max-age=0') || lower.includes('1970'));
    })).toBe(true);
  });

  it('renders the replayed old cookie useless after expiry (session gone, pass-through)', async () => {
    const setRes = await fetch(`${ctx.base}/set`, { redirect: 'manual' });
    const cookie = extractCookies(setRes.headers.getSetCookie());
    await sleep(600);
    await fetch(`${ctx.base}/touch`, { redirect: 'manual', headers: { Cookie: cookie } });
    const after = await fetch(`${ctx.base}/touch`, { redirect: 'manual', headers: { Cookie: cookie } });
    expect(after.status).toBe(200);
    expect(await after.json()).toEqual({ hasUser: false });
  });

  it('throttles lastAccess writes (once a minute) and anchors sessionStart', async () => {
    const setRes = await fetch(`${ctx.base}/set`, { redirect: 'manual' });
    const cookie = extractCookies(setRes.headers.getSetCookie());
    const first = await (await fetch(`${ctx.base}/meta`, { headers: { Cookie: cookie } })).json();
    const second = await (await fetch(`${ctx.base}/meta`, { headers: { Cookie: cookie } })).json();
    expect(first.hasUser).toBe(true);
    expect(second.hasUser).toBe(true);
    expect(first.sessionStart).toBeGreaterThan(0);
    expect(first.lastAccess).toBeGreaterThan(0);
    // Two rapid requests inside the 60s throttle window must not bump lastAccess.
    expect(second.lastAccess).toBe(first.lastAccess);
  });
});

describe('Session absolute timeout middleware', () => {
  let ctx;
  beforeAll(async () => {
    ctx = await startServer(buildMiniApp({ idleMs: 60000, absoluteMs: 300 }));
  });
  afterAll(async () => {
    await new Promise(resolve => ctx.server.close(resolve));
  });

  it('redirects with reason=session_expired once the absolute lifetime is exceeded', async () => {
    const setRes = await fetch(`${ctx.base}/set`, { redirect: 'manual' });
    const cookie = extractCookies(setRes.headers.getSetCookie());
    await sleep(200);
    const within = await fetch(`${ctx.base}/touch`, { redirect: 'manual', headers: { Cookie: cookie } });
    expect(within.status).toBe(200);
    await sleep(250);
    const res = await fetch(`${ctx.base}/touch`, { redirect: 'manual', headers: { Cookie: cookie } });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login?reason=session_expired');
  });
});

describe('App-level session timeout wiring', () => {
  let ctx;
  beforeAll(async () => {
    ctx = await startServer(app);
  });
  afterAll(async () => {
    await new Promise(resolve => ctx.server.close(resolve));
  });

  it('exports the timeout middleware factory', () => {
    expect(typeof createSessionTimeoutMiddleware).toBe('function');
  });

  it('allows unauthenticated requests through the wired middleware', async () => {
    const res = await fetch(`${ctx.base}/__st_smoke`, { redirect: 'manual' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hasUser: false });
  });

  it('allows authenticated sessions through while inside the default windows', async () => {
    const login = await fetch(`${ctx.base}/__st_login`, { redirect: 'manual' });
    const cookie = extractCookies(login.headers.getSetCookie());
    const res = await fetch(`${ctx.base}/__st_smoke`, { redirect: 'manual', headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hasUser: true });
  });
});
