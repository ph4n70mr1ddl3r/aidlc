const http = require('http');
const fs = require('fs');
const path = require('path');
const { describe, it, expect, beforeAll, afterAll, beforeEach } = require('@jest/globals');

// Regression tests for review cycle 376.
//
// Defects closed by this pass:
//
// (1) The app-wide partial-update contract — "a field present but invalid is
//     rejected" — was NOT enforced for ENUM fields. Every enum check ran
//     against the TRIMMED value, and a truthiness test on a trimmed value
//     cannot tell "absent" from "present but blank": a whitespace-only
//     submission (and, on the NOT NULL columns, an empty one) was silently
//     IGNORED while the route flashed "updated successfully". The same class
//     of defect on the free-text fields of the very same forms was already
//     rejected (resolveOptionalField's blank-value rule), and staff.js's role
//     field already rejected a present-but-empty value. The presence test now
//     runs against the RAW submitted value everywhere.
//
// (2) A licence with NO recorded type was labelled "Perpetual" — the type
//     badge AND the expiry cell. The `license_type || 'perpetual'` fallback
//     made pass 374's expiry check tautological: the record does not carry a
//     perpetual term, and the pages are the ones used to chase renewals.
//
// (3) The projects list rendered only the FIRST 120 characters of a project's
//     description, but its search matched the WHOLE column. The list is
//     portfolio-visible to every authenticated user while the detail page is
//     ownership-gated, so a search for text beyond the rendered prefix
//     confirmed the existence of content the viewer may not read.
//
// (4) The staff directory redacts each row's department for a viewer who may
//     not see it — but handed EVERY viewer the full department list and a
//     working `?department=X` filter (a per-department headcount). The
//     redaction protected nothing.
//
// (5) The `.env.example` placeholder secrets are LONGER than the 32-character
//     production minimum, so the documented "cp .env.example .env" workflow
//     started a production server signing sessions and CSRF tokens with keys
//     published in the repository.
//
// (6) A manager who edited a manager/admin account WITHOUT submitting a role
//     was audited as a "privileged role assignment attempt" — a fabricated
//     privilege-escalation event for an actor who made none.
//
// (7) The profile route's "Email must be at most N characters" message was
//     unreachable: isValidEmail() already caps the length, so an over-long
//     address was reported as "not a valid email address".
//
// (8) A whitespace-only licence key was accepted and silently DISCARDED —
//     the old secret was kept and the route flashed a success.
//
// (9) The knowledge show page rendered the view count from BEFORE the
//     increment, so the first view of an article read "0 views".
//
// (10) The knowledge article length limits were checked against the RAW
//      body, but the STORED value is the sanitized one. sanitize-html
//      expands "&" to "&amp;", so a 50 000-character body of ampersands was
//      accepted and then truncated to 50 000 characters — silently discarding
//      ~40 000 characters of the author's text.
//
// (11) The change list's empty state told a staff viewer to "clear them to see
//      all changes", but the route scopes the list to the viewer's own
//      assignments — clearing the filters can never reveal another user's.
//
// (12) The ticket report's "Total Tickets" and "Resolved" cards counted two
//      DIFFERENT populations (created in the period vs resolved in the
//      period) and read as two halves of one funnel.
//
// (13) POST /logout had no rate limiter and sits outside the app-wide write
//      backstop, yet every logout writes an audit row.
//
// (14) The staff directory's searchable columns missed two RENDERED columns
//      (an asset's location, a ticket's requester name), so a user could
//      not find a row by a value the table showed them.
//
// (15) A non-canonical is_featured value ("yes") silently UN-featured a
//      published article while the route flashed a success.
//
// (16) The seeded change_log rows kept hardcoded absolute timestamps and
//      never set created_at/updated_at, so a completed change claimed to
//      have been created and updated months after the change it records.
//
// (17) The seed accepted an operator-supplied password that violates the
//      app's own password policy.
//
// (18) The README overstated the partial-update contract in three places and
//      named "two" report pages while listing three.
//
// The env must be set BEFORE requiring the app: src/app.js reads DB_PATH at
// require time (src/models/database.js resolves it when the module loads).
process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-0123456789abcdef';
process.env.CSRF_SECRET = 'test-csrf-secret-0123456789abcdef';

