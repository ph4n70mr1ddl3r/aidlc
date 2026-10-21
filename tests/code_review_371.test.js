const http = require('http');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { describe, it, expect, beforeAll, afterAll } = require('@jest/globals');

// Regression tests for review cycle 371.
//
// Defects closed by this pass:
//
// (1) The change-log range validation compared a STORED datetime against a
//     SUBMITTED one with a raw string comparison. The routes write
//     "YYYY-MM-DD HH:MM" (safeDateTimeLocal) but the seeder wrote
//     "YYYY-MM-DD HH:MM:SS", and the shorter prefix sorts FIRST
//     ("2026-05-20 02:00" < "2026-05-20 02:00:00") even though both denote
//     the same instant. A legitimate update — moving the scheduled end to the
//     same minute as the scheduled start — was therefore rejected with
//     "Scheduled end must be on or after scheduled start" and silently not
//     saved. The comparison is now minute-precision, and the seeder writes the
//     canonical minute format.
//
// (2) DASHBOARD_LIMITS.myTickets was a dead knob: the dashboard's "My Active
//     Tickets" query used DASHBOARD_LIMITS.recentTickets while the template
//     compared the rendered row count against DASHBOARD_LIMITS.myTickets to
//     decide whether to show the "(N+)" truncation marker. The two could
//     drift, contradicting the "the two can never drift" promise in
//     constants.js.
//
// (3) The README's rate-limiting bullet enumerated only part of the app's
//     limiters — the profile-update, ticket quick-status, ticket
//     satisfaction, staff-reactivation and admin-password-reset limiters were
//     missing. The bullet is now verified mechanically against the limiters
//     declared in src/.
//
// (4) The seeded project windows and task due dates were hardcoded absolute
//     dates that had already drifted into the past: a fresh seed showed an
//     "in_progress" project whose end date was two months ago, a "planning"
//     project that started four months ago, and five open tasks whose due
//     date had passed (each rendering as "Overdue"). The seeded portfolio is
//     now anchored relative to seed time, like the ticket due date and the
//     scheduled changes already were.
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
const changesRoutes = require('../src/routes/changes');
const { DASHBOARD_LIMITS } = require('../src/constants');

const ADMIN_USER = {
  id: 1,
  username: 'cr371admin',
  password: 'SeedAdminPass1!',
  email: 'cr371admin@company.com',
  first_name: 'Robin',
  last_name: 'Auditor',
  role: 'admin'
};

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

// Merge Set-Cookie headers the way a browser does: the LAST value for a
// given cookie name wins (a duplicate cookie would otherwise make
// cookie-parser read the stale value and break the CSRF double-submit).
function cookieHeader(setCookie) {
  const map = new Map();
  for (const cookie of (setCookie || [])) {
    const pair = cookie.split(';')[0];
    const idx = pair.indexOf('=');
    map.set(pair.slice(0, idx), pair.slice(idx + 1));
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

// Read the schema SQL directly from database.js (mirrors tests/seed.test.js)
// so the seed can run against a throwaway in-memory database.
function readSchemaSQL() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'models', 'database.js'), 'utf8');
  const match = src.match(/db\.exec\(\s*`([\s\S]*?)`\s*\)/);
  if (!match) {
    throw new Error('Could not find initSchema SQL in database.js');
  }
  return match[1];
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

