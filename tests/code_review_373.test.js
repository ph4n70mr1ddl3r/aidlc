const http = require('http');
const fs = require('fs');
const path = require('path');
const { describe, it, expect, beforeAll, afterAll } = require('@jest/globals');

// Regression tests for review cycle 373.
//
// Defects closed by this pass:
//
// (1) licenses.js — the show route rendered '****' + the last four characters
//     of the license key, shipping part of the secret in the HTML body. That
//     bypassed the audited and rate-limited POST /licenses/:id/key reveal
//     path and contradicted the documented app-wide rule that "no partial-key
//     preview is ever rendered server-side or client-side". The show/edit
//     statements no longer select license_key at all; a has_license_key flag
//     replaces it.
//
// (2) licenses.js — clear_key combined with a submitted license_key silently
//     discarded the typed key (the clear flag won) and flashed success.
//
// (3) knowledge.js — a present-but-whitespace-only tags value trimmed to ''
//     and silently WIPED the stored tags with a success flash, instead of
//     failing closed like every other optional text field in the app.
//
// (4) projects.js / changes.js / knowledge.js — the required primary columns
//     (project name, change title + type, article title/content/category)
//     were rejected when ABSENT, so a partial PUT that changed one other
//     field was refused. The app-wide contract is "absent => keep what's
//     stored".
//
// (5) auth.js — the profile route regenerated the session on every save, and
//     session.regenerate() drops every session property, so the idle/absolute
//     timeout anchors were reset. The documented hard session-lifetime cap
//     could be restarted indefinitely with a routine form post.
//
// (6) auth.js — the profile route rejected an absent first_name / last_name /
//     email even though the sibling phone field on the same route preserves
//     the stored value when the field is absent.
//
// (7) auth.js — the logout HPP guard passed an EMPTY field list to
//     rejectHppArrays(), which iterates that list, so the guard could never
//     fire: dead code that read like a fail-closed check.
//
// (8) tickets.js — the create route listed 'status' in its HPP allowlist and
//     its non-string type guard but never read it, so a submitted status was
//     silently discarded and the ticket was always created 'open'.
//
// (9) tickets.js / assets.js — the list search matched the description /
//     serial number, which are shown only on the access-gated detail pages,
//     turning the search box into a content oracle.
//
// (10) tickets.js — the capped Related-Asset dropdown query had no `id`
//     tiebreaker, so the option set could differ between two page loads.
//
// (11) staff.js — an ABSENT role in a partial PUT was rejected with "Invalid
//     Role" even though the sibling optional fields on the same form preserve
//     the stored value; and the directory handed every authenticated viewer
//     every employee's username in the render context.
//
// (12) dashboard.ejs — the warranty/license truncation markers used a
//     ">=" heuristic that claimed a truncation when the list was complete; the
//     exact counts were already in the render context.
//
// (13) seed.js — seeded tickets took updated_at from the schema default (the
//     seed moment), i.e. AFTER their own resolution timestamp, so a resolved
//     ticket read as "Updated <after> Resolved <before>".
//
// (14) reports.js — the staff performance report silently truncated its list
//     at 200 rows without disclosing it.
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
const { DASHBOARD_LIMITS } = require('../src/constants');

const ADMIN = {
  id: 1,
  username: 'cr373admin',
  password: 'SeedAdminPass1!',
  email: 'cr373admin@company.com',
  first_name: 'Robin',
  last_name: 'Auditor',
  role: 'admin'
};
const STAFF = {
  id: 2,
  username: 'cr373staff',
  password: 'SeedStaffPass1!',
  email: 'cr373staff@company.com',
  first_name: 'Sam',
  last_name: 'Worker',
  role: 'staff'
};