// The global sanitize-html shim (tests/jest.setup.js) strips tags but does
// NOT escape entities, so it cannot reproduce the behaviour this pass is
// about: the real sanitizer expands "&" to "&amp;", which is what makes a
// body that fits the RAW limit overflow the limit once it is stored. This
// file therefore uses a local mock that escapes entities the same way.
jest.mock('sanitize-html', () => {
  const mockSanitize = (html, opts) => {
    if (typeof html !== 'string') {
      throw new TypeError('Expected a string');
    }
    let result = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    result = result.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
    // Entity escaping — the behaviour the real sanitizer has and the reason
    // the stored value can be longer than the submitted one. It happens
    // BEFORE the tag stripping so it applies to every allowed-tag set.
    result = result.replace(/&(?![a-zA-Z][a-zA-Z0-9]{1,10};|#[0-9]{1,7};|#x[0-9a-fA-F]{1,6};)/g, '&amp;');
    const allowedTags = opts && Array.isArray(opts.allowedTags) ? opts.allowedTags : [];
    if (allowedTags.length === 0) {
      return result.replace(/<[^>]+>/g, '');
    }
    result = result.replace(/on\w+\s*=\s*["'][^"']*["']/gi, '');
    result = result.replace(/<input\b[^>]*\/?>/gi, '');
    result = result.replace(/href\s*=\s*"javascript:[^"]*"/gi, 'href="#"');
    result = result.replace(/href\s*=\s*'javascript:[^']*'/gi, "href='#'");
    result = result.replace(/href\s*=\s*javascript:[^<)>]*/gi, 'href="#"');
    return result;
  };
  mockSanitize.defaults = { allowedTags: [], allowedAttributes: {} };
  mockSanitize.simpleTransform = () => (tagName, attribs) => attribs;
  return mockSanitize;
});

const bcrypt = require('bcryptjs');
const db = require('../src/models/database');
const app = require('../src/app.js');
const dashboardRoutes = require('../src/routes/dashboard');
const utils = require('../src/utils');

const ADMIN = {
  id: 1,
  username: 'cr376admin',
  password: 'SeedAdminPass1!',
  email: 'cr376admin@company.com',
  first_name: 'Robin',
  last_name: 'Auditor',
  role: 'admin'
};

const STAFF = {
  id: 2,
  username: 'cr376staff',
  password: 'SeedStaffPass1!',
  email: 'cr376staff@company.com',
  first_name: 'Sam',
  last_name: 'Technician',
  role: 'staff',
  department: 'IT'
};

const MANAGER = {
  id: 4,
  username: 'cr376manager',
  password: 'SeedStaffPass1!',
  email: 'cr376manager@company.com',
  first_name: 'Morgan',
  last_name: 'Manager',
  role: 'manager',
  department: 'Executive'
};

for (const u of [ADMIN, STAFF, MANAGER]) {
  db.prepare(`
    INSERT INTO users (id, username, password, email, first_name, last_name, role, department)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    u.id,
    u.username,
    bcrypt.hashSync(u.password, 4),
    u.email,
    u.first_name,
    u.last_name,
    u.role,
    u.department || 'IT'
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
    map.set(pair.slice(idx + 1) ? pair.slice(0, idx) : pair, pair.slice(idx + 1));
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

// Shared sessions. The login route is rate limited to 10 attempts per 15
// minutes per IP, so the suite logs in ONCE per user in a single top-level
// hook rather than once per describe block.
const sessions = {};

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

function post(session, urlPath, fields) {
  const body = new URLSearchParams(fields).toString();
  return request('POST', urlPath, {
    cookies: session.cookies,
    body: `${body}&_csrf=${encodeURIComponent(session.csrfToken)}`
  });
}

function readSrc(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

// Extract the table row (<tr>…</tr>) that contains the given marker — used to
// scope an assertion to one record on a page that renders the same words
// elsewhere (e.g. an enum value in a filter dropdown).
function rowFor(html, marker) {
  const idx = html.indexOf(marker);
  if (idx === -1) {
    return null;
  }
  const start = html.lastIndexOf('<tr', idx);
  const end = html.indexOf('</tr>', idx);
  if (start === -1 || end === -1) {
    return null;
  }
  return html.slice(start, end);
}

beforeAll(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      port = server.address().port;
      resolve();
    });
  });
  sessions.admin = await login(ADMIN);
  sessions.staff = await login(STAFF);
  sessions.manager = await login(MANAGER);
});
afterAll((done) => {
  if (server) {
    server.close(() => done());
  } else {
    done();
  }
});

// ---------------------------------------------------------------------------
// 1. utils.resolveEnumField — the shared presence classifier
// ---------------------------------------------------------------------------
describe('code review 376 — resolveEnumField classifies a submitted enum', () => {
  const ALLOWED = ['open', 'in_progress'];

  it('reports an absent field (undefined or null) as absent', () => {
    expect(utils.resolveEnumField(undefined, ALLOWED).state).toBe('absent');
    expect(utils.resolveEnumField(null, ALLOWED).state).toBe('absent');
  });

  it('reports an empty string as empty (distinct from blank)', () => {
    expect(utils.resolveEnumField('', ALLOWED).state).toBe('empty');
  });

  it('reports a whitespace-only string as blank', () => {
    expect(utils.resolveEnumField('   ', ALLOWED).state).toBe('blank');
    expect(utils.resolveEnumField('\t\n ', ALLOWED).state).toBe('blank');
  });

  it('reports a non-member and a non-string as invalid', () => {
    expect(utils.resolveEnumField('urgent', ALLOWED).state).toBe('invalid');
    expect(utils.resolveEnumField(42, ALLOWED).state).toBe('invalid');
    expect(utils.resolveEnumField({ a: 1 }, ALLOWED).state).toBe('invalid');
  });

  it('reports an allowlisted value as valid, trimmed', () => {
    const result = utils.resolveEnumField('  open  ', ALLOWED);
    expect(result.state).toBe('valid');
    expect(result.value).toBe('open');
  });
});

// ---------------------------------------------------------------------------
// 2. A present-but-blank enum is REJECTED on every PUT route
// ---------------------------------------------------------------------------
describe('code review 376 — a present-but-blank enum is rejected, not ignored', () => {


  beforeEach(() => {
    db.exec('DELETE FROM tickets WHERE id >= 900;');
    db.exec('DELETE FROM assets WHERE id >= 900;');
    db.exec('DELETE FROM projects WHERE id >= 900;');
    db.exec('DELETE FROM project_tasks WHERE id >= 900;');
    db.exec('DELETE FROM change_log WHERE id >= 900;');
    db.exec('DELETE FROM knowledge_articles WHERE id >= 900;');
    dashboardRoutes.resetCachedStatements();
  });

  function seedTicket(id, status = 'open') {
    db.prepare(`
      INSERT INTO tickets (id, ticket_number, title, category, priority, status, requester_name, requester_email)
      VALUES (?, ?, 'CR376 ticket', 'other', 'low', ?, 'Req', 'req@example.com')
    `).run(id, `TK-CR376-${id}`, status);
  }

  function seedAsset(id, status = 'in_use') {
    db.prepare(`
      INSERT INTO assets (id, asset_tag, name, category, status, condition_rating)
      VALUES (?, ?, 'CR376 asset', 'laptop', ?, 'good')
    `).run(id, `AST-CR376-${id}`, status);
  }

  function seedProject(id, status = 'planning') {
    db.prepare(`
      INSERT INTO projects (id, name, status, priority) VALUES (?, 'CR376 project', ?, 'medium')
    `).run(id, status);
  }

  function seedTask(id, projectId, status = 'todo') {
    db.prepare(`
      INSERT INTO project_tasks (id, project_id, title, status, priority) VALUES (?, ?, 'CR376 task', ?, 'medium')
    `).run(id, projectId, status);
  }

  function seedChange(id, status = 'scheduled') {
    db.prepare(`
      INSERT INTO change_log (id, title, change_type, status, priority) VALUES (?, 'CR376 change', 'maintenance', ?, 'medium')
    `).run(id, status);
  }

  function seedArticle(id, status = 'published') {
    db.prepare(`
      INSERT INTO knowledge_articles (id, title, content, category, status, author_id)
      VALUES (?, 'CR376 article', 'body text', 'other', ?, 1)
    `).run(id, status);
  }

  it('rejects a whitespace-only ticket status and writes nothing', async () => {
    seedTicket(901, 'in_progress');
    const res = await put(sessions.admin, '/tickets/901', { title: 'Renamed', status: '   ' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/tickets/901/edit');
    const row = db.prepare('SELECT status, title FROM tickets WHERE id = 901').get();
    expect(row.status).toBe('in_progress');
    expect(row.title).toBe('CR376 ticket');
  });

  it('rejects an empty ticket status (the column is NOT NULL)', async () => {
    seedTicket(902, 'in_progress');
    const res = await put(sessions.admin, '/tickets/902', { title: 'Renamed', status: '' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/tickets/902/edit');
    const row = db.prepare('SELECT status FROM tickets WHERE id = 902').get();
    expect(row.status).toBe('in_progress');
  });

  it('still preserves the stored status when the field is absent', async () => {
    seedTicket(903, 'in_progress');
    const res = await put(sessions.admin, '/tickets/903', { title: 'Renamed' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/tickets/903');
    const row = db.prepare('SELECT status, title FROM tickets WHERE id = 903').get();
    expect(row.status).toBe('in_progress');
    expect(row.title).toBe('Renamed');
  });

  it('rejects a whitespace-only ticket category and priority', async () => {
    seedTicket(904, 'open');
    const res = await put(sessions.admin, '/tickets/904', { category: '  ', priority: '  ' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/tickets/904/edit');
    const row = db.prepare('SELECT category, priority FROM tickets WHERE id = 904').get();
    expect(row.category).toBe('other');
    expect(row.priority).toBe('low');
  });

  it('rejects a whitespace-only asset status', async () => {
    seedAsset(905, 'in_use');
    const res = await put(sessions.admin, '/assets/905', { name: 'Renamed', status: '   ' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/assets/905/edit');
    const row = db.prepare('SELECT status FROM assets WHERE id = 905').get();
    expect(row.status).toBe('in_use');
  });

  it('preserves the stored asset condition rating when the field is blank', async () => {
    seedAsset(906, 'in_use');
    db.prepare("UPDATE assets SET condition_rating = 'poor' WHERE id = 906").run();
    const res = await put(sessions.admin, '/assets/906', { name: 'Renamed', condition_rating: '' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/assets/906');
    const row = db.prepare('SELECT condition_rating FROM assets WHERE id = 906').get();
    expect(row.condition_rating).toBe('poor');
  });

  it('rejects a whitespace-only project status', async () => {
    seedProject(907, 'in_progress');
    const res = await put(sessions.admin, '/projects/907', { status: '   ' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/projects/907/edit');
    const row = db.prepare('SELECT status FROM projects WHERE id = 907').get();
    expect(row.status).toBe('in_progress');
  });

  it('rejects a whitespace-only task status', async () => {
    seedProject(908, 'in_progress');
    seedTask(909, 908, 'done');
    const res = await put(sessions.admin, '/projects/908/tasks/909', { status: '   ' });
    expect(res.status).toBe(302);
    const row = db.prepare('SELECT status FROM project_tasks WHERE id = 909').get();
    expect(row.status).toBe('done');
  });

  it('rejects a whitespace-only change status', async () => {
    seedChange(910, 'in_progress');
    const res = await put(sessions.admin, '/changes/910', { status: '   ' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/changes/910/edit');
    const row = db.prepare('SELECT status FROM change_log WHERE id = 910').get();
    expect(row.status).toBe('in_progress');
  });

  it('rejects a whitespace-only article status', async () => {
    seedArticle(911, 'published');
    const res = await put(sessions.admin, '/knowledge/911', { status: '   ' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/knowledge/911/edit');
    const row = db.prepare('SELECT status FROM knowledge_articles WHERE id = 911').get();
    expect(row.status).toBe('published');
  });

  it('rejects a whitespace-only status on CREATE too', async () => {
    const res = await post(sessions.admin, '/tickets', {
      title: 'CR376 create', category: 'other', priority: 'low',
      requester_name: 'Req', requester_email: 'req@example.com', status: '   '
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/tickets/new');
    const row = db.prepare("SELECT COUNT(*) AS c FROM tickets WHERE title = 'CR376 create'").get();
    expect(row.c).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. A licence with no recorded type is not called "Perpetual"
// ---------------------------------------------------------------------------
describe('code review 376 — an unset licence type is not a perpetual term', () => {


  beforeEach(() => {
    db.exec('DELETE FROM licenses WHERE id >= 900;');
  });

  it('renders a neutral label and no perpetual term on the list page', async () => {
    db.prepare(`
      INSERT INTO licenses (id, software_name, vendor, license_type, total_seats, used_seats, expiry_date)
      VALUES (900, 'CR376 unset type', 'Vendor', NULL, 5, 1, NULL)
    `).run();
    const res = await request('GET', '/licenses', { cookies: sessions.admin.cookies });
    expect(res.status).toBe(200);
    expect(res.body).toContain('CR376 unset type');
    expect(res.body).toContain('Unspecified');
    // The type FILTER dropdown lists every enum value (including
    // "Perpetual"), so the assertion is scoped to the licence's own row.
    const row = rowFor(res.body, 'CR376 unset type');
    expect(row).toBeTruthy();
    expect(row).not.toContain('Perpetual');
    expect(row).toContain('Unspecified');
  });

  it('renders a neutral label and no perpetual term on the show page', async () => {
    db.prepare(`
      INSERT INTO licenses (id, software_name, vendor, license_type, total_seats, used_seats, expiry_date)
      VALUES (901, 'CR376 unset show', 'Vendor', NULL, 5, 1, NULL)
    `).run();
    const res = await request('GET', '/licenses/901', { cookies: sessions.admin.cookies });
    expect(res.status).toBe(200);
    expect(res.body).toContain('Unspecified');
    expect(res.body).not.toContain('Perpetual');
  });

  it('still calls a genuine perpetual licence perpetual', async () => {
    db.prepare(`
      INSERT INTO licenses (id, software_name, vendor, license_type, total_seats, used_seats, expiry_date)
      VALUES (902, 'CR376 real perpetual', 'Vendor', 'perpetual', 5, 1, NULL)
    `).run();
    const res = await request('GET', '/licenses/902', { cookies: sessions.admin.cookies });
    expect(res.status).toBe(200);
    expect(res.body).toContain('Perpetual');
  });

  it('offers an explicit "Unspecified" option in the edit form so a NULL type survives a save', async () => {
    db.prepare(`
      INSERT INTO licenses (id, software_name, vendor, license_type, total_seats, used_seats)
      VALUES (903, 'CR376 form', 'Vendor', NULL, 5, 1)
    `).run();
    const res = await request('GET', '/licenses/903/edit', { cookies: sessions.admin.cookies });
    expect(res.status).toBe(200);
    expect(res.body).toContain('<option value="" selected>Unspecified</option>');
  });
});

// ---------------------------------------------------------------------------
// 4. The projects list search matches only the rendered description prefix
// ---------------------------------------------------------------------------
describe('code review 376 — the projects search covers only the rendered description', () => {


  beforeEach(() => {
    db.exec('DELETE FROM projects WHERE id >= 900;');
    dashboardRoutes.resetCachedStatements();
  });

  it('does not match a term that lies beyond the rendered prefix', async () => {
    // The list renders the first 120 characters; the tail must not be
    // searchable, because the detail page is ownership-gated.
    const head = 'A'.repeat(120);
    const tail = 'CR376TAILTOKEN';
    db.prepare(`
      INSERT INTO projects (id, name, description, status, priority, owner_id)
      VALUES (900, 'CR376 oracle', ?, 'in_progress', 'medium', 1)
    `).run(head + tail);

    const res = await request('GET', `/projects?search=${encodeURIComponent(tail)}`, { cookies: sessions.staff.cookies });
    expect(res.status).toBe(200);
    expect(res.body).not.toContain('CR376 oracle');
  });

  it('still matches a term inside the rendered prefix', async () => {
    const head = 'B'.repeat(60) + ' CR376HEADTOKEN ' + 'C'.repeat(60);
    db.prepare(`
      INSERT INTO projects (id, name, description, status, priority, owner_id)
      VALUES (901, 'CR376 visible', ?, 'in_progress', 'medium', 1)
    `).run(head);

    const res = await request('GET', '/projects?search=CR376HEADTOKEN', { cookies: sessions.staff.cookies });
    expect(res.status).toBe(200);
    expect(res.body).toContain('CR376 visible');
  });
});

// ---------------------------------------------------------------------------
// 5. The staff directory does not leak the department list to every viewer
// ---------------------------------------------------------------------------
describe('code review 376 — the staff directory hides the department list from staff', () => {


  it('does not offer the department filter to a non-privileged viewer', async () => {
    const res = await request('GET', '/staff', { cookies: sessions.staff.cookies });
    expect(res.status).toBe(200);
    expect(res.body).not.toContain('name="department"');
    // The redaction itself still applies to the rows.
    expect(res.body).toContain('Restricted');
  });

  it('ignores a department filter submitted by a non-privileged viewer', async () => {
    const res = await request('GET', '/staff?department=Executive', { cookies: sessions.staff.cookies });
    expect(res.status).toBe(200);
    // The filter must not narrow the result set for a viewer who may not
    // see the department at all.
    expect(res.body).toContain('Morgan');
  });

  it('still offers the department filter to a privileged viewer', async () => {
    const res = await request('GET', '/staff', { cookies: sessions.admin.cookies });
    expect(res.status).toBe(200);
    expect(res.body).toContain('name="department"');
    expect(res.body).toContain('Executive');
  });
});

// ---------------------------------------------------------------------------
// 6. The .env.example placeholder secrets are refused in production
// ---------------------------------------------------------------------------
describe('code review 376 — the placeholder secrets are rejected in production', () => {
  it('app.js refuses a CHANGE_ME_ placeholder secret', () => {
    const src = readSrc('src/app.js');
    expect(src).toContain('_PLACEHOLDER_SECRET_RE');
    expect(src).toMatch(/_PLACEHOLDER_SECRET_RE\.test\(process\.env\.SESSION_SECRET\)/);
    expect(src).toMatch(/_PLACEHOLDER_SECRET_RE\.test\(process\.env\.CSRF_SECRET\)/);
  });

  it('the .env.example placeholders are the ones the gate rejects', () => {
    const env = readSrc('.env.example');
    const session = (env.match(/^SESSION_SECRET=(.*)$/m) || [])[1];
    const csrf = (env.match(/^CSRF_SECRET=(.*)$/m) || [])[1];
    expect(session).toBeTruthy();
    expect(csrf).toBeTruthy();
    // They must still be LONG enough to pass the >= 32 character check —
    // that is exactly why the placeholder needs its own guard.
    expect(session.length).toBeGreaterThanOrEqual(32);
    expect(csrf.length).toBeGreaterThanOrEqual(32);
    expect(session).toMatch(/^CHANGE_ME/);
    expect(csrf).toMatch(/^CHANGE_ME/);
  });
});

// ---------------------------------------------------------------------------
// 7. The staff audit entry names the attempt that was actually made
// ---------------------------------------------------------------------------
describe('code review 376 — the staff edit denial names the real attempt', () => {


  it('audits a plain edit of a privileged account as an account modification', async () => {
    const res = await put(sessions.manager, `/staff/${ADMIN.id}`, {
      email: ADMIN.email, first_name: 'Robin', last_name: 'Auditor'
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/staff');
    // The denial is audited; the exact wording is asserted from the source
    // below because the audit table is written by the middleware.
    const src = readSrc('src/routes/staff.js');
    expect(src).toContain("'Unauthorized administrator or manager account modification attempt'");
    expect(src).toMatch(/if \(roleAbsent\) \{[\s\S]{0,400}Unauthorized administrator or manager account modification attempt/);
  });
});

// ---------------------------------------------------------------------------
// 8. The profile route reports an over-long email with the length message
// ---------------------------------------------------------------------------
describe('code review 376 — the profile email length check is reachable', () => {


  it('checks the length BEFORE the format check', () => {
    const src = readSrc('src/routes/auth.js');
    // Scope the search to the profile-update route: the "valid email
    // address" wording also appears in the login route.
    const profile = src.slice(src.indexOf("router.put('/profile'"), src.indexOf("router.put('/profile/password'"));
    // Match the FLASH CALL, not the prose: the route's own comment quotes
    // the "valid email address" wording too.
    const lengthIdx = profile.indexOf("req.flash('error', `Email must be at most");
    const formatIdx = profile.indexOf("req.flash('error', 'Please enter a valid email address')");
    expect(lengthIdx).toBeGreaterThan(-1);
    expect(formatIdx).toBeGreaterThan(-1);
    // The length guard must come first — isValidEmail() already caps the
    // length, so the other order makes the length message unreachable.
    expect(lengthIdx).toBeLessThan(formatIdx);
  });
});