// ---------------------------------------------------------------------------
// 1. Change-log range validation compares instants, not string shapes
// ---------------------------------------------------------------------------
describe('code review 371 — change-log datetime range validation', () => {
  let sessionCookie;
  let csrfToken;

  beforeAll(async () => {
    const loginPage = await request('GET', '/login');
    const csrf = (loginPage.body.match(/name="_csrf" value="([^"]+)"/) || [])[1];
    const login = await request('POST', '/login', {
      cookies: cookieHeader(loginPage.headers['set-cookie']),
      body: `username=${encodeURIComponent(ADMIN_USER.username)}&password=${encodeURIComponent(ADMIN_USER.password)}&_csrf=${encodeURIComponent(csrf)}`
    });
    expect(login.status).toBe(302);
    const dash = await request('GET', '/dashboard', { cookies: cookieHeader(login.headers['set-cookie']) });
    csrfToken = (dash.body.match(/name="csrf-token" content="([^"]+)"/) || [])[1];
    sessionCookie = cookieHeader([...(login.headers['set-cookie'] || []), ...(dash.headers['set-cookie'] || [])]);
  });

  it('compares datetimes at minute precision', () => {
    const compare = changesRoutes.compareDateTimeMinutes;
    expect(typeof compare).toBe('function');
    // Same instant, different storage shapes → equal, not "end before start".
    expect(compare('2026-05-20 02:00', '2026-05-20 02:00:00')).toBe(0);
    expect(compare('2026-05-20 02:00:00', '2026-05-20 02:00')).toBe(0);
    // Genuine ordering is preserved.
    expect(compare('2026-05-20 02:00', '2026-05-20 03:00')).toBe(-1);
    expect(compare('2026-05-20 03:00', '2026-05-20 02:00:00')).toBe(1);
  });

  it('accepts an update that moves the scheduled end to the stored start minute', async () => {
    // A change stored in the seeder's legacy seconds format.
    db.prepare(`
      INSERT INTO change_log (id, title, change_type, status, priority, scheduled_start, scheduled_end)
      VALUES (77, 'Legacy window', 'maintenance', 'scheduled', 'medium', '2026-05-20 02:00:00', '2026-05-20 03:00:00')
    `).run();

    const res = await request('POST', '/changes/77?_method=PUT', {
      cookies: sessionCookie,
      body: `title=Legacy window&change_type=maintenance&scheduled_end=2026-05-20T02:00&_csrf=${encodeURIComponent(csrfToken)}`
    });
    // The update must be applied (redirect to the show page), NOT bounced back
    // to the edit form with "end must be on or after start".
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/changes/77');
    const row = db.prepare('SELECT scheduled_start, scheduled_end FROM change_log WHERE id = 77').get();
    expect(row.scheduled_end).toBe('2026-05-20 02:00');
    expect(row.scheduled_start).toBe('2026-05-20 02:00:00');
  });

  it('still rejects a genuine end-before-start update', async () => {
    db.prepare(`
      INSERT INTO change_log (id, title, change_type, status, priority, scheduled_start, scheduled_end)
      VALUES (78, 'Bad window', 'maintenance', 'scheduled', 'medium', '2026-05-20 05:00', '2026-05-20 03:00')
    `).run();

    const res = await request('POST', '/changes/78?_method=PUT', {
      cookies: sessionCookie,
      body: `title=Bad window&change_type=maintenance&scheduled_end=2026-05-19T03:00&_csrf=${encodeURIComponent(csrfToken)}`
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/changes/78/edit');
    const row = db.prepare('SELECT scheduled_end FROM change_log WHERE id = 78').get();
    expect(row.scheduled_end).toBe('2026-05-20 03:00');
  });
});

// ---------------------------------------------------------------------------
// 2. The dashboard "My Active Tickets" cap and its marker share one knob
// ---------------------------------------------------------------------------
describe('code review 371 — dashboard my-tickets cap wiring', () => {
  it('caps the myTickets query with the constant the truncation marker reads', () => {
    // Structural pin: the "My Active Tickets" card renders the row count and
    // decides whether to show the "(N+)" marker from
    // DASHBOARD_LIMITS.myTickets, so the query that fills that card must be
    // capped by the SAME constant. It used to reuse
    // DASHBOARD_LIMITS.recentTickets, leaving the two free to drift.
    //
    // The query fetches ONE row beyond the cap — the truncation probe — so
    // the marker can be exact (a list holding exactly as many rows as the cap
    // is complete and must not be marked). The probe is derived from the same
    // constant, so the two can still never drift apart (pass 374).
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'dashboard.js'), 'utf8');
    expect(src).toContain('const _DASH_MY_TICKETS_LIMIT = DASHBOARD_LIMITS.myTickets;');
    const myTicketsBlock = src.slice(src.indexOf('myTickets: db.prepare('));
    expect(myTicketsBlock).toContain('LIMIT ${_DASH_MY_TICKETS_LIMIT + 1}');
    expect(myTicketsBlock).not.toContain('_DASH_RECENT_TICKETS_LIMIT');
    expect(DASHBOARD_LIMITS.myTickets).toBeGreaterThan(0);
  });

  it('renders at most DASHBOARD_LIMITS.myTickets rows and discloses the truncation', async () => {
    const loginPage = await request('GET', '/login');
    const csrf = (loginPage.body.match(/name="_csrf" value="([^"]+)"/) || [])[1];
    const login = await request('POST', '/login', {
      cookies: cookieHeader(loginPage.headers['set-cookie']),
      body: `username=${encodeURIComponent(ADMIN_USER.username)}&password=${encodeURIComponent(ADMIN_USER.password)}&_csrf=${encodeURIComponent(csrf)}`
    });
    const dash = await request('GET', '/dashboard', { cookies: cookieHeader(login.headers['set-cookie']) });

    const insert = db.prepare(`
      INSERT INTO tickets (ticket_number, title, category, priority, status, requester_name, requester_email, assigned_to)
      VALUES (?, ?, 'other', 'low', 'open', 'Req', 'req@example.com', ?)
    `);
    for (let i = 0; i < DASHBOARD_LIMITS.myTickets + 2; i++) {
      insert.run(`TK-CR371-${i}`, `CR371 ticket ${i}`, ADMIN_USER.id);
    }
    const after = await request('GET', '/dashboard', { cookies: cookieHeader(login.headers['set-cookie']) });
    // The card heading discloses the truncation once the cap is reached.
    expect(after.body).toContain(`My Active Tickets (${DASHBOARD_LIMITS.myTickets}+)`);
    // ... and the list itself is capped at the same number.
    const rows = after.body.match(/TK-CR371-\d+/g) || [];
    expect(new Set(rows).size).toBe(DASHBOARD_LIMITS.myTickets);
    expect(dash.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 3. README rate-limiting documentation matches the limiters in src/
// ---------------------------------------------------------------------------
describe('code review 371 — README rate-limiter documentation', () => {
  const SRC_DIR = path.join(__dirname, '..', 'src');

  function collectLimiters() {
    const found = [];
    const files = [];
    (function walk(dir) {
      for (const entry of fs.readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (fs.statSync(full).isDirectory()) {
          walk(full);
        } else if (entry.endsWith('.js')) {
          files.push(full);
        }
      }
    })(SRC_DIR);
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      const re = /rateLimit\(\{([^}]*)\}/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        const body = m[1];
        const windowMatch = body.match(/windowMs:\s*([0-9_*\s+]+?)\s*[,}]/);
        const maxMatch = body.match(/max:\s*([0-9]+)/);
        if (!windowMatch || !maxMatch) {
          continue;
        }
        // The windowMs values are simple arithmetic expressions over integers
        // ("60 * 1000", "15 * 60 * 1000", …) written in the app's own source.
        const windowMs = Function(`"use strict"; return (${windowMatch[1].trim()});`)();
        found.push({ file: path.basename(file), max: Number(maxMatch[1]), windowMs });
      }
    }
    return found;
  }

  function unitFor(windowMs) {
    if (windowMs === 60 * 1000) {
      return 'min';
    }
    if (windowMs === 15 * 60 * 1000) {
      return '15 min';
    }
    if (windowMs === 60 * 60 * 1000) {
      return 'hour';
    }
    if (windowMs === 5 * 60 * 1000) {
      return '5 min';
    }
    return null;
  }

  it('documents every distinct rate-limit budget declared in src/', () => {
    const limiters = collectLimiters();
    // Guard against a silently empty scan.
    expect(limiters.length).toBeGreaterThanOrEqual(15);

    const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
    const bullet = readme
      .split('\n')
      .find((line) => line.includes('**Rate limiting**'));
    expect(bullet).toBeTruthy();

    const documented = new Set(
      limiters.map((l) => `${l.max}/${unitFor(l.windowMs)}`).filter((s) => !s.endsWith('/null'))
    );
    expect(documented.size).toBeGreaterThanOrEqual(8);

    const missing = [...documented].filter((entry) => !bullet.includes(entry));
    expect(missing).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. The seeded portfolio is anchored to the seed date, not to hardcoded dates
// ---------------------------------------------------------------------------
describe('code review 371 — seed data freshness', () => {
  let seedDb;

  beforeAll(() => {
    seedDb = new Database(':memory:');
    seedDb.pragma('foreign_keys = ON');
    seedDb.exec(readSchemaSQL());
    const { runSeed } = require('../src/seed');
    runSeed(seedDb, 'AdminPassword123!', 'StaffPassword123!');
  });
  afterAll(() => {
    if (seedDb) {
      seedDb.close();
    }
  });

  it('never seeds an open task that is already overdue', () => {
    const today = new Date().toISOString().slice(0, 10);
    const overdue = seedDb
      .prepare("SELECT id, title, due_date FROM project_tasks WHERE status != 'done'")
      .all()
      .filter((t) => t.due_date && t.due_date < today);
    expect(overdue).toEqual([]);
  });

  it('never seeds an active project whose window contradicts its status', () => {
    const today = new Date().toISOString().slice(0, 10);
    const rows = seedDb.prepare('SELECT id, name, status, start_date, end_date FROM projects').all();
    for (const p of rows) {
      if (p.status === 'in_progress' || p.status === 'on_hold') {
        expect(p.end_date >= today).toBe(true);
      }
      if (p.status === 'planning') {
        expect(p.start_date >= today).toBe(true);
      }
      if (p.status === 'completed' || p.status === 'cancelled') {
        expect(p.end_date < today).toBe(true);
      }
    }
  });

  it('stores change-log datetimes in the canonical minute format the routes write', () => {
    const rows = seedDb.prepare('SELECT scheduled_start, scheduled_end, actual_start, actual_end FROM change_log').all();
    expect(rows.length).toBeGreaterThan(0);
    const canonical = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
    for (const row of rows) {
      for (const value of [row.scheduled_start, row.scheduled_end, row.actual_start, row.actual_end]) {
        if (value) {
          expect(value).toMatch(canonical);
        }
      }
    }
  });

  it('keeps the scheduled changes in the future', () => {
    const now = Date.now();
    const scheduled = seedDb.prepare("SELECT scheduled_start FROM change_log WHERE status = 'scheduled'").all();
    expect(scheduled.length).toBe(3);
    for (const row of scheduled) {
      expect(new Date(row.scheduled_start.replace(' ', 'T')).getTime()).toBeGreaterThan(now);
    }
  });
});
