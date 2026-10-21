const http = require('http');
const fs = require('fs');
const path = require('path');
const { describe, it, expect, beforeAll, afterAll, beforeEach } = require('@jest/globals');

// Regression tests for review cycle 377.
//
// Defects closed by this pass:
//
// (1) EVERY list page's pagination links pointed at the application root.
//     paginationBaseUrl() built the base from req.path, and Express rewrites
//     req.url to the mount-RELATIVE remainder inside a mounted router — so
//     inside app.use('/audit', auditRoutes) req.path is "/" and the rendered
//     "page 2" link was "/?page=2". Clicking it bounced the user to the
//     dashboard, so page 2+ of every list in the app was unreachable through
//     the UI.
//
// (2) The ticket-show comment cap was applied BEFORE the internal-comment
//     filter, so internal notes — which a non-privileged viewer may not even
//     read — consumed the viewer's whole 500-row budget. A ticket with 505
//     internal notes and 5 public comments rendered "Comments (0+)" for the
//     assigned staff member and the public comments were unreachable.
//
// (3) The CREATE routes accepted a present-but-EMPTY enum on the NOT NULL
//     enum columns (POST /assets status="", POST /tickets status="", …) and
//     silently took the default, while the matching UPDATE route rejected the
//     very same submission.
//
// (4) Article titles and tags were stored HTML-escaped but rendered escaped
//     AGAIN, so "&" was displayed as "&amp;" — and a search for the title the
//     user could see matched nothing. The title/tags length limits were also
//     measured on the entity-expanded text, so a title within the form's
//     maxlength was rejected with a message about the body's 50 000-character
//     limit.
//
// (5) The dashboard's "Upcoming Changes" widget compared a LOCAL wall-clock
//     timestamp (the value a datetime-local input produces) against SQLite's
//     UTC clock, so in a non-UTC deployment every change scheduled within the
//     next hours was dropped from the widget.
//
// (6) Deactivating a staff member released their tickets, tasks, changes and
//     project ownership — but NOT their project membership. The leaver stayed
//     on the project Team roster, and the "cannot remove the last lead"
//     guard then refused to clean the project up.
//
// (7) The assets list renders the manufacturer and the name in ONE cell
//     ("Dell OptiPlex 7090") but searched the two columns separately, so the
//     text the user could see was unfindable.
//
// Plus the smaller defects: the new-asset form silently defaulted the
// Category to "Laptop"; the staff CREATE route's email-length message was
// unreachable (isValidEmail caps the length first) while the UPDATE route
// reported the same condition differently; the staff directory exposed the
// username to a manager who cannot read it anywhere; the 413 and CSRF
// responses shipped without the documented no-store policy; the create
// routes' type guards omitted the required columns (a JSON number was
// reported as a missing field); an over-long asset tag was reported as a
// format error; the assets list's Condition column, the projects list's
// Owner column and the knowledge list's Author column were rendered but not
// searchable; app.js carried a stale comment about a constant that no longer
// exists; and the logout HPP guard silently cancelled the logout.

// The env must be set BEFORE requiring the app: src/app.js reads DB_PATH at
// require time (src/models/database.js resolves it when the module loads).
process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-0123456789abcdef';
process.env.CSRF_SECRET = 'test-csrf-secret-0123456789abcdef';

// The global sanitize-html shim (tests/jest.setup.js) strips tags but does
// NOT escape entities, so it cannot reproduce the behaviour this pass is
// about: the real sanitizer expands "&" to "&amp;", which is what made the
// stored title differ from the title the user typed. This file therefore
// uses a local mock that escapes entities the same way.
jest.mock('sanitize-html', () => {
  const mockSanitize = (html, opts) => {
    if (typeof html !== 'string') {
      throw new TypeError('Expected a string');
    }
    let result = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^>]*)*<\/script>/gi, '');
    result = result.replace(/<style\b[^<]*(?:(?!<\/style>)<[^>]*)*<\/style>/gi, '');
    // Entity escaping — the behaviour the real sanitizer has and the reason
    // the stored title can be longer than the submitted one.
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
const utils = require('../src/utils');

const ADMIN = {
  id: 1,
  // The username is deliberately NOT a substring of the email or the name:
  // a search for it must match the username column and nothing else.
  username: 'cr377loginname',
  password: 'SeedAdminPass1!',
  email: 'cr377admin@company.com',
  first_name: 'Robin',
  last_name: 'Auditor',
  role: 'admin'
};