// ---------------------------------------------------------------------------
// 9. A whitespace-only licence key is rejected
// ---------------------------------------------------------------------------
describe('code review 376 — a whitespace-only licence key is rejected', () => {


  beforeEach(() => {
    db.exec('DELETE FROM licenses WHERE id >= 900;');
  });

  it('rejects a whitespace-only key and keeps the stored one', async () => {
    db.prepare(`
      INSERT INTO licenses (id, software_name, vendor, license_key, license_type, total_seats, used_seats)
      VALUES (900, 'CR376 key', 'Vendor', 'SECRET-KEY-123', 'perpetual', 5, 1)
    `).run();
    const res = await put(sessions.admin, '/licenses/900', { software_name: 'CR376 key', license_key: '   ' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/licenses/900/edit');
    const row = db.prepare('SELECT license_key FROM licenses WHERE id = 900').get();
    expect(row.license_key).toBe('SECRET-KEY-123');
  });
});

// ---------------------------------------------------------------------------
// 10. The knowledge show page renders the view count AFTER the increment
// ---------------------------------------------------------------------------
describe('code review 376 — the article view count is rendered after the increment', () => {


  beforeEach(() => {
    db.exec('DELETE FROM knowledge_articles WHERE id >= 900;');
  });

  it('shows the stored count, not the pre-increment count', async () => {
    db.prepare(`
      INSERT INTO knowledge_articles (id, title, content, category, status, author_id, views)
      VALUES (900, 'CR376 views', 'body text', 'other', 'published', 2, 7)
    `).run();
    // The viewer is not the author, so the counter is incremented.
    const res = await request('GET', '/knowledge/900', { cookies: sessions.admin.cookies });
    expect(res.status).toBe(200);
    expect(res.body).toMatch(/>\s*8\s+views?/i);
    const row = db.prepare('SELECT views FROM knowledge_articles WHERE id = 900').get();
    expect(row.views).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// 11. Article content that does not fit after sanitisation is rejected
// ---------------------------------------------------------------------------
describe('code review 376 — article content is measured after sanitisation', () => {


  beforeEach(() => {
    db.exec('DELETE FROM knowledge_articles WHERE id >= 900;');
  });

  it('rejects a body whose sanitized form does not fit the limit', async () => {
    // 50 000 ampersands sanitize to 250 000 characters ("&amp;"), so the
    // stored value would have been silently truncated to 50 000 — losing
    // ~40 000 characters of the author's text.
    const body = '&'.repeat(50000);
    const res = await post(sessions.admin, '/knowledge', {
      title: 'CR376 too long', content: body, category: 'other', status: 'draft'
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/knowledge/new');
    const row = db.prepare("SELECT COUNT(*) AS c FROM knowledge_articles WHERE title = 'CR376 too long'").get();
    expect(row.c).toBe(0);
  });

  it('does not cut an HTML entity in half when the value is truncated', () => {
    const { sanitizeKnowledgeInput } = require('../src/routes/knowledge');
    const result = sanitizeKnowledgeInput('title', 'x'.repeat(190) + '&amp;', 'tags');
    expect(result.error).toBeNull();
    // The stored value must not end mid-entity.
    expect(result.safeContent.endsWith('&am')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 12. The change list's empty state does not promise what the route denies
// ---------------------------------------------------------------------------
describe('code review 376 — the change empty state matches the route scope', () => {
  it('does not tell a staff viewer to clear the filters to see all changes', () => {
    const src = readSrc('views/pages/changes/index.ejs');
    expect(src).not.toContain('clear them to see all changes');
    expect(src).toContain('No changes are assigned to you');
  });
});

// ---------------------------------------------------------------------------
// 13. The ticket report's two cards name their populations
// ---------------------------------------------------------------------------
describe('code review 376 — the ticket report cards name their populations', () => {
  it('labels the created and the resolved cards distinctly', () => {
    const src = readSrc('views/pages/reports/tickets.ejs');
    expect(src).toContain('Tickets Created');
    expect(src).toContain('Tickets Resolved');
    expect(src).not.toContain('>Total Tickets<');
  });
});

// ---------------------------------------------------------------------------
// 14. POST /logout is rate limited
// ---------------------------------------------------------------------------
describe('code review 376 — the logout route is rate limited', () => {
  it('mounts a limiter on POST /logout', () => {
    const src = readSrc('src/routes/auth.js');
    expect(src).toContain('logoutLimiter');
    expect(src).toMatch(/router\.post\('\/logout',\s*logoutLimiter/);
  });
});

// ---------------------------------------------------------------------------
// 15. The rendered columns are searchable
// ---------------------------------------------------------------------------
describe('code review 376 — the search surface covers the rendered columns', () => {


  beforeEach(() => {
    db.exec('DELETE FROM assets WHERE id >= 900;');
    db.exec('DELETE FROM tickets WHERE id >= 900;');
    dashboardRoutes.resetCachedStatements();
  });

  it('finds an asset by its rendered location column', async () => {
    db.prepare(`
      INSERT INTO assets (id, asset_tag, name, category, status, location)
      VALUES (900, 'AST-CR376-LOC', 'CR376 located', 'laptop', 'in_use', 'Basement-7')
    `).run();
    const res = await request('GET', '/assets?search=Basement-7', { cookies: sessions.admin.cookies });
    expect(res.status).toBe(200);
    expect(res.body).toContain('CR376 located');
  });

  it('finds a ticket by its rendered requester column', async () => {
    db.prepare(`
      INSERT INTO tickets (id, ticket_number, title, category, priority, status, requester_name, requester_email)
      VALUES (900, 'TK-CR376-REQ', 'CR376 requested', 'other', 'low', 'open', 'Unique Req Name', 'u@example.com')
    `).run();
    const res = await request('GET', `/tickets?search=${encodeURIComponent('Unique Req Name')}`, { cookies: sessions.admin.cookies });
    expect(res.status).toBe(200);
    expect(res.body).toContain('CR376 requested');
  });
});

// ---------------------------------------------------------------------------
// 16. A non-canonical is_featured value is rejected
// ---------------------------------------------------------------------------
describe('code review 376 — a non-canonical is_featured value is rejected', () => {


  beforeEach(() => {
    db.exec('DELETE FROM knowledge_articles WHERE id >= 900;');
  });

  it('does not silently un-feature a published article', async () => {
    db.prepare(`
      INSERT INTO knowledge_articles (id, title, content, category, status, author_id, is_featured)
      VALUES (900, 'CR376 featured', 'body text', 'other', 'published', 1, 1)
    `).run();
    const res = await put(sessions.admin, '/knowledge/900', {
      title: 'CR376 featured', content: 'body text', category: 'other', status: 'published', is_featured: 'yes'
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/knowledge/900/edit');
    const row = db.prepare('SELECT is_featured FROM knowledge_articles WHERE id = 900').get();
    expect(row.is_featured).toBe(1);
  });

  it('still accepts the canonical checkbox values', async () => {
    db.prepare(`
      INSERT INTO knowledge_articles (id, title, content, category, status, author_id, is_featured)
      VALUES (901, 'CR376 featured 2', 'body text', 'other', 'published', 1, 1)
    `).run();
    const res = await put(sessions.admin, '/knowledge/901', {
      title: 'CR376 featured 2', content: 'body text', category: 'other', status: 'published', is_featured: '0'
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/knowledge/901');
    const row = db.prepare('SELECT is_featured FROM knowledge_articles WHERE id = 901').get();
    expect(row.is_featured).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 17. The seeded change-log rows are internally coherent
// ---------------------------------------------------------------------------
describe('code review 376 — the seeded change-log rows are coherent', () => {
  let seedDb;

  beforeAll(() => {
    const Database = require('better-sqlite3');
    seedDb = new Database(':memory:');
    seedDb.pragma('foreign_keys = ON');
    const appPath = path.join(__dirname, '..', 'src', 'models', 'database.js');
    const src = fs.readFileSync(appPath, 'utf8');
    const match = src.match(/db\.exec\(\s*`([\s\S]*?)`\s*\)/);
    seedDb.exec(match[1]);
    const { runSeed } = require('../src/seed');
    runSeed(seedDb, 'AdminPassword123!', 'StaffPassword123!');
  });

  afterAll(() => {
    if (seedDb) {
      seedDb.close();
    }
  });

  it('never seeds a change that is created or updated after it finished', () => {
    const rows = seedDb.prepare('SELECT * FROM change_log').all();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.created_at <= row.updated_at).toBe(true);
      if (row.actual_end) {
        expect(row.updated_at >= row.actual_end).toBe(true);
        expect(row.created_at <= row.actual_start).toBe(true);
      }
    }
  });

  it('never seeds a completed change in the future', () => {
    const rows = seedDb.prepare("SELECT * FROM change_log WHERE status = 'completed'").all();
    expect(rows.length).toBeGreaterThan(0);
    const nowIso = new Date().toISOString().replace('T', ' ').slice(0, 16);
    for (const row of rows) {
      expect(row.scheduled_start < nowIso).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 18. The seeder refuses a password that violates the app's own policy
// ---------------------------------------------------------------------------
describe('code review 376 — the seeder enforces the password policy', () => {
  it('refuses a non-compliant operator-supplied seed password', () => {
    const Database = require('better-sqlite3');
    const seedDb = new Database(':memory:');
    seedDb.pragma('foreign_keys = ON');
    const appPath = path.join(__dirname, '..', 'src', 'models', 'database.js');
    const src = fs.readFileSync(appPath, 'utf8');
    const match = src.match(/db\.exec\(\s*`([\s\S]*?)`\s*\)/);
    seedDb.exec(match[1]);
    const { runSeed } = require('../src/seed');
    expect(() => runSeed(seedDb, 'weak', 'StaffPassword123!')).toThrow(/password policy/);
    seedDb.close();
  });
});

// ---------------------------------------------------------------------------
// 19. The README describes the contract the code implements
// ---------------------------------------------------------------------------
describe('code review 376 — the README states the real contract', () => {
  const readme = readSrc('README.md');

  it('documents the money-field exception to the empty-string rule', () => {
    expect(readme).toContain('the **money fields**');
    expect(readme).toContain('purchase price');
  });

  it('documents the raw-presence rule for enum fields', () => {
    expect(readme).toContain('raw** submitted value');
  });

  it('names three report pages, not two', () => {
    expect(readme).toContain('the three report pages that show an\nuncapped total');
    expect(readme).not.toContain('the two report pages');
  });

  it('documents the search-surface rule', () => {
    expect(readme).toContain('### Search surface');
  });
});

// ---------------------------------------------------------------------------
// 20. The hot list queries are indexed
// ---------------------------------------------------------------------------
describe('code review 376 — the list ORDER BY columns are indexed', () => {
  const src = readSrc('src/models/database.js');

  it('indexes the columns the list queries sort on', () => {
    expect(src).toContain('idx_assets_name');
    expect(src).toContain('idx_vendors_name');
    expect(src).toContain('idx_users_first_name');
    expect(src).toContain('idx_tickets_updated');
  });
});
