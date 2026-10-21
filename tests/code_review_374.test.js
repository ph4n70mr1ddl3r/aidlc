const http = require('http');
const { describe, it, expect, beforeAll, afterAll } = require('@jest/globals');

// Regression tests for review cycle 374.
//
// Defects closed by this pass:
//
// (1) The app-wide partial-update (PUT) contract — "a field absent from the
//     request preserves the stored value" — was implemented for the OPTIONAL
//     fields of every PUT route, but the REQUIRED primary columns still
//     rejected a partial submission outright:
//
//       PUT /tickets/:id          → "Title is required"
//       PUT /assets/:id           → "Asset tag, name, and category are required"
//       PUT /vendors/:id          → "Vendor name is required"
//       PUT /licenses/:id         → "Software name is required"
//       PUT /staff/:id            → "Email, first name, and last name are required"
//       PUT /projects/:p/tasks/:t → "Task title is required"
//
//     The sibling required columns (a project's name, a change's title/type,
//     an article's title/content/category, a ticket's requester name) had
//     already been made absent-preserving, and the README documents the
//     contract as app-wide. A client that PATCHed a single field had to
//     resend the whole entity. All six routes now resolve the required
//     columns from the transaction-consistent row when the field is absent,
//     and still reject a present-but-empty value (nothing is written).
//
// (2) The "(N+)" truncation markers claimed a truncation that did not exist.
//     The marker compared the rendered length against the cap with `>=`, so a
//     list that happened to hold exactly as many rows as the cap — i.e. a
//     COMPLETE list — was still marked as truncated. The 373rd pass had
//     already fixed the two dashboard lists that had an exact count
//     available; the remaining twelve markers used the heuristic. Every
//     capped list now fetches one row beyond its cap (the truncation probe)
//     and the marker is driven by that exact flag.
//
// (3) A partial knowledge-article update audited the article as
//     `Updated article ""` — the submitted (absent) title, not the stored
//     one. The same class of defect was fixed for the asset, vendor, licence
//     and staff audit details in this pass.
//
// (4) A licence with a missing expiry date rendered "Perpetual" whatever its
//     type: a subscription whose renewal date was simply not recorded claimed
//     a perpetual term on the very page used to chase renewals.
//
// (5) The dashboard's warranty/licence alert cards were headed "Expiring
//     Soon" while the count they report INCLUDES already-expired records
//     (the same page's list cards are correctly headed "Ending or Expired").
//
// (6) The assets/projects/changes empty states invited every viewer to
//     "Add your first …" record, although only an admin/manager can create
//     one (the list routes are open to all staff).
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
const { DASHBOARD_LIMITS, COMMENT_LIST_CAP, ASSIGNED_ITEMS_CAP } = require('../src/constants');

const ADMIN = {
  id: 1,
  username: 'cr374admin',
  password: 'SeedAdminPass1!',
  email: 'cr374admin@company.com',
  first_name: 'Robin',
  last_name: 'Auditor',
  role: 'admin'
};

const STAFF = {
  id: 2,
  username: 'cr374staff',
  password: 'SeedStaffPass1!',
  email: 'cr374staff@company.com',
  first_name: 'Sam',
  last_name: 'Technician',
  role: 'staff'
};

// A dedicated user for the dashboard cap test, so the number of tickets
// assigned to the viewer is fully under the test's control.
const DASH = {
  id: 3,
  username: 'cr374dash',
  password: 'SeedStaffPass1!',
  email: 'cr374dash@company.com',
  first_name: 'Dana',
  last_name: 'Dashboard',
  role: 'staff'
};