const STAFF = {
  id: 2,
  username: 'cr377staff',
  password: 'SeedStaffPass1!',
  email: 'cr377staff@company.com',
  first_name: 'Sam',
  last_name: 'Technician',
  role: 'staff',
  department: 'IT'
};

const MANAGER = {
  id: 3,
  username: 'cr377manager',
  password: 'SeedStaffPass1!',
  email: 'cr377manager@company.com',
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

function request(method, urlPath, { cookies = '', body = null, headers = {}, json = false } = {}) {
  return new Promise((resolve, reject) => {
    const reqHeaders = { ...headers };
    if (cookies) {
      reqHeaders.Cookie = cookies;
    }
    if (body !== null) {
      if (!json) {
        reqHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
      }
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

function del(session, urlPath) {
  return request('POST', `${urlPath}?_method=DELETE`, {
    cookies: session.cookies,
    body: `_csrf=${encodeURIComponent(session.csrfToken)}`
  });
}

function readSrc(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

// Number of table rows in the rendered list body. A list with no rows renders
// an empty state instead of a table, which counts as zero rows.
function rowCount(html) {
  const m = html.match(/<tbody>[\s\S]*?<\/tbody>/);
  if (!m) {
    return 0;
  }
  return (m[0].match(/<tr/g) || []).length;
}

// The flash messages rendered on a page.
function flashes(html) {
  const re = /<div class="flash [^"]*"[^>]*>([\s\S]*?)<\/div>/g;
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    out.push(m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
  }
  return out;
}

// A monotonically increasing counter so every inserted fixture row gets a
// unique key (the ticket number and the asset tag are UNIQUE columns).
let seq = 0;
function nextSeq() {
  seq += 1;
  return seq;
}

// The hrefs of the rendered pagination links.
function paginationHrefs(html) {
  return [...html.matchAll(/href="([^"]*page=\d+[^"]*)"/g)].map((m) => m[1]);
}

beforeAll(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      port = server.address().port;
      resolve();
    });
  });
  // A project for the task-create assertions below.
  db.prepare(`
    INSERT INTO projects (name, description, status, priority, start_date, end_date, owner_id)
    VALUES ('CR377 task host project', 'd', 'in_progress', 'high', '2026-01-01', '2026-12-31', ?)
  `).run(ADMIN.id);
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
// 1. The pagination base URL is the FULL request path
// ---------------------------------------------------------------------------
describe('code review 377 — pagination links point at the list, not at the app root', () => {
  it('requestPath resolves the mount-relative path back to the full path', () => {
    // Inside app.use('/audit', auditRoutes) Express rewrites req.url, so the
    // route handler sees path "/" and baseUrl "/audit".
    expect(utils.requestPath({ path: '/', baseUrl: '/audit' })).toBe('/audit');
    expect(utils.requestPath({ path: '/', baseUrl: '/tickets' })).toBe('/tickets');
    // The root-mounted auth router has no baseUrl.
    expect(utils.requestPath({ path: '/login', baseUrl: '' })).toBe('/login');
    // A synthetic request with neither falls back to req.path.
    expect(utils.requestPath({ path: '/tickets' })).toBe('/tickets');
    // The original URL wins when present (it carries the mount prefix).
    expect(utils.requestPath({ path: '/', baseUrl: '/audit', originalUrl: '/audit?page=2&search=x' })).toBe('/audit');
    expect(utils.requestPath({ path: '/', baseUrl: '', originalUrl: '/?page=2' })).toBe('/');
  });

  it('paginationBaseUrl keeps the list path and the other query parameters', () => {
    expect(utils.paginationBaseUrl({ path: '/', baseUrl: '/audit', query: { page: '2' } })).toBe('/audit');
    expect(utils.paginationBaseUrl({ path: '/', baseUrl: '/tickets', query: { search: 'laptop' } })).toBe('/tickets?search=laptop');
  });

  it('renders a "page 2" link that stays on the list', async () => {
    // Enough tickets for two pages (the default page size is 25).
    const insert = db.prepare(`
      INSERT INTO tickets (ticket_number, title, description, category, priority, status, requester_name, requester_email)
      VALUES (?, ?, ?, 'other', 'low', 'open', 'Requester', 'r@company.com')
    `);
    for (let i = 1; i <= 30; i++) {
      insert.run(`TK-CR377-${String(i).padStart(3, '0')}`, `Pagination ticket ${i}`, 'body');
    }
    const res = await request('GET', '/tickets', { cookies: sessions.admin.cookies });
    expect(res.status).toBe(200);
    const hrefs = paginationHrefs(res.body);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(href.startsWith('/tickets?page=')).toBe(true);
      expect(href.startsWith('/?page=')).toBe(false);
    }
    // The link really resolves to the second page of the list.
    const page2 = await request('GET', '/tickets?page=2', { cookies: sessions.admin.cookies });
    expect(page2.status).toBe(200);
    expect(page2.body).toContain('Showing 26');
  });

  it('renders correct pagination links on every list route', async () => {
    const lists = ['/tickets', '/assets', '/projects', '/staff', '/vendors', '/licenses', '/knowledge', '/changes', '/audit'];
    for (const listPath of lists) {
      const res = await request('GET', listPath, { cookies: sessions.admin.cookies });
      expect(res.status).toBe(200);
      for (const href of paginationHrefs(res.body)) {
        expect(href).not.toMatch(/^\/\?page=/);
        expect(href.startsWith(`${listPath}?`)).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The comment cap counts the comments the viewer may see
// ---------------------------------------------------------------------------
describe('code review 377 — the ticket comment cap counts visible comments', () => {
  let ticketId;

  beforeEach(() => {
    const insert = db.prepare(`
      INSERT INTO tickets (ticket_number, title, description, category, priority, status, requester_name, requester_email, assigned_to)
      VALUES (?, ?, 'body', 'other', 'low', 'open', 'Requester', 'r@company.com', ?)
    `);
    const res = insert.run(`TK-CR377-COMMENTS-${nextSeq()}`, 'Comment cap ticket', STAFF.id);
    ticketId = res.lastInsertRowid;
    const comment = db.prepare(
      'INSERT INTO ticket_comments (ticket_id, user_id, comment, is_internal) VALUES (?, ?, ?, ?)'
    );
    // The public comments are the OLDEST — the internal notes pushed them out
    // of the newest-N window when the cap was applied before the filter.
    for (let i = 0; i < 5; i++) {
      comment.run(ticketId, ADMIN.id, `public comment ${i}`, 0);
    }
    for (let i = 0; i < 505; i++) {
      comment.run(ticketId, ADMIN.id, `internal note ${i}`, 1);
    }
  });

  it('shows the public comments to the assigned staff member', async () => {
    const res = await request('GET', `/tickets/${ticketId}`, { cookies: sessions.staff.cookies });
    expect(res.status).toBe(200);
    expect(res.body).toContain('public comment 0');
    expect(res.body).not.toContain('internal note 0');
    // The marker describes the list on screen: five visible comments, none
    // dropped by the cap, so no "+".
    expect(res.body).toContain('Comments (5)');
    expect(res.body).not.toContain('Comments (5+)');
    expect(res.body).not.toContain('Comments (0+)');
  });

  it('still shows the internal notes to a privileged viewer', async () => {
    const res = await request('GET', `/tickets/${ticketId}`, { cookies: sessions.admin.cookies });
    expect(res.status).toBe(200);
    // The newest 500 internal notes are the ones the cap keeps.
    expect(res.body).toContain('internal note 504');
    expect(res.body).toContain('Comments (500+)');
  });
});

// ---------------------------------------------------------------------------
// 3. A present-but-empty enum is rejected on the create routes
// ---------------------------------------------------------------------------
describe('code review 377 — the create routes reject a present-but-empty enum', () => {
  it('rejects an empty status on POST /assets', async () => {
    const before = db.prepare('SELECT COUNT(*) AS c FROM assets').get().c;
    const res = await post(sessions.admin, '/assets', { name: 'CR377 empty status', category: 'laptop', status: '' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/assets/new');
    expect(db.prepare('SELECT COUNT(*) AS c FROM assets').get().c).toBe(before);
    const page = await request('GET', '/assets/new', { cookies: sessions.admin.cookies });
    expect(flashes(page.body)).toContain('Invalid Status');
  });

  it('rejects an empty status on POST /tickets', async () => {
    const before = db.prepare('SELECT COUNT(*) AS c FROM tickets').get().c;
    const res = await post(sessions.admin, '/tickets', {
      title: 'CR377 empty status', category: 'other', requester_name: 'R', requester_email: 'r@company.com', status: ''
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/tickets/new');
    expect(db.prepare('SELECT COUNT(*) AS c FROM tickets').get().c).toBe(before);
  });

  it('rejects an empty status on POST /knowledge', async () => {
    const before = db.prepare('SELECT COUNT(*) AS c FROM knowledge_articles').get().c;
    const res = await post(sessions.admin, '/knowledge', {
      title: 'CR377 empty status', content: 'body', category: 'other', status: ''
    });
    expect(res.status).toBe(302);
    expect(db.prepare('SELECT COUNT(*) AS c FROM knowledge_articles').get().c).toBe(before);
  });

  it('rejects an empty status on POST /changes', async () => {
    const before = db.prepare('SELECT COUNT(*) AS c FROM change_log').get().c;
    const res = await post(sessions.admin, '/changes', {
      title: 'CR377 empty status', change_type: 'maintenance', status: ''
    });
    expect(res.status).toBe(302);
    expect(db.prepare('SELECT COUNT(*) AS c FROM change_log').get().c).toBe(before);
  });

  it('rejects an empty status on POST /projects/:id/tasks', async () => {
    const project = db.prepare("SELECT id FROM projects WHERE name LIKE 'CR377 %' LIMIT 1").get();
    const before = db.prepare('SELECT COUNT(*) AS c FROM project_tasks').get().c;
    const res = await post(sessions.admin, `/projects/${project.id}/tasks`, { title: 'CR377 empty status', status: '' });
    expect(res.status).toBe(302);
    expect(db.prepare('SELECT COUNT(*) AS c FROM project_tasks').get().c).toBe(before);
  });

  it('still defaults an ABSENT status', async () => {
    const res = await post(sessions.admin, '/assets', { name: 'CR377 absent status', category: 'laptop' });
    expect(res.status).toBe(302);
    expect(res.headers.location).not.toBe('/assets/new');
    const row = db.prepare("SELECT status FROM assets WHERE name = 'CR377 absent status'").get();
    expect(row.status).toBe('in_storage');
  });
});

// ---------------------------------------------------------------------------
// 4. Article titles and tags are stored as plain text
// ---------------------------------------------------------------------------
describe('code review 377 — article titles and tags are stored as plain text', () => {
  it('stores the title and the tags unescaped', () => {
    const { sanitizeKnowledgeInput } = require('../src/routes/knowledge');
    const result = sanitizeKnowledgeInput('R&D "Guide"', 'Body & text', 'ops&tools');
    expect(result.error).toBeNull();
    expect(result.safeTitle).toBe('R&D "Guide"');
    expect(result.safeTags).toBe('ops&tools');
    // The CONTENT is rendered as HTML, so it keeps the entity-escaped form.
    expect(result.safeContent).toBe('Body &amp; text');
  });

  it('renders the title and the tags without double escaping', async () => {
    const res = await post(sessions.admin, '/knowledge', {
      title: 'R&D "Guide"', content: 'Body & text', category: 'other', status: 'draft', tags: 'ops&tools'
    });
    expect(res.status).toBe(302);
    const id = res.headers.location.split('/').pop();
    const row = db.prepare('SELECT title, tags, content FROM knowledge_articles WHERE id = ?').get(id);
    expect(row.title).toBe('R&D "Guide"');
    expect(row.tags).toBe('ops&tools');
    expect(row.content).toBe('Body &amp; text');

    const show = await request('GET', `/knowledge/${id}`, { cookies: sessions.admin.cookies });
    // The rendered HTML escapes the stored plain text exactly once: the
    // browser shows "R&D", not "R&amp;D".
    expect(show.body).toContain('R&amp;D');
    expect(show.body).not.toContain('R&amp;amp;D');
    expect(show.body).toContain('ops&amp;tools');
    expect(show.body).not.toContain('ops&amp;amp;tools');
  });

  it('finds the article by the title the user can see', async () => {
    const res = await request('GET', '/knowledge?search=' + encodeURIComponent('R&D "Guide"'), { cookies: sessions.admin.cookies });
    expect(res.status).toBe(200);
    expect(rowCount(res.body)).toBe(1);
  });

  it('accepts a title within the form limit that contains an ampersand', async () => {
    const title = `R&D ${'x'.repeat(195)}`;
    expect(title.length).toBe(199);
    const before = db.prepare('SELECT COUNT(*) AS c FROM knowledge_articles').get().c;
    const res = await post(sessions.admin, '/knowledge', {
      title, content: 'body', category: 'other', status: 'draft'
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).not.toBe('/knowledge/new');
    expect(db.prepare('SELECT COUNT(*) AS c FROM knowledge_articles').get().c).toBe(before + 1);
  });

  it('names the field and the limit that actually apply', () => {
    const { _truncationMessage } = require('../src/routes/knowledge');
    expect(_truncationMessage('content')).toContain('Content');
    expect(_truncationMessage('content')).toContain('50000');
    expect(_truncationMessage('title')).toContain('Title');
    expect(_truncationMessage('title')).toContain('200');
    expect(_truncationMessage('tags')).toContain('Tags');
    expect(_truncationMessage('tags')).toContain('500');
  });

  it('decodeHtmlEntities decodes in a single pass', () => {
    expect(utils.decodeHtmlEntities('R&amp;D')).toBe('R&D');
    expect(utils.decodeHtmlEntities('&lt;b&gt;')).toBe('<b>');
    expect(utils.decodeHtmlEntities('&quot;x&quot;')).toBe('"x"');
    expect(utils.decodeHtmlEntities('&#39;x&#39;')).toBe("'x'");
    expect(utils.decodeHtmlEntities('&#x41;')).toBe('A');
    // The author's own "&amp;" survives as the literal text "&amp;".
    expect(utils.decodeHtmlEntities('R&amp;amp;D')).toBe('R&amp;D');
    // An unknown entity is left verbatim rather than dropped.
    expect(utils.decodeHtmlEntities('&nope;')).toBe('&nope;');
    expect(utils.decodeHtmlEntities('plain')).toBe('plain');
    expect(utils.decodeHtmlEntities(null)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 5. "Upcoming Changes" compares against the local wall clock
// ---------------------------------------------------------------------------
describe('code review 377 — the dashboard compares scheduled changes against the local clock', () => {
  function localStamp(offsetMs) {
    const d = new Date(Date.now() + offsetMs);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  it('lists a change scheduled in the near future and omits one already started', async () => {
    const insert = db.prepare(
      "INSERT INTO change_log (title, change_type, status, scheduled_start) VALUES (?, 'maintenance', 'scheduled', ?)"
    );
    insert.run('CR377 future change', localStamp(2 * 3600 * 1000));
    insert.run('CR377 past change', localStamp(-2 * 3600 * 1000));

    const res = await request('GET', '/dashboard', { cookies: sessions.admin.cookies });
    expect(res.status).toBe(200);
    expect(res.body).toContain('CR377 future change');
    expect(res.body).not.toContain('CR377 past change');
  });

  it('uses the local time modifier in the query', () => {
    const src = readSrc('src/routes/dashboard.js');
    expect(src).toMatch(/strftime\('%Y-%m-%d %H:%M', 'now', 'localtime'\)/);
  });
});

// ---------------------------------------------------------------------------
// 6. Deactivating a user releases their project memberships
// ---------------------------------------------------------------------------
describe('code review 377 — deactivation releases project memberships', () => {
  // A throwaway account per test: deactivating one of the shared session
  // users would invalidate the session the later tests rely on.
  function makeTempStaff() {
    const n = nextSeq();
    const id = db.prepare(`
      INSERT INTO users (username, password, email, first_name, last_name, role, department)
      VALUES (?, 'x', ?, 'Temp', ?, 'staff', 'IT')
    `).run(`cr377temp${n}`, `cr377temp${n}@company.com`, `Temp${n}`).lastInsertRowid;
    return id;
  }

  it('removes the membership on a live project and keeps it on a finished one', async () => {
    const temp = makeTempStaff();
    const project = db.prepare(`
      INSERT INTO projects (name, description, status, priority, start_date, end_date, owner_id)
      VALUES ('CR377 live project', 'd', 'in_progress', 'high', '2026-01-01', '2026-12-31', ?)
    `).run(temp).lastInsertRowid;
    const done = db.prepare(`
      INSERT INTO projects (name, description, status, priority, start_date, end_date, owner_id)
      VALUES ('CR377 done project', 'd', 'completed', 'high', '2026-01-01', '2026-02-01', ?)
    `).run(temp).lastInsertRowid;
    db.prepare("INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'lead')").run(project, temp);
    db.prepare("INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'lead')").run(done, temp);

    const res = await del(sessions.admin, `/staff/${temp}`);
    expect(res.status).toBe(302);
    expect(db.prepare('SELECT COUNT(*) AS c FROM project_members WHERE project_id = ?').get(project).c).toBe(0);
    // A finished project keeps its historical team (the same rule the
    // ownership unassign follows).
    expect(db.prepare('SELECT COUNT(*) AS c FROM project_members WHERE project_id = ?').get(done).c).toBe(1);
  });

  it('lets the project be cleaned up after the leaver was the only lead', async () => {
    const temp = makeTempStaff();
    const project = db.prepare(`
      INSERT INTO projects (name, description, status, priority, start_date, end_date, owner_id)
      VALUES ('CR377 lead project', 'd', 'in_progress', 'high', '2026-01-01', '2026-12-31', ?)
    `).run(temp).lastInsertRowid;
    const member = db.prepare("INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'lead')")
      .run(project, temp).lastInsertRowid;

    const res = await del(sessions.admin, `/staff/${temp}`);
    expect(res.status).toBe(302);
    expect(db.prepare('SELECT COUNT(*) AS c FROM project_members WHERE id = ?').get(member).c).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 7. The assets list's rendered cell is findable
// ---------------------------------------------------------------------------
describe('code review 377 — the assets list searches what it renders', () => {
  beforeEach(() => {
    // Only one fixture asset at a time, so a search matches exactly one row.
    db.prepare("DELETE FROM assets WHERE asset_tag LIKE 'AST-CR377-%'").run();
    db.prepare(`
      INSERT INTO assets (asset_tag, name, category, manufacturer, model, status, condition_rating, location)
      VALUES (?, 'OptiPlex 7090', 'desktop', 'Dell', '7090 SFF', 'in_use', 'poor', 'HQ Office')
    `).run(`AST-CR377-${nextSeq()}`);
  });

  it('finds the asset by the manufacturer and the name together', async () => {
    const res = await request('GET', '/assets?search=' + encodeURIComponent('Dell OptiPlex'), { cookies: sessions.admin.cookies });
    expect(res.status).toBe(200);
    expect(rowCount(res.body)).toBe(1);
    expect(res.body).toContain('AST-CR377');
  });

  it('still finds the asset by either half', async () => {
    for (const term of ['Dell', 'OptiPlex']) {
      const res = await request('GET', '/assets?search=' + encodeURIComponent(term), { cookies: sessions.admin.cookies });
      expect(rowCount(res.body)).toBe(1);
    }
  });

  it('finds the asset by its rendered condition', async () => {
    const res = await request('GET', '/assets?search=' + encodeURIComponent('poor'), { cookies: sessions.admin.cookies });
    expect(res.status).toBe(200);
    expect(rowCount(res.body)).toBe(1);
  });

  it('supports a concatenated search column in addSearch', () => {
    const where = [];
    const params = [];
    utils.addSearch(where, params, 'Dell OptiPlex', [{ concat: ['a.manufacturer', 'a.name'] }]);
    expect(where.length).toBe(1);
    expect(where[0]).toContain('COALESCE("a"."manufacturer", \'\')');
    expect(where[0]).toContain('"a"."name"');
    expect(params).toEqual(['%Dell OptiPlex%']);
  });

  it('rejects an invalid column inside a concat list', () => {
    expect(() => utils.addSearch([], [], 'x', [{ concat: ['a.name); DROP TABLE assets--'] }])).toThrow(/Invalid column name/);
  });
});

// ---------------------------------------------------------------------------
// 8. The new-asset form does not default the category
// ---------------------------------------------------------------------------
describe('code review 377 — the new-asset form offers a category placeholder', () => {
  it('renders a "Select category" placeholder option', async () => {
    const res = await request('GET', '/assets/new', { cookies: sessions.admin.cookies });
    expect(res.status).toBe(200);
    const select = (res.body.match(/<select name="category"[\s\S]*?<\/select>/) || [''])[0];
    expect(select).toContain('<option value="">Select category</option>');
  });

  it('rejects an empty category on create', async () => {
    const before = db.prepare('SELECT COUNT(*) AS c FROM assets').get().c;
    const res = await post(sessions.admin, '/assets', { name: 'CR377 no category', category: '' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/assets/new');
    expect(db.prepare('SELECT COUNT(*) AS c FROM assets').get().c).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 9. The staff create route reports the email length
// ---------------------------------------------------------------------------
describe('code review 377 — the staff create route reports the email length', () => {
  it('reports the length instead of "not a valid email"', async () => {
    const email = `${'a'.repeat(210)}@company.com`;
    const res = await post(sessions.admin, '/staff', {
      username: `cr377long${Date.now()}`, email, first_name: 'Long', last_name: 'Email', password: 'SeedAdminPass1!'
    });
    expect(res.status).toBe(302);
    const page = await request('GET', '/staff/new', { cookies: sessions.admin.cookies });
    expect(flashes(page.body)).toContain('Email must be at most 200 characters');
    expect(flashes(page.body)).not.toContain('Please enter a valid email address');
  });
});

// ---------------------------------------------------------------------------
// 10. The username is searchable for an admin only
// ---------------------------------------------------------------------------
describe('code review 377 — the staff directory exposes the username to an admin only', () => {
  it('lets an admin find a row by its username', async () => {
    const res = await request('GET', '/staff?search=' + encodeURIComponent('cr377loginname'), { cookies: sessions.admin.cookies });
    expect(res.status).toBe(200);
    expect(rowCount(res.body)).toBe(1);
  });

  it('does not let a manager find a row by its username', async () => {
    const res = await request('GET', '/staff?search=' + encodeURIComponent('cr377loginname'), { cookies: sessions.manager.cookies });
    expect(res.status).toBe(200);
    expect(rowCount(res.body)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 11. The error responses carry the no-store policy
// ---------------------------------------------------------------------------
describe('code review 377 — the error responses carry the no-store policy', () => {
  it('sends no-store on a 413 payload-too-large response', async () => {
    const res = await request('POST', '/login', {
      cookies: '',
      body: `x=${'y'.repeat(2 * 1024 * 1024)}`
    });
    expect(res.status).toBe(413);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.headers.pragma).toBe('no-cache');
  });

  it('sends no-store on a rejected CSRF token', async () => {
    const res = await request('POST', '/login', {
      cookies: '',
      body: 'username=x&password=y&_csrf=bogus'
    });
    // A JSON client (no Accept header) gets the JSON error; a browser gets
    // the redirect. Both must carry the policy.
    expect([302, 403]).toContain(res.status);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.headers.pragma).toBe('no-cache');
  });
});

// ---------------------------------------------------------------------------
// 12. The create routes' type guards cover the required columns
// ---------------------------------------------------------------------------
describe('code review 377 — the create routes reject a non-string required field', () => {
  it('reports a JSON number in an asset name as an invalid parameter', async () => {
    const before = db.prepare('SELECT COUNT(*) AS c FROM assets').get().c;
    const res = await request('POST', '/assets', {
      cookies: sessions.admin.cookies,
      json: true,
      body: JSON.stringify({ name: 123, category: 'laptop' }),
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': sessions.admin.csrfToken }
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/assets/new');
    expect(db.prepare('SELECT COUNT(*) AS c FROM assets').get().c).toBe(before);
    const page = await request('GET', '/assets/new', { cookies: sessions.admin.cookies });
    expect(flashes(page.body)).toContain('Invalid request parameters');
  });

  it('reports a JSON number in a ticket title as an invalid parameter', async () => {
    const before = db.prepare('SELECT COUNT(*) AS c FROM tickets').get().c;
    const res = await request('POST', '/tickets', {
      cookies: sessions.admin.cookies,
      json: true,
      body: JSON.stringify({ title: 123, category: 'other', requester_name: 'R', requester_email: 'r@company.com' }),
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': sessions.admin.csrfToken }
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/tickets/new');
    expect(db.prepare('SELECT COUNT(*) AS c FROM tickets').get().c).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 13. An over-long asset tag reports the length
// ---------------------------------------------------------------------------
describe('code review 377 — the asset tag length is reported as a length', () => {
  it('names the length limit for an over-long (but well-formed) tag', async () => {
    const asset = db.prepare("SELECT id FROM assets WHERE asset_tag LIKE 'AST-CR377-%' ORDER BY id DESC LIMIT 1").get();
    const res = await put(sessions.admin, `/assets/${asset.id}`, { asset_tag: `AST-${'9'.repeat(47)}` });
    expect(res.status).toBe(302);
    const page = await request('GET', `/assets/${asset.id}/edit`, { cookies: sessions.admin.cookies });
    expect(flashes(page.body)).toContain('Asset tag must be at most 50 characters');
  });

  it('names the format for a malformed tag', async () => {
    const asset = db.prepare("SELECT id FROM assets WHERE asset_tag LIKE 'AST-CR377-%' ORDER BY id DESC LIMIT 1").get();
    const res = await put(sessions.admin, `/assets/${asset.id}`, { asset_tag: 'not-a-tag' });
    expect(res.status).toBe(302);
    const page = await request('GET', `/assets/${asset.id}/edit`, { cookies: sessions.admin.cookies });
    expect(flashes(page.body)).toContain('Asset tag must match format AST-XXX (e.g. AST-001)');
  });
});

// ---------------------------------------------------------------------------
// 14. The rendered owner / author names are searchable
// ---------------------------------------------------------------------------
describe('code review 377 — the rendered owner and author names are searchable', () => {
  it('finds a project by its owner', async () => {
    const project = db.prepare(`
      INSERT INTO projects (name, description, status, priority, start_date, end_date, owner_id)
      VALUES ('CR377 owned project', 'd', 'in_progress', 'high', '2026-01-01', '2026-12-31', ?)
    `).run(ADMIN.id).lastInsertRowid;
    const res = await request('GET', '/projects?search=' + encodeURIComponent('Robin'), { cookies: sessions.admin.cookies });
    expect(res.status).toBe(200);
    expect(res.body).toContain('CR377 owned project');
    expect(project).toBeTruthy();
  });

  it('finds an article by its author', async () => {
    const res = await request('GET', '/knowledge?search=' + encodeURIComponent('Auditor'), { cookies: sessions.admin.cookies });
    expect(res.status).toBe(200);
    expect(rowCount(res.body)).toBeGreaterThan(0);
  });

  it('accepts an optional join clause on the count query', () => {
    expect(() => utils.countQuery({}, 'projects', 'p', '1=1', [], 'SELECT 1')).toThrow(/Invalid join clause/);
    expect(() => utils.countQuery({}, 'projects', 'p', '1=1', [], 'LEFT JOIN users u ON p.owner_id = u.id')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 15. The logout is not cancelled by a polluted body
// ---------------------------------------------------------------------------
describe('code review 377 — a polluted logout body does not keep the session alive', () => {
  it('destroys the session even when the body carries an array', async () => {
    const n = nextSeq();
    const username = `cr377logout${n}`;
    db.prepare(`
      INSERT INTO users (username, password, email, first_name, last_name, role, department)
      VALUES (?, ?, ?, 'Logout', 'Tester', 'admin', 'IT')
    `).run(username, bcrypt.hashSync('SeedAdminPass1!', 4), `${username}@company.com`);

    const session = await login({
      username,
      password: 'SeedAdminPass1!',
      email: `${username}@company.com`,
      first_name: 'Logout',
      last_name: 'Tester',
      role: 'admin'
    });
    const res = await request('POST', '/logout', {
      cookies: session.cookies,
      json: true,
      body: JSON.stringify({ foo: ['a'] }),
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken }
    });
    expect(res.status).toBe(302);
    const after = await request('GET', '/dashboard', { cookies: session.cookies });
    expect(after.status).toBe(302);
    expect(after.headers.location).toContain('/login');
    // The anomaly is recorded in the audit trail (a flash could not survive
    // the session destroy).
    const row = db.prepare("SELECT details FROM audit_log WHERE action = 'logout' ORDER BY id DESC LIMIT 1").get();
    expect(row.details).toContain('array-valued field');
  });
});

// ---------------------------------------------------------------------------
// 16. The stale app.js comment is gone
// ---------------------------------------------------------------------------
describe('code review 377 — the app.js NODE_ENV comment matches the code', () => {
  it('does not claim that constants.js evaluates a secure flag at require time', () => {
    const src = readSrc('src/app.js');
    expect(src).not.toMatch(/constants\.js which\s*\n?\s*\* evaluates SESSION_COOKIE_OPTIONS\.secure/);
    expect(readSrc('src/constants.js')).toMatch(/`secure` is deliberately NOT part of this constant/);
  });
});
