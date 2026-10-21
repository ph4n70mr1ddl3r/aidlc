const http = require('http');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { describe, it, expect, beforeAll, afterAll } = require('@jest/globals');

// Regression tests for review cycle 372.
//
// Defects closed by this pass:
//
// (1) The dashboard loaded two bounded alert lists (the 20-row warranty list
//     and the 20-row license list) into its shared TTL cache on every
//     refresh — but the template never rendered a single row of either list.
//     Only their LENGTH was used, and only as the "is there anything to
//     report?" condition for an alert card whose number came from separate
//     uncapped COUNT queries. The two DASHBOARD_LIMITS caps
//     (warrantyAlerts / licenseAlerts) were therefore dead knobs: the
//     constants file promised an "(N+)" truncation marker that no list could
//     ever show — the same dead-knob class the previous cycle closed for
//     DASHBOARD_LIMITS.myTickets. The lists are now rendered, so the caps
//     are live and the reader can see WHICH assets/licenses need attention.
//
// (2) The license list is VIEWER-SCOPED: the licenses module is
//     admin/manager-only (its list and show routes are requireAdminOrManager
//     because license cost/seat data is business-sensitive), so the software
//     names are queried per request for privileged viewers only and are never
//     placed in the shared (all-users) cache — the same pattern the Upcoming
//     Changes widget already used.
//
// (3) The seeded task "Staff training" was anchored 60 days out while its
//     project ("IT Service Desk Upgrade") ends 30 days out: a fresh seed
//     showed a task due a month after the project it belongs to had already
//     finished. Every seeded task due date must now sit inside its own
//     project's window.
//
// (4) Every seeded license that carried an expiry date had already expired
//     and three of the five seeded vendor contracts had already ended — the
//     same "hardcoded absolute dates drifted into the past" defect the
//     previous cycle closed for the tickets, projects and tasks, still
//     present in the license and vendor rows. The license terms and vendor
//     contract windows are now anchored to the seed date.
//
// (5) The change-log CREATE route compared the scheduled window with a raw
//     string comparison while the UPDATE route used the minute-precision
//     _compareDateTimeMinutes helper — two subtly different rules for the
//     same validation inside one module. Both now use the helper.
//
// (6) The asset report's empty states said "No data for this period" although
//     the report is not period-scoped (none of its queries take a window and
//     the page has no period selector).
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
const dashboardRoutes = require('../src/routes/dashboard');
const { DASHBOARD_LIMITS } = require('../src/constants');

const ADMIN_USER = {
  id: 1,
  username: 'cr372admin',
  password: 'SeedAdminPass1!',
  email: 'cr372admin@company.com',
  first_name: 'Robin',
  last_name: 'Auditor',
  role: 'admin'
};

const STAFF_USER = {
  id: 2,
  username: 'cr372staff',
  password: 'SeedStaffPass1!',
  email: 'cr372staff@company.com',
  first_name: 'Sam',
  last_name: 'Technician',
  role: 'staff'
};

for (const u of [ADMIN_USER, STAFF_USER]) {
  db.prepare(`
    INSERT INTO users (id, username, password, email, first_name, last_name, role, department)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'IT')
  `).run(
    u.id,
    u.username,
    bcrypt.hashSync(u.password, 4),
    u.email,
    u.first_name,
    u.last_name,
    u.role
  );
}

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
  // The CSRF cookie is (re)issued on every response, and the double-submit
  // check needs BOTH the cookie and the body token — so merge the cookies
  // from the login response with the ones from a follow-up page load and
  // take the token from that page's meta tag.
  const page = await request('GET', '/dashboard', { cookies: cookieHeader(res.headers['set-cookie']) });
  const token = (page.body.match(/name="csrf-token" content="([^"]+)"/) || [])[1];
  return {
    cookies: cookieHeader([...(res.headers['set-cookie'] || []), ...(page.headers['set-cookie'] || [])]),
    csrfToken: token
  };
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