for (const u of [ADMIN, STAFF, DASH]) {
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

// PUT via the method-override channel every EJS form uses.
function put(session, urlPath, fields) {
  const body = new URLSearchParams(fields).toString();
  return request('POST', `${urlPath}?_method=PUT`, {
    cookies: session.cookies,
    body: `${body}&_csrf=${encodeURIComponent(session.csrfToken)}`
  });
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
// 1. The required primary columns are absent-preserving
// ---------------------------------------------------------------------------
describe('code review 374 — required columns preserve the stored value when absent', () => {
  let admin;

  beforeAll(async () => {
    admin = await login(ADMIN);

    db.prepare(`
      INSERT INTO tickets (id, ticket_number, title, description, category, priority, status, requester_name, requester_email, assigned_to)
      VALUES (901, 'TK-CR374-001', 'Stored ticket title', 'desc', 'hardware', 'medium', 'open', 'Req', 'req@example.com', ?)
    `).run(ADMIN.id);

    db.prepare(`
      INSERT INTO assets (id, asset_tag, name, category, status, condition_rating, assigned_to)
      VALUES (901, 'AST-901', 'Stored asset name', 'laptop', 'in_storage', 'good', NULL)
    `).run();

    db.prepare(`
      INSERT INTO vendors (id, name, contact_person, category, is_active)
      VALUES (901, 'Stored Vendor', 'Old Contact', 'hardware', 1)
    `).run();

    db.prepare(`
      INSERT INTO licenses (id, software_name, vendor, license_type, total_seats, used_seats, cost)
      VALUES (901, 'Stored Suite', 'Vendor', 'subscription', 10, 2, 500)
    `).run();

    db.prepare(`
      INSERT INTO projects (id, name, description, status, priority, budget, spent, owner_id)
      VALUES (901, 'Stored Project', 'desc', 'in_progress', 'medium', 0, 0, ?)
    `).run(ADMIN.id);

    db.prepare(`
      INSERT INTO project_tasks (id, project_id, title, description, status, priority)
      VALUES (901, 901, 'Stored task title', 'desc', 'todo', 'medium')
    `).run();
  });

  it('preserves the stored ticket title when the field is absent', async () => {
    const res = await put(admin, '/tickets/901', { priority: 'low' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/tickets/901');
    const row = db.prepare('SELECT title, priority FROM tickets WHERE id = 901').get();
    expect(row.title).toBe('Stored ticket title');
    expect(row.priority).toBe('low');
  });

  it('rejects a present-but-empty ticket title and writes nothing', async () => {
    const res = await put(admin, '/tickets/901', { title: '', priority: 'critical' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/tickets/901/edit');
    const row = db.prepare('SELECT title, priority FROM tickets WHERE id = 901').get();
    // Nothing was written — not the title, and not the sibling field either.
    expect(row.title).toBe('Stored ticket title');
    expect(row.priority).toBe('low');
  });

  it('preserves the stored asset tag, name and category when the fields are absent', async () => {
    const res = await put(admin, '/assets/901', { status: 'in_repair' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/assets/901');
    const row = db.prepare('SELECT asset_tag, name, category, status FROM assets WHERE id = 901').get();
    expect(row.asset_tag).toBe('AST-901');
    expect(row.name).toBe('Stored asset name');
    expect(row.category).toBe('laptop');
    expect(row.status).toBe('in_repair');
  });

  it('rejects a present-but-empty asset name and writes nothing', async () => {
    const res = await put(admin, '/assets/901', { name: '', status: 'in_use' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/assets/901/edit');
    const row = db.prepare('SELECT name, status FROM assets WHERE id = 901').get();
    expect(row.name).toBe('Stored asset name');
    expect(row.status).toBe('in_repair');
  });

  it('preserves the stored vendor name when the field is absent', async () => {
    const res = await put(admin, '/vendors/901', { contact_person: 'New Contact' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/vendors/901');
    const row = db.prepare('SELECT name, contact_person FROM vendors WHERE id = 901').get();
    expect(row.name).toBe('Stored Vendor');
    expect(row.contact_person).toBe('New Contact');
  });

  it('rejects a present-but-empty vendor name and writes nothing', async () => {
    const res = await put(admin, '/vendors/901', { name: '', contact_person: 'Third Contact' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/vendors/901/edit');
    const row = db.prepare('SELECT name, contact_person FROM vendors WHERE id = 901').get();
    expect(row.name).toBe('Stored Vendor');
    expect(row.contact_person).toBe('New Contact');
  });

  it('preserves the stored software name when the field is absent', async () => {
    const res = await put(admin, '/licenses/901', { cost: '750' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/licenses/901');
    const row = db.prepare('SELECT software_name, cost FROM licenses WHERE id = 901').get();
    expect(row.software_name).toBe('Stored Suite');
    expect(row.cost).toBe(750);
  });

  it('rejects a present-but-empty software name and writes nothing', async () => {
    const res = await put(admin, '/licenses/901', { software_name: '', cost: '900' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/licenses/901/edit');
    const row = db.prepare('SELECT software_name, cost FROM licenses WHERE id = 901').get();
    expect(row.software_name).toBe('Stored Suite');
    expect(row.cost).toBe(750);
  });

  it('preserves the stored email and name when the fields are absent', async () => {
    const res = await put(admin, `/staff/${STAFF.id}`, { department: 'Support' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/staff/${STAFF.id}`);
    const row = db.prepare('SELECT email, first_name, last_name, department FROM users WHERE id = ?').get(STAFF.id);
    expect(row.email).toBe(STAFF.email);
    expect(row.first_name).toBe('Sam');
    expect(row.last_name).toBe('Technician');
    expect(row.department).toBe('Support');
  });

  it('rejects a present-but-empty staff email and writes nothing', async () => {
    const res = await put(admin, `/staff/${STAFF.id}`, { email: '', department: 'Finance' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/staff/${STAFF.id}/edit`);
    const row = db.prepare('SELECT email, department FROM users WHERE id = ?').get(STAFF.id);
    expect(row.email).toBe(STAFF.email);
    expect(row.department).toBe('Support');
  });

  it('preserves the stored task title when the field is absent', async () => {
    const res = await put(admin, '/projects/901/tasks/901', { status: 'in_progress' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/projects/901');
    const row = db.prepare('SELECT title, status FROM project_tasks WHERE id = 901').get();
    expect(row.title).toBe('Stored task title');
    expect(row.status).toBe('in_progress');
  });

  it('rejects a present-but-empty task title and writes nothing', async () => {
    const res = await put(admin, '/projects/901/tasks/901', { title: '', status: 'done' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/projects/901');
    const row = db.prepare('SELECT title, status FROM project_tasks WHERE id = 901').get();
    expect(row.title).toBe('Stored task title');
    expect(row.status).toBe('in_progress');
  });
});

// ---------------------------------------------------------------------------
// 2. The audit trail names the EFFECTIVE entity on a partial update
// ---------------------------------------------------------------------------
describe('code review 374 — audit details name the effective entity', () => {
  let admin;

  beforeAll(async () => {
    admin = await login(ADMIN);
    db.prepare(`
      INSERT INTO knowledge_articles (id, title, content, category, tags, author_id, status, is_featured)
      VALUES (902, 'Stored article title', 'content', 'how_to', 'keep', ?, 'published', 0)
    `).run(ADMIN.id);
  });

  it('audits the stored article title when the title field is absent', async () => {
    const res = await put(admin, '/knowledge/902', { tags: 'fresh' });
    expect(res.status).toBe(302);
    const row = db.prepare(`
      SELECT details FROM audit_log
      WHERE entity_type = 'knowledge_article' AND entity_id = 902 AND action = 'update'
      ORDER BY id DESC LIMIT 1
    `).get();
    expect(row).toBeDefined();
    expect(row.details).toBe('Updated article "Stored article title"');
    // The regression: the submitted (absent) title was audited as "".
    expect(row.details).not.toContain('""');
  });

  it('audits the stored asset tag when the tag field is absent', async () => {
    const res = await put(admin, '/assets/901', { status: 'in_use' });
    expect(res.status).toBe(302);
    const row = db.prepare(`
      SELECT details FROM audit_log
      WHERE entity_type = 'asset' AND entity_id = 901 AND action = 'update'
      ORDER BY id DESC LIMIT 1
    `).get();
    expect(row).toBeDefined();
    expect(row.details).toBe('Updated asset AST-901');
  });

  it('audits the stored licence name when the name field is absent', async () => {
    const res = await put(admin, '/licenses/901', { cost: '800' });
    expect(res.status).toBe(302);
    const row = db.prepare(`
      SELECT details FROM audit_log
      WHERE entity_type = 'license' AND entity_id = 901 AND action = 'update'
      ORDER BY id DESC LIMIT 1
    `).get();
    expect(row).toBeDefined();
    expect(row.details).toBe('Updated license for Stored Suite');
  });
});

// ---------------------------------------------------------------------------
// 3. The "(N+)" markers are exact
// ---------------------------------------------------------------------------
describe('code review 374 — truncation markers are exact', () => {
  let admin;
  let dash;

  beforeAll(async () => {
    admin = await login(ADMIN);
    dash = await login(DASH);
  });

  it('does not mark a complete dashboard ticket list as truncated', async () => {
    const insert = db.prepare(`
      INSERT INTO tickets (ticket_number, title, category, priority, status, requester_name, requester_email, assigned_to)
      VALUES (?, ?, 'other', 'low', 'open', 'Req', 'req@example.com', ?)
    `);
    for (let i = 0; i < DASHBOARD_LIMITS.myTickets; i++) {
      insert.run(`TK-CR374-DASH-${i}`, `CR374 dash ticket ${i}`, DASH.id);
    }
    dashboardRoutes.resetCachedStatements();

    const res = await request('GET', '/dashboard', { cookies: dash.cookies });
    expect(res.status).toBe(200);
    // The list holds exactly as many rows as the cap — it is COMPLETE, so no
    // truncation may be claimed.
    expect(res.body).toContain(`My Active Tickets (${DASHBOARD_LIMITS.myTickets})`);
    expect(res.body).not.toContain(`My Active Tickets (${DASHBOARD_LIMITS.myTickets}+)`);
  });

  it('marks a dashboard ticket list as truncated once a row is dropped', async () => {
    db.prepare(`
      INSERT INTO tickets (ticket_number, title, category, priority, status, requester_name, requester_email, assigned_to)
      VALUES ('TK-CR374-DASH-OVER', 'CR374 dash ticket overflow', 'other', 'low', 'open', 'Req', 'req@example.com', ?)
    `).run(DASH.id);
    dashboardRoutes.resetCachedStatements();

    const res = await request('GET', '/dashboard', { cookies: dash.cookies });
    expect(res.status).toBe(200);
    expect(res.body).toContain(`My Active Tickets (${DASHBOARD_LIMITS.myTickets}+)`);
  });

  it('does not mark a complete related-ticket list as truncated', async () => {
    db.prepare(`
      INSERT INTO assets (id, asset_tag, name, category, status, condition_rating)
      VALUES (902, 'AST-902', 'Cap asset', 'laptop', 'in_storage', 'good')
    `).run();
    const insert = db.prepare(`
      INSERT INTO tickets (id, ticket_number, title, category, priority, status, requester_name, requester_email, asset_id)
      VALUES (?, ?, ?, 'other', 'low', 'open', 'Req', 'req@example.com', 902)
    `);
    for (let i = 0; i < ASSIGNED_ITEMS_CAP; i++) {
      insert.run(1000 + i, `TK-CR374-REL-${i}`, `CR374 related ${i}`);
    }

    const res = await request('GET', '/assets/902', { cookies: admin.cookies });
    expect(res.status).toBe(200);
    expect(res.body).toContain(`Related Tickets (${ASSIGNED_ITEMS_CAP})`);
    expect(res.body).not.toContain(`Related Tickets (${ASSIGNED_ITEMS_CAP}+)`);
  });

  it('marks a related-ticket list as truncated once a row is dropped', async () => {
    db.prepare(`
      INSERT INTO tickets (id, ticket_number, title, category, priority, status, requester_name, requester_email, asset_id)
      VALUES (1099, 'TK-CR374-REL-OVER', 'CR374 related overflow', 'other', 'low', 'open', 'Req', 'req@example.com', 902)
    `).run();

    const res = await request('GET', '/assets/902', { cookies: admin.cookies });
    expect(res.status).toBe(200);
    expect(res.body).toContain(`Related Tickets (${ASSIGNED_ITEMS_CAP}+)`);
  });

  it('does not mark a complete comment list as truncated', async () => {
    db.prepare(`
      INSERT INTO tickets (id, ticket_number, title, category, priority, status, requester_name, requester_email)
      VALUES (950, 'TK-CR374-CMT', 'Comment cap ticket', 'other', 'low', 'open', 'Req', 'req@example.com')
    `).run();
    const insert = db.prepare(`
      INSERT INTO ticket_comments (ticket_id, user_id, comment, is_internal) VALUES (950, ?, 'c', 0)
    `);
    db.transaction(() => {
      for (let i = 0; i < COMMENT_LIST_CAP; i++) {
        insert.run(ADMIN.id);
      }
    })();

    const res = await request('GET', '/tickets/950', { cookies: admin.cookies });
    expect(res.status).toBe(200);
    expect(res.body).toContain(`Comments (${COMMENT_LIST_CAP})`);
    expect(res.body).not.toContain(`Comments (${COMMENT_LIST_CAP}+)`);
  });

  it('marks a comment list as truncated once a row is dropped', async () => {
    db.prepare(`
      INSERT INTO ticket_comments (ticket_id, user_id, comment, is_internal) VALUES (950, ?, 'overflow', 0)
    `).run(ADMIN.id);

    const res = await request('GET', '/tickets/950', { cookies: admin.cookies });
    expect(res.status).toBe(200);
    expect(res.body).toContain(`Comments (${COMMENT_LIST_CAP}+)`);
  });
});

// ---------------------------------------------------------------------------
// 4. + 5. Licence expiry label and the dashboard alert headings
// ---------------------------------------------------------------------------
describe('code review 374 — licence expiry label and alert headings', () => {
  let admin;

  beforeAll(async () => {
    admin = await login(ADMIN);
  });

  it('does not call a subscription without an expiry date "Perpetual"', async () => {
    db.prepare(`
      INSERT INTO licenses (id, software_name, vendor, license_type, total_seats, used_seats, expiry_date)
      VALUES (903, 'CR374 Subscription', 'Vendor', 'subscription', 10, 1, NULL)
    `).run();
    const res = await request('GET', '/licenses/903', { cookies: admin.cookies });
    expect(res.status).toBe(200);
    expect(res.body).toContain('Subscription');
    // The expiry date is simply not recorded — the record does not claim a
    // perpetual term.
    expect(res.body).not.toContain('Perpetual');
  });

  it('still calls a perpetual licence without an expiry date "Perpetual"', async () => {
    db.prepare(`
      INSERT INTO licenses (id, software_name, vendor, license_type, total_seats, used_seats, expiry_date)
      VALUES (904, 'CR374 Perpetual', 'Vendor', 'perpetual', 10, 1, NULL)
    `).run();
    const res = await request('GET', '/licenses/904', { cookies: admin.cookies });
    expect(res.status).toBe(200);
    expect(res.body).toContain('Perpetual');
  });

  it('heads the dashboard alert cards with the expired-inclusive wording', async () => {
    db.prepare(`
      INSERT INTO assets (id, asset_tag, name, category, status, condition_rating, warranty_expiry, purchase_date)
      VALUES (903, 'AST-903', 'CR374 expired warranty asset', 'laptop', 'in_use', 'good', date('now', '-5 days'), date('now', '-400 days'))
    `).run();
    db.prepare(`
      INSERT INTO licenses (id, software_name, vendor, license_type, total_seats, used_seats, expiry_date)
      VALUES (905, 'CR374 expired licence', 'Vendor', 'subscription', 10, 1, date('now', '-5 days'))
    `).run();
    dashboardRoutes.resetCachedStatements();

    const res = await request('GET', '/dashboard', { cookies: admin.cookies });
    expect(res.status).toBe(200);
    // The counts include already-expired records, so the headings must not
    // say "Expiring Soon" — the list cards on the same page already use the
    // accurate wording.
    expect(res.body).toContain('Warranty Ending or Expired');
    expect(res.body).toContain('Licenses Ending or Expired');
    expect(res.body).not.toContain('Warranty Expiring Soon');
    expect(res.body).not.toContain('License Expiring Soon');
  });
});

// ---------------------------------------------------------------------------
// 6. The empty states do not invite a viewer to create a record they cannot
// ---------------------------------------------------------------------------
describe('code review 374 — empty-state copy matches what the viewer can do', () => {
  let admin;
  let staff;

  beforeAll(async () => {
    admin = await login(ADMIN);
    staff = await login(STAFF);
  });

  it('offers the create hint to a privileged viewer', async () => {
    const res = await request('GET', '/assets?search=cr374-no-such-asset', { cookies: admin.cookies });
    expect(res.status).toBe(200);
    expect(res.body).toContain('No assets found');
    expect(res.body).toContain('Add your first asset or adjust filters');
  });

  it('does not offer the create hint to a viewer who cannot create records', async () => {
    const res = await request('GET', '/assets?search=cr374-no-such-asset', { cookies: staff.cookies });
    expect(res.status).toBe(200);
    expect(res.body).toContain('No assets found');
    expect(res.body).not.toContain('Add your first asset');
    expect(res.body).toContain('Adjust filters or clear them to see all assets');
  });

  it('does not offer the project/changes create hints to a staff viewer', async () => {
    const projects = await request('GET', '/projects?search=cr374-no-such-project', { cookies: staff.cookies });
    expect(projects.status).toBe(200);
    expect(projects.body).not.toContain('Create your first project');

    const changes = await request('GET', '/changes?search=cr374-no-such-change', { cookies: staff.cookies });
    expect(changes.status).toBe(200);
    expect(changes.body).not.toContain('Add your first change');
  });
});
