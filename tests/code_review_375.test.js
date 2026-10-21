const http = require('http');
const fs = require('fs');
const path = require('path');
const { describe, it, expect, beforeAll, afterAll, beforeEach } = require('@jest/globals');

// Regression tests for review cycle 375.
//
// Defects closed by this pass:
//
// (1) reports.js — the "Top Resolvers" card on /reports/tickets is capped at
//     10 rows but disclosed NO truncation. It was the only capped list in the
//     app that truncated silently: a period with 14 resolvers rendered 10
//     names under a heading that implied completeness, while every sibling
//     capped list says so (the dashboard's exact "(N+)" markers, the asset
//     report's "Showing N of M assets, earliest warranty end date first.", the staff report's
//     "Showing the top N of M active staff."). The route now also computes
//     the uncapped resolver count and the page discloses the slice.
//
// (2) dashboard.js — the two alert lists (warranty / licence) derived their
//     "(N+)" marker from a SECOND query (the uncapped count) instead of from
//     the list itself. The licence list is fetched PER REQUEST while its
//     count comes from the shared 30-second TTL cache, so the two could
//     disagree: the marker could claim a truncation that does not exist (a
//     licence was deleted/renewed inside the cache window) or hide one that
//     does (a licence was created inside the window). Both alert lists now
//     use the app-wide one-row-beyond-the-cap truncation probe, so the
//     marker is exact and self-contained; the counts feed the alert CARDS.
//
// (3) seed.js — every seeded asset warranty had ALREADY expired and none
//     expires inside the 30-day dashboard alert window, so the "expiring
//     soon" case the alert names was never represented — the same defect
//     pass 372 fixed for the seeded licence terms. The seeded asset
//     purchase dates and warranty expiries are now anchored to the seed date.
//
// (4) README.md — the partial-update section advertised a dedicated `clear`
//     control that does not exist anywhere in the app (the only clear
//     control is the licence form's `clear_key` checkbox; the magic
//     `_CLEAR_` sentinel it referred to was removed in an earlier pass).
//
// The env must be set BEFORE requiring the app: src/app.js reads DB_PATH at
// require time (src/models/database.js resolves it when the module loads).
process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-0123456789abcdef';
process.env.CSRF_SECRET = 'test-csrf-secret-0123456789abcdef';

const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const db = require('../src/models/database');
const app = require('../src/app.js');
const dashboardRoutes = require('../src/routes/dashboard');
const { DASHBOARD_LIMITS } = require('../src/constants');

const ADMIN_USER = {
  id: 1,
  username: 'cr375admin',
  password: 'SeedAdminPass1!',
  email: 'cr375admin@company.com',
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
// given cookie name wins.
function cookieHeader(setCookie) {
  const map = new Map();
  for (const cookie of setCookie || []) {
    const pair = cookie.split(';')[0];
    const idx = pair.indexOf('=');
    map.set(pair.slice(0, idx), pair.slice(idx + 1));
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function login(user) {
  const loginPage = await request('GET', '/login');
  const csrf = (loginPage.body.match(/name="_csrf" value="([^"]+)"/) || [])[1];
  const res = await request('POST', '/login', {
    cookies: cookieHeader(loginPage.headers['set-cookie']),
    body: `username=${encodeURIComponent(user.username)}&password=${encodeURIComponent(user.password)}&_csrf=${encodeURIComponent(csrf)}`
  });
  expect(res.status).toBe(302);
  const page = await request('GET', '/dashboard', { cookies: cookieHeader(res.headers['set-cookie']) });
  const token = (page.body.match(/name="csrf-token" content="([^"]+)"/) || [])[1];
  return {
    cookies: cookieHeader([...(res.headers['set-cookie'] || []), ...(page.headers['set-cookie'] || [])]),
    csrfToken: token
  };
}

function daysFromNow(n) {
  return new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
}

// Read the schema SQL directly from database.js (mirrors tests/seed.test.js)
// so the seed can run against a throwaway in-memory database.
function readSchemaSQL() {
  const appPath = path.join(__dirname, '..', 'src', 'models', 'database.js');
  const src = fs.readFileSync(appPath, 'utf8');
  const match = src.match(/db\.exec\(\s*`([\s\S]*?)`\s*\)/);
  if (!match) {
    throw new Error('Could not find initSchema SQL in database.js');
  }
  return match[1];
}

beforeAll(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      port = server.address().port;
      resolve();
    });
  });
});