function daysFromNow(days) {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
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
// 1. + 2. The dashboard renders its warranty/license alert lists, and the
//         license list is privileged-only
// ---------------------------------------------------------------------------
describe('code review 372 — dashboard alert lists', () => {
  let adminSession;
  let staffSession;

  beforeAll(async () => {
    // One asset per alert-list row, plus a license that expires inside the
    // 30-day window. The names are distinctive so the assertions below can
    // tell "the row was rendered" from "the card merely counted it".
    const insertAsset = db.prepare(`
      INSERT INTO assets (asset_tag, name, category, status, warranty_expiry)
      VALUES (?, ?, 'laptop', 'in_use', ?)
    `);
    for (let i = 0; i < DASHBOARD_LIMITS.warrantyAlerts + 2; i++) {
      insertAsset.run(`AST-CR372-${i}`, `CR372 warranty ${i}`, daysFromNow(5));
    }
    db.prepare(`
      INSERT INTO licenses (software_name, vendor, license_type, total_seats, used_seats, expiry_date)
      VALUES ('CR372 Secret Suite', 'CR372 Vendor', 'subscription', 10, 1, ?)
    `).run(daysFromNow(7));
    // The dashboard aggregates into a shared TTL cache — drop it so the rows
    // inserted above are part of the next render.
    dashboardRoutes.resetCachedStatements();

    adminSession = await login(ADMIN_USER);
    staffSession = await login(STAFF_USER);
  });

  it('renders the warranty alert list rows', async () => {
    const res = await request('GET', '/dashboard', { cookies: adminSession.cookies });
    expect(res.status).toBe(200);
    expect(res.body).toContain('Warranty Ending or Expired');
    // The rows themselves — not just a count.
    expect(res.body).toContain('CR372 warranty 0');
    expect(res.body).toContain('/assets?search=AST-CR372-0');
  });

  it('discloses the warranty list truncation with the DASHBOARD_LIMITS cap', async () => {
    const res = await request('GET', '/dashboard', { cookies: adminSession.cookies });
    // The list is capped at the constant, and the heading says so.
    expect(res.body).toContain(`Warranty Ending or Expired (${DASHBOARD_LIMITS.warrantyAlerts}+)`);
    const rows = res.body.match(/AST-CR372-\d+/g) || [];
    expect(new Set(rows).size).toBe(DASHBOARD_LIMITS.warrantyAlerts);
  });

  it('renders the license alert list for a privileged viewer', async () => {
    const res = await request('GET', '/dashboard', { cookies: adminSession.cookies });
    expect(res.body).toContain('Licenses Ending or Expired');
    expect(res.body).toContain('CR372 Secret Suite');
  });

  it('does not expose license identities to a non-privileged viewer', async () => {
    const res = await request('GET', '/dashboard', { cookies: staffSession.cookies });
    expect(res.status).toBe(200);
    // The licenses module is admin/manager-only, so a staff member must not
    // see the software name — but the bare count is still reported.
    expect(res.body).not.toContain('CR372 Secret Suite');
    // The privileged-only license LIST card must not be rendered either. The
    // alert card above it IS rendered for everyone (it carries only the bare
    // count), so the list is probed by its parenthesized row count — the
    // heading text alone is shared by both cards (pass 374).
    expect(res.body).not.toContain('Licenses Ending or Expired (');
    expect(res.body).toContain('software license(s) expired or expiring within 30 days');
  });

  it('keeps the license list out of the shared (all-users) cache', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'dashboard.js'), 'utf8');
    // The shared payload must not carry the license rows — that payload is
    // rendered for every viewer. The list is fetched per request instead.
    const sharedBlock = src.slice(src.indexOf('shared = {'), src.indexOf('dashboardCache = { timestamp: now'));
    expect(sharedBlock).not.toContain('licenseAlerts: stmts.licenseAlerts.all()');
    expect(sharedBlock).toContain('licenseAlertsCount: stmts.licenseAlertsCount.get().c');
    // ... and the per-request fetch is privilege-gated.
    expect(src).toMatch(/if \(isPrivileged\(user\)\) \{[\s\S]{0,400}licenseAlerts = stmts\.licenseAlerts\.all\(\);/);
  });
});