for (const u of [ADMIN, STAFF]) {
  db.prepare(`
    INSERT INTO users (id, username, password, email, first_name, last_name, role, department)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'IT')
  `).run(u.id, u.username, bcrypt.hashSync(u.password, 4), u.email, u.first_name, u.last_name, u.role);
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
// given cookie name wins.
function cookieHeader(setCookie) {
  const map = new Map();
  for (const cookie of (setCookie || [])) {
    const pair = cookie.split(';')[0];
    const idx = pair.indexOf('=');
    map.set(pair.slice(0, idx), pair.slice(idx + 1));
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function login(user) {
  const page = await request('GET', '/login');
  const csrf = (page.body.match(/name="_csrf" value="([^"]+)"/) || [])[1];
  const res = await request('POST', '/login', {
    cookies: cookieHeader(page.headers['set-cookie']),
    body: `username=${encodeURIComponent(user.username)}&password=${encodeURIComponent(user.password)}&_csrf=${encodeURIComponent(csrf)}`
  });
  expect(res.status).toBe(302);
  const dash = await request('GET', '/dashboard', { cookies: cookieHeader(res.headers['set-cookie']) });
  const csrfToken = (dash.body.match(/name="csrf-token" content="([^"]+)"/) || [])[1];
  return {
    cookies: cookieHeader([...(res.headers['set-cookie'] || []), ...(dash.headers['set-cookie'] || [])]),
    csrfToken
  };
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
// 1 + 2. Licenses: the secret never leaves the audited reveal path
// ---------------------------------------------------------------------------
describe('code review 373 — license key disclosure', () => {
  let admin;

  beforeAll(async () => {
    admin = await login(ADMIN);
    db.prepare(`
      INSERT INTO licenses (id, software_name, vendor, license_key, license_type, total_seats, used_seats, purchase_date, expiry_date, cost, notes)
      VALUES (901, 'MS365', 'Microsoft', 'SECRET-KEY-1234', 'subscription', 10, 3, '2024-01-01', '2099-01-01', 1000, NULL)
    `).run();
  });

  it('never renders a partial key preview on the show page', async () => {
    const res = await request('GET', '/licenses/901', { cookies: admin.cookies });
    expect(res.status).toBe(200);
    expect(res.body).toContain('****');
    // The last four characters of the key must NOT be in the response body.
    expect(res.body).not.toContain('1234');
    expect(res.body).not.toContain('SECRET-KEY');
  });

  it('the show/edit statements do not select the plaintext key', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'licenses.js'), 'utf8');
    const stmt = src.match(/const _licenseShowStmt = db\.prepare\("([^"]+)"\)/);
    expect(stmt).not.toBeNull();
    // The select list carries a computed has_license_key flag, never the
    // plaintext column itself.
    expect(stmt[1]).toContain('has_license_key');
    expect(stmt[1]).not.toMatch(/,\s*license_key\s*,/);
  });

  it('rejects setting and clearing the key at the same time', async () => {
    const res = await request('POST', '/licenses/901?_method=PUT', {
      cookies: admin.cookies,
      body: `software_name=MS365&license_key=NEWKEY-9999&clear_key=on&total_seats=10&used_seats=3&_csrf=${encodeURIComponent(admin.csrfToken)}`
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/licenses/901/edit');
    const row = db.prepare('SELECT license_key FROM licenses WHERE id = 901').get();
    // Neither half was applied: the stored key is untouched.
    expect(row.license_key).toBe('SECRET-KEY-1234');
  });
});

// ---------------------------------------------------------------------------
// 3 + 4. Knowledge base: blank tags fail closed, absent required fields preserve
// ---------------------------------------------------------------------------
describe('code review 373 — knowledge article partial-update contract', () => {
  let admin;

  beforeAll(async () => {
    admin = await login(ADMIN);
    db.prepare(`
      INSERT INTO knowledge_articles (id, title, content, category, tags, author_id, status, is_featured)
      VALUES (901, 'Original title', 'Original content', 'how_to', 'keep-me', ?, 'published', 0)
    `).run(ADMIN.id);
  });

  it('rejects a whitespace-only tags value instead of wiping the stored tags', async () => {
    const res = await request('POST', '/knowledge/901?_method=PUT', {
      cookies: admin.cookies,
      body: `title=Original title&content=Original content&category=how_to&tags=${encodeURIComponent('   ')}&_csrf=${encodeURIComponent(admin.csrfToken)}`
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/knowledge/901/edit');
    const row = db.prepare('SELECT tags FROM knowledge_articles WHERE id = 901').get();
    expect(row.tags).toBe('keep-me');
  });

  it('preserves the required columns when the request omits them', async () => {
    const res = await request('POST', '/knowledge/901?_method=PUT', {
      cookies: admin.cookies,
      body: `tags=fresh-tag&_csrf=${encodeURIComponent(admin.csrfToken)}`
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/knowledge/901');
    const row = db.prepare('SELECT title, content, category, tags FROM knowledge_articles WHERE id = 901').get();
    expect(row.title).toBe('Original title');
    expect(row.content).toBe('Original content');
    expect(row.category).toBe('how_to');
    expect(row.tags).toBe('fresh-tag');
  });
});

// ---------------------------------------------------------------------------
// 4. Projects / changes: the required primary columns preserve on absence
// ---------------------------------------------------------------------------
describe('code review 373 — project and change partial-update contract', () => {
  let admin;

  beforeAll(async () => {
    admin = await login(ADMIN);
    db.prepare(`
      INSERT INTO projects (id, name, description, status, priority, start_date, end_date, budget, spent, owner_id, progress)
      VALUES (901, 'Keep the name', 'Original description', 'planning', 'medium', '2026-01-01', '2026-12-31', 1000, 0, ?, 0)
    `).run(ADMIN.id);
    db.prepare(`
      INSERT INTO change_log (id, title, description, change_type, status, priority, assigned_to)
      VALUES (901, 'Keep the title', 'Original description', 'maintenance', 'scheduled', 'medium', ?)
    `).run(ADMIN.id);
  });

  it('preserves the project name when the request omits it', async () => {
    const res = await request('POST', '/projects/901?_method=PUT', {
      cookies: admin.cookies,
      body: `status=in_progress&_csrf=${encodeURIComponent(admin.csrfToken)}`
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/projects/901');
    const row = db.prepare('SELECT name, status FROM projects WHERE id = 901').get();
    expect(row.name).toBe('Keep the name');
    expect(row.status).toBe('in_progress');
  });

  it('preserves the change title and type when the request omits them', async () => {
    const res = await request('POST', '/changes/901?_method=PUT', {
      cookies: admin.cookies,
      body: `status=completed&_csrf=${encodeURIComponent(admin.csrfToken)}`
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/changes/901');
    const row = db.prepare('SELECT title, change_type, status FROM change_log WHERE id = 901').get();
    expect(row.title).toBe('Keep the title');
    expect(row.change_type).toBe('maintenance');
    expect(row.status).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// 5 + 6 + 7. Profile route: session anchors, partial update, HPP guard
// ---------------------------------------------------------------------------
describe('code review 373 — profile update semantics', () => {
  let staff;

  beforeAll(async () => {
    staff = await login(STAFF);
  });

  it('preserves the stored name and email when the request omits them', async () => {
    const res = await request('POST', '/profile?_method=PUT', {
      cookies: staff.cookies,
      body: `phone=555-0199&_csrf=${encodeURIComponent(staff.csrfToken)}`
    });
    expect(res.status).toBe(302);
    const row = db.prepare('SELECT first_name, last_name, email, phone FROM users WHERE id = ?').get(STAFF.id);
    expect(row.first_name).toBe('Sam');
    expect(row.last_name).toBe('Worker');
    expect(row.email).toBe(STAFF.email);
    expect(row.phone).toBe('555-0199');
  });

  it('keeps the session timeout anchors across the profile regeneration', async () => {
    // The route's session regeneration replaces the session object, so the
    // anchors must be carried across explicitly — otherwise the documented
    // absolute session-lifetime cap restarts on every profile save.
    const { lastHandlerFor } = require('./helpers');
    const authRoutes = require('../src/routes/auth');
    const handler = lastHandlerFor(authRoutes, 'put', '/profile');

    const session = {
      cookie: {},
      user: { id: STAFF.id, username: STAFF.username, role: 'staff' },
      sessionStart: 1000,
      lastAccess: 2000,
      // Mimic express-session: regenerate() installs a brand-new session
      // object that carries only the cookie.
      regenerate(cb) {
        for (const key of Object.keys(this)) {
          if (key !== 'cookie') {
            delete this[key];
          }
        }
        cb();
      }
    };
    const req = {
      method: 'PUT',
      session,
      body: { first_name: 'Sam', last_name: 'Worker', email: STAFF.email },
      query: {},
      params: {},
      ip: '127.0.0.1',
      flash: jest.fn(),
      audit: jest.fn()
    };
    const res = { redirect: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn(), render: jest.fn() };

    await handler(req, res, () => {});

    expect(session.sessionStart).toBe(1000);
    expect(session.lastAccess).toBe(2000);
  });

  it('logs the user out even when the request body carries a polluted (array-valued) field', async () => {
    // The guard used to pass an empty field list, so it could never fire.
    //
    // It was then widened to every body key — and REJECTED the request
    // before the session was destroyed, so a JSON client whose payload
    // happened to contain an array got a redirect to /login and a session
    // that was still alive: the user believed they had logged out and had
    // not. The logout handler reads no body field, so a polluted payload has
    // nothing to pollute; the logout now proceeds and the anomaly is only
    // reported.
    const { lastHandlerFor } = require('./helpers');
    const authRoutes = require('../src/routes/auth');
    const handler = lastHandlerFor(authRoutes, 'post', '/logout');

    const flashCalls = [];
    let destroyed = false;
    const res = { redirect: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn(), render: jest.fn() };
    const req = {
      method: 'POST',
      session: {
        user: { id: STAFF.id },
        regenerate: (cb) => cb(),
        destroy: (cb) => {
          destroyed = true;
          cb();
        }
      },
      body: { _csrf: ['a', 'b'] },
      query: {},
      params: {},
      ip: '127.0.0.1',
      flash: (type, msg) => flashCalls.push([type, msg]),
      audit: jest.fn()
    };

    await handler(req, res, () => {});

    expect(destroyed).toBe(true);
    expect(res.redirect).toHaveBeenCalledWith('/login');
    expect(flashCalls).not.toContainEqual(['error', 'Invalid request parameters']);
  });
});

// ---------------------------------------------------------------------------
// 8 + 9 + 10. Tickets: honoured create status, no content oracle, stable order
// ---------------------------------------------------------------------------
describe('code review 373 — ticket create status and list scoping', () => {
  let admin;
  let staff;

  beforeAll(async () => {
    admin = await login(ADMIN);
    staff = await login(STAFF);
  });

  it('applies a submitted status on create instead of discarding it', async () => {
    const res = await request('POST', '/tickets', {
      cookies: admin.cookies,
      body: `title=Created closed&description=body&category=network&priority=low&status=closed&requester_name=Req Uester&requester_email=req@example.com&_csrf=${encodeURIComponent(admin.csrfToken)}`
    });
    expect(res.status).toBe(302);
    const row = db.prepare('SELECT status, resolved_at FROM tickets WHERE title = ?').get('Created closed');
    expect(row.status).toBe('closed');
    // A ticket created in a terminal state carries a resolution timestamp,
    // exactly like the update route's resolved_at CASE expression.
    expect(row.resolved_at).toBeTruthy();
  });

  it('defaults a new ticket to open when no status is submitted', async () => {
    const res = await request('POST', '/tickets', {
      cookies: admin.cookies,
      body: `title=Created default&description=body&category=network&priority=low&requester_name=Req Uester&requester_email=req@example.com&_csrf=${encodeURIComponent(admin.csrfToken)}`
    });
    expect(res.status).toBe(302);
    const row = db.prepare('SELECT status, resolved_at FROM tickets WHERE title = ?').get('Created default');
    expect(row.status).toBe('open');
    expect(row.resolved_at).toBeNull();
  });

  it('rejects an invalid status on create instead of accepting it silently', async () => {
    const res = await request('POST', '/tickets', {
      cookies: admin.cookies,
      body: `title=Created bogus&description=body&category=network&priority=low&status=bogus&requester_name=Req Uester&requester_email=req@example.com&_csrf=${encodeURIComponent(admin.csrfToken)}`
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/tickets/new');
    const row = db.prepare('SELECT COUNT(*) as c FROM tickets WHERE title = ?').get('Created bogus');
    expect(row.c).toBe(0);
  });

  it('does not search the description, which the detail page gates', async () => {
    // A ticket assigned to the admin holds a unique phrase in its description.
    // The staff viewer cannot open the detail page, so the list search must
    // not confirm the phrase either.
    db.prepare(`
      INSERT INTO tickets (id, ticket_number, title, description, category, priority, status, requester_name, requester_email, assigned_to)
      VALUES (950, 'TK-373-950', 'Gated ticket', 'zebracode-3739-secret-phrase', 'network', 'low', 'open', 'Req Uester', 'req@example.com', ?)
    `).run(ADMIN.id);

    const denied = await request('GET', '/tickets/950', { cookies: staff.cookies });
    expect(denied.status).toBe(302);

    const list = await request('GET', '/tickets?search=zebracode-3739-secret-phrase', { cookies: staff.cookies });
    expect(list.status).toBe(200);
    expect(list.body).not.toContain('Gated ticket');
  });

  it('does not search the serial number, which the detail page gates', async () => {
    db.prepare(`
      INSERT INTO assets (id, asset_tag, name, category, manufacturer, model, serial_number, status, condition_rating, purchase_date)
      VALUES (950, 'AST-950', 'Gated asset', 'laptop', 'Apple', 'M3', 'zebra-serial-3739', 'in_use', 'good', date('now', '-400 days'))
    `).run();

    const denied = await request('GET', '/assets/950', { cookies: staff.cookies });
    expect(denied.status).toBe(302);

    const list = await request('GET', '/assets?search=zebra-serial-3739', { cookies: staff.cookies });
    expect(list.status).toBe(200);
    expect(list.body).not.toContain('Gated asset');
  });

  it('gives the capped asset dropdown a deterministic id tiebreaker', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'tickets.js'), 'utf8');
    expect(src).toMatch(/FROM assets ORDER BY name ASC, id ASC LIMIT/);
  });
});

// ---------------------------------------------------------------------------
// 11. Staff: absent role preserves, username is not handed to the directory
// ---------------------------------------------------------------------------
describe('code review 373 — staff role and directory PII', () => {
  let admin;

  beforeAll(async () => {
    admin = await login(ADMIN);
  });

  it('preserves the stored role when the request omits it', async () => {
    const res = await request('POST', '/staff/2?_method=PUT', {
      cookies: admin.cookies,
      body: `email=${encodeURIComponent(STAFF.email)}&first_name=Sam&last_name=Worker&department=Ops&_csrf=${encodeURIComponent(admin.csrfToken)}`
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/staff/2');
    const row = db.prepare('SELECT role, department FROM users WHERE id = ?').get(STAFF.id);
    expect(row.role).toBe('staff');
    expect(row.department).toBe('Ops');
  });

  it('still rejects a present but invalid role', async () => {
    const res = await request('POST', '/staff/2?_method=PUT', {
      cookies: admin.cookies,
      body: `email=${encodeURIComponent(STAFF.email)}&first_name=Sam&last_name=Worker&role=superuser&_csrf=${encodeURIComponent(admin.csrfToken)}`
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/staff/2/edit');
    const row = db.prepare('SELECT role FROM users WHERE id = ?').get(STAFF.id);
    expect(row.role).toBe('staff');
  });

  it('redacts the username of other users from the non-privileged directory', () => {
    const { lastHandlerFor } = require('./helpers');
    const staffRoutes = require('../src/routes/staff');
    const handler = lastHandlerFor(staffRoutes, 'get', '/');

    let renderArgs = null;
    const res = {
      redirect: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      render: (view, locals) => {
        renderArgs = { view, locals };
      }
    };
    const req = {
      method: 'GET',
      session: { user: { id: STAFF.id, role: 'staff' } },
      query: {},
      params: {},
      ip: '127.0.0.1',
      flash: jest.fn(),
      audit: jest.fn()
    };

    handler(req, res, () => {});

    expect(renderArgs).not.toBeNull();
    const rows = renderArgs.locals.staff;
    const other = rows.find(r => Number(r.id) === Number(ADMIN.id));
    const self = rows.find(r => Number(r.id) === Number(STAFF.id));
    // The username is the login identifier and the directory does not render
    // it — it must not be in the render context for other users either.
    expect(other.username).toBeNull();
    expect(self.username).toBe(STAFF.username);
  });
});

// ---------------------------------------------------------------------------
// 12. Dashboard: the truncation marker uses the exact count
// ---------------------------------------------------------------------------
describe('code review 373 — dashboard truncation markers', () => {
  let admin;

  beforeAll(async () => {
    admin = await login(ADMIN);
  });

  it('does not claim a truncation when the list is complete', async () => {
    // Exactly DASHBOARD_LIMITS.warrantyAlerts qualifying assets: the list is
    // complete, so the "(N+)" marker must not be rendered.
    const insert = db.prepare(`
      INSERT INTO assets (id, asset_tag, name, category, status, condition_rating, warranty_expiry, purchase_date)
      VALUES (?, ?, ?, 'laptop', 'in_use', 'good', date('now', '+10 days'), date('now', '-400 days'))
    `);
    for (let i = 0; i < DASHBOARD_LIMITS.warrantyAlerts; i++) {
      insert.run(1000 + i, `AST-37${String(i).padStart(2, '0')}`, `Warranty asset ${i}`);
    }
    // The dashboard payload is cached — drop the cached copy so the new
    // assets are part of the response.
    require('../src/routes/dashboard').invalidateDashboardCache();

    const res = await request('GET', '/dashboard', { cookies: admin.cookies });
    expect(res.status).toBe(200);
    const count = db.prepare(`
      SELECT COUNT(*) as c FROM assets
      WHERE warranty_expiry IS NOT NULL AND warranty_expiry <= date('now', '+30 days') AND status != 'disposed'
    `).get().c;
    expect(count).toBe(DASHBOARD_LIMITS.warrantyAlerts);
    // The header renders the list length; the '+' suffix marks a truncation
    // that does not exist here.
    expect(res.body).toContain(`Warranty Ending or Expired (${DASHBOARD_LIMITS.warrantyAlerts})`);
    expect(res.body).not.toContain(`Warranty Ending or Expired (${DASHBOARD_LIMITS.warrantyAlerts}+)`);
  });
});

// ---------------------------------------------------------------------------
// 13 + 14. Seed ordering and the staff report's truncation disclosure
// ---------------------------------------------------------------------------
describe('code review 373 — seed ordering and report disclosure', () => {
  it('seeds a resolved ticket with updated_at no later than its resolution', () => {
    const Database = require('better-sqlite3');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'models', 'database.js'), 'utf8');
    const schemaSQL = src.match(/db\.exec\(\s*`([\s\S]*?)`\s*\)/)[1];
    const tmp = new Database(':memory:');
    tmp.pragma('foreign_keys = ON');
    tmp.exec(schemaSQL);
    const { runSeed } = require('../src/seed');
    runSeed(tmp, 'AdminPassword123!', 'StaffPassword123!');

    const rows = tmp.prepare('SELECT ticket_number, status, created_at, updated_at, resolved_at FROM tickets').all();
    expect(rows.length).toBe(10);
    for (const row of rows) {
      // The last meaningful event: the resolution for a closed ticket, the
      // creation for an open one. Never after the resolution timestamp.
      expect(row.updated_at).toBe(row.resolved_at || row.created_at);
      if (row.resolved_at) {
        expect(row.updated_at <= row.resolved_at).toBe(true);
      }
    }
    tmp.close();
  });

  it('discloses the staff performance report row cap', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'reports.js'), 'utf8');
    expect(src).toContain('activeStaffCount');
    expect(src).toContain('staffCount');
    const view = fs.readFileSync(path.join(__dirname, '..', 'views', 'pages', 'reports', 'staff.ejs'), 'utf8');
    expect(view).toContain('of <%= staffCount %> active staff');
  });
});