afterAll(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ---------------------------------------------------------------------------
// 1. The ticket report's "Top Resolvers" card discloses its truncation
// ---------------------------------------------------------------------------
describe('code review 375 — ticket report resolver-card disclosure', () => {
  let admin;

  beforeAll(async () => {
    admin = await login(ADMIN_USER);
  });

  beforeEach(() => {
    db.exec('DELETE FROM tickets;');
    db.exec('DELETE FROM users WHERE id >= 100;');
    dashboardRoutes.resetCachedStatements();
  });

  function seedResolvers(count) {
    // One resolver each, so the number of DISTINCT resolvers equals the
    // number of rows the grouped query returns.
    const insertUser = db.prepare(`
      INSERT INTO users (id, username, password, email, first_name, last_name, role, department)
      VALUES (?, ?, 'x', ?, ?, 'Resolver', 'staff', 'IT')
    `);
    const insertTicket = db.prepare(`
      INSERT INTO tickets (ticket_number, title, category, priority, status, requester_name, requester_email, assigned_to, resolved_at)
      VALUES (?, ?, 'other', 'low', 'resolved', 'R', 'r@example.com', ?, datetime('now', '-1 day'))
    `);
    for (let i = 0; i < count; i++) {
      const uid = 100 + i;
      insertUser.run(uid, `cr375res${i}`, `cr375res${i}@example.com`, `Res${i}`);
      insertTicket.run(`TK-CR375-${i}`, `Resolved by ${i}`, uid);
    }
  }

  it('discloses the truncation when more resolvers exist than the list shows', async () => {
    seedResolvers(12);
    const res = await request('GET', '/reports/tickets', { cookies: admin.cookies });
    expect(res.status).toBe(200);
    // The list holds 10 rows (the query's LIMIT); the card must say so.
    expect(res.body).toContain('Showing the top 10 of 12 resolvers.');
  });

  it('does not claim a truncation when the resolver list is complete', async () => {
    seedResolvers(10);
    const res = await request('GET', '/reports/tickets', { cookies: admin.cookies });
    expect(res.status).toBe(200);
    expect(res.body).not.toContain('Showing the top');
    expect(res.body).not.toContain('of 10 resolvers');
  });

  it('exposes an uncapped resolver count alongside the capped list', () => {
    const reports = require('../src/routes/reports');
    const stmt = reports.__stmts.topResolversCount;
    expect(stmt).toBeTruthy();
    seedResolvers(12);
    expect(stmt.get(30).c).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// 2. The dashboard alert lists derive their marker from the list, not a
//    separately-cached count
// ---------------------------------------------------------------------------
describe('code review 375 — dashboard alert-list truncation markers', () => {
  let admin;
  let _licenseIdBase = 2000;

  beforeAll(async () => {
    admin = await login(ADMIN_USER);
  });

  beforeEach(() => {
    db.exec('DELETE FROM licenses;');
    _licenseIdBase = 2000;
    dashboardRoutes.resetCachedStatements();
  });

  function insertLicenses(count) {
    const insert = db.prepare(`
      INSERT INTO licenses (id, software_name, vendor, license_type, total_seats, used_seats, expiry_date)
      VALUES (?, ?, 'CR375 Vendor', 'subscription', 5, 1, ?)
    `);
    const base = _licenseIdBase;
    _licenseIdBase += count;
    for (let i = 0; i < count; i++) {
      insert.run(base + i, `CR375 Suite ${base + i}`, daysFromNow(5));
    }
    return { base, count };
  }

  it('does not claim a truncation when the licence list became complete inside the cache window', async () => {
    // 25 qualifying licences: the first render caches the count (25) while
    // the list (fetched per request) shows the capped 20.
    const inserted = insertLicenses(25);
    const first = await request('GET', '/dashboard', { cookies: admin.cookies });
    expect(first.status).toBe(200);
    expect(first.body).toContain(`Licenses Ending or Expired (${DASHBOARD_LIMITS.licenseAlerts}+)`);

    // Five licences are withdrawn while the shared cache still holds the old
    // count. The list is now COMPLETE (exactly one cap's worth), so the
    // marker must disappear — a count-derived marker would still compare
    // 20 against the stale 25 and claim a truncation that no longer exists.
    db.prepare('DELETE FROM licenses WHERE id > ?').run(inserted.base + inserted.count - 6);

    const second = await request('GET', '/dashboard', { cookies: admin.cookies });
    expect(second.status).toBe(200);
    expect(second.body).toContain(`Licenses Ending or Expired (${DASHBOARD_LIMITS.licenseAlerts})`);
    expect(second.body).not.toContain(`Licenses Ending or Expired (${DASHBOARD_LIMITS.licenseAlerts}+)`);
  });

  it('discloses a truncation that appeared inside the cache window', async () => {
    // Exactly one cap's worth of licences: the list is complete, so the
    // marker must be absent.
    insertLicenses(DASHBOARD_LIMITS.licenseAlerts);
    const first = await request('GET', '/dashboard', { cookies: admin.cookies });
    expect(first.status).toBe(200);
    expect(first.body).toContain(`Licenses Ending or Expired (${DASHBOARD_LIMITS.licenseAlerts})`);
    expect(first.body).not.toContain(`Licenses Ending or Expired (${DASHBOARD_LIMITS.licenseAlerts}+)`);

    // One more licence qualifies. The list is now over the cap (and really
    // truncated), but the cached count is still the old one — a count-derived
    // marker would compare the capped length against the stale count and
    // report no truncation at all.
    insertLicenses(1);
    const second = await request('GET', '/dashboard', { cookies: admin.cookies });
    expect(second.status).toBe(200);
    expect(second.body).toContain(`Licenses Ending or Expired (${DASHBOARD_LIMITS.licenseAlerts}+)`);
  });

  it('drives both alert-list markers from the exact truncation flags', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'dashboard.js'), 'utf8');
    // The alert lists fetch one row beyond their cap (the truncation probe).
    expect(src).toContain('LIMIT ${_DASH_WARRANTY_LIMIT + 1}');
    expect(src).toContain('LIMIT ${_DASH_LICENSE_ALERTS_LIMIT + 1}');
    // ... and the route turns that probe into the exact flag the template
    // renders — the marker must not be derived from the (separately cached)
    // count any more.
    expect(src).toContain('expiringWarrantiesTruncated: expiringWarrantiesCap.truncated');
    expect(src).toContain('licenseAlertsTruncated: licenseAlertsCap.truncated');

    const view = fs.readFileSync(path.join(__dirname, '..', 'views', 'pages', 'dashboard.ejs'), 'utf8');
    expect(view).toContain('expiringWarrantiesTruncated');
    expect(view).toContain('licenseAlertsTruncated');
    expect(view).not.toContain('expiringWarranties.length < expiringWarrantiesCount');
    expect(view).not.toContain('licenseAlerts.length < licenseAlertsCount');
  });
});

// ---------------------------------------------------------------------------
// 3. The seeded asset portfolio is coherent with the seed date
// ---------------------------------------------------------------------------
describe('code review 375 — seed asset warranty coherence', () => {
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

  it('never seeds an asset whose warranty expires before its purchase date', () => {
    const rows = seedDb.prepare('SELECT asset_tag, purchase_date, warranty_expiry FROM assets').all();
    expect(rows.length).toBeGreaterThan(0);
    for (const a of rows) {
      if (a.purchase_date && a.warranty_expiry) {
        expect(a.warranty_expiry >= a.purchase_date).toBe(true);
      }
    }
  });

  it('seeds an asset whose warranty expires inside the 30-day alert window', () => {
    // Without one, the dashboard's "Warranty Ending or Expired" alert could
    // only ever report long-expired records — the "expiring soon" case it
    // names was missing.
    const today = new Date().toISOString().slice(0, 10);
    const soon = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const rows = seedDb.prepare('SELECT warranty_expiry FROM assets WHERE warranty_expiry IS NOT NULL').all();
    const expiringSoon = rows.filter((a) => a.warranty_expiry >= today && a.warranty_expiry <= soon);
    expect(expiringSoon.length).toBeGreaterThan(0);
  });

  it('keeps at least one seeded warranty live', () => {
    // A fleet where EVERY warranty has expired contradicts the asset list:
    // the "Warranty Ending or Expired" card would report the whole inventory
    // as a problem.
    const soon = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const rows = seedDb.prepare('SELECT warranty_expiry FROM assets WHERE warranty_expiry IS NOT NULL').all();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((a) => a.warranty_expiry > soon).length).toBeGreaterThan(0);
  });

  it('exercises the dashboard warranty-alert window with the seeded fleet', () => {
    // The same predicate the dashboard's warranty alert list uses.
    const qualifying = seedDb.prepare(`
      SELECT COUNT(*) as c FROM assets
      WHERE warranty_expiry IS NOT NULL AND warranty_expiry <= date('now', '+30 days')
        AND status != 'disposed'
    `).get().c;
    expect(qualifying).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 4. The README no longer advertises a control that does not exist
// ---------------------------------------------------------------------------
describe('code review 375 — documentation matches the app', () => {
  it('the only clear control in the app is the licence form\'s clear_key', () => {
    const viewsDir = path.join(__dirname, '..', 'views');
    const clearControls = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith('.ejs')) {
          const src = fs.readFileSync(full, 'utf8');
          for (const m of src.matchAll(/name="(clear[^"]*)"/g)) {
            clearControls.push(m[1]);
          }
        }
      }
    };
    walk(viewsDir);
    expect(clearControls).toEqual(['clear_key']);
  });

  it('the README documents the clear_key control and no phantom `clear` control', () => {
    const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
    expect(readme).toContain('`clear_key`');
    expect(readme).not.toContain('`clear`');
    expect(readme).not.toContain('`clear_key` / `clear`');
  });
});