// ---------------------------------------------------------------------------
// 3. + 4. The seeded portfolio is coherent with the seed date
// ---------------------------------------------------------------------------
describe('code review 372 — seed data coherence', () => {
  let seedDb;

  beforeAll(() => {
    seedDb = new Database(':memory:');
    seedDb.pragma('foreign_keys = ON');
    seedDb.exec(readSchemaSQL());
    const { runSeed } = require('../src/seed');
    runSeed(seedDb, 'Admin123!', 'Staff123!');
  });
  afterAll(() => {
    if (seedDb) {
      seedDb.close();
    }
  });

  it('never seeds a task due outside its own project window', () => {
    const rows = seedDb.prepare(`
      SELECT pt.id, pt.title, pt.due_date, p.start_date, p.end_date
      FROM project_tasks pt JOIN projects p ON p.id = pt.project_id
    `).all();
    expect(rows.length).toBeGreaterThan(0);
    for (const t of rows) {
      if (t.due_date && t.start_date) {
        expect(t.due_date >= t.start_date).toBe(true);
      }
      if (t.due_date && t.end_date) {
        expect(t.due_date <= t.end_date).toBe(true);
      }
    }
  });

  it('never seeds an already-expired license', () => {
    const today = new Date().toISOString().slice(0, 10);
    const rows = seedDb.prepare('SELECT software_name, expiry_date FROM licenses WHERE expiry_date IS NOT NULL').all();
    expect(rows.length).toBeGreaterThan(0);
    for (const l of rows) {
      expect(l.expiry_date >= today).toBe(true);
    }
  });

  it('seeds a license inside the 30-day dashboard alert window', () => {
    // Without one, the dashboard's "License Expiring Soon" alert could only
    // ever report long-expired records — the case it names was missing.
    const soon = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const rows = seedDb.prepare('SELECT expiry_date FROM licenses WHERE expiry_date IS NOT NULL').all();
    expect(rows.filter((l) => l.expiry_date >= today && l.expiry_date <= soon).length).toBeGreaterThan(0);
  });

  it('seeds coherent vendor contracts and keeps a running one', () => {
    const today = new Date().toISOString().slice(0, 10);
    const rows = seedDb.prepare('SELECT name, contract_start, contract_end FROM vendors').all();
    expect(rows.length).toBeGreaterThan(0);
    for (const v of rows) {
      if (v.contract_start && v.contract_end) {
        expect(v.contract_end >= v.contract_start).toBe(true);
      }
    }
    // At least one contract must still be running — a seeded vendor list
    // where every contract has lapsed contradicts the vendor list itself.
    expect(rows.filter((v) => v.contract_end && v.contract_end >= today).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 5. The change-log create and update routes share one comparison rule
// ---------------------------------------------------------------------------
describe('code review 372 — change-log create/update comparison', () => {
  let adminSession;

  beforeAll(async () => {
    adminSession = await login(ADMIN_USER);
  });

  it('uses the minute-precision comparison on the create route', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'changes.js'), 'utf8');
    const createBlock = src.slice(src.indexOf('// Create change'), src.indexOf('// Show change'));
    expect(createBlock).toContain('_compareDateTimeMinutes(sEnd, sStart)');
  });

  it('accepts a change whose scheduled window ends exactly at its start', async () => {
    const res = await request('POST', '/changes', {
      cookies: adminSession.cookies,
      body: `title=CR372 window&change_type=maintenance&scheduled_start=2030-01-01T10:00&scheduled_end=2030-01-01T10:00&_csrf=${encodeURIComponent(adminSession.csrfToken)}`
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/changes');
    const row = db.prepare("SELECT scheduled_start, scheduled_end FROM change_log WHERE title = 'CR372 window'").get();
    expect(row).toBeTruthy();
    expect(row.scheduled_start).toBe('2030-01-01 10:00');
    expect(row.scheduled_end).toBe('2030-01-01 10:00');
  });

  it('still rejects a change whose scheduled end precedes its start', async () => {
    const res = await request('POST', '/changes', {
      cookies: adminSession.cookies,
      body: `title=CR372 bad window&change_type=maintenance&scheduled_start=2030-01-01T10:00&scheduled_end=2030-01-01T09:00&_csrf=${encodeURIComponent(adminSession.csrfToken)}`
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/changes/new');
    const row = db.prepare("SELECT id FROM change_log WHERE title = 'CR372 bad window'").get();
    expect(row).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. The asset report does not advertise a period it does not filter by
// ---------------------------------------------------------------------------
describe('code review 372 — asset report wording', () => {
  it('uses period-neutral empty-state copy', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'views', 'pages', 'reports', 'assets.ejs'), 'utf8');
    expect(src).not.toContain('No data for this period');
    expect(src).toContain('No data available');
  });
});

// ---------------------------------------------------------------------------
// 7. The knowledge-base sanitizer runs a patched sanitize-html
// ---------------------------------------------------------------------------
describe('code review 372 — knowledge-base sanitizer dependency', () => {
  it('pins and locks a patched sanitize-html release', () => {
    // The knowledge base renders user-supplied markdown with
    // `<%- article.renderedContent %>` — UNESCAPED, because sanitize-html has
    // already vetted it. The pinned 2.17.7 release carries three known
    // bypass advisories (a <noscript> implied-close region escape, an SMIL
    // namespace-prefix javascript: URI injection, and a meta-refresh
    // javascript:/data: URL), each of which is a stored-XSS vector in the
    // article body. The dependency now resolves to the patched 2.18.1.
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    expect(pkg.dependencies['sanitize-html']).toBe('^2.18.1');
    const lock = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package-lock.json'), 'utf8'));
    expect(lock.packages['node_modules/sanitize-html'].version).toBe('2.18.1');
  });

  it('adds only inert tags to the sanitizer allowlist', () => {
    // The app extends the library defaults with exactly four tags — none of
    // them interactive or script-capable ('input' is deliberately excluded:
    // an article body rendering form controls is a stored UI-injection
    // vector).
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'knowledge.js'), 'utf8');
    expect(src).toContain("concat(['img', 'details', 'summary', 'del'])");
  });
});
