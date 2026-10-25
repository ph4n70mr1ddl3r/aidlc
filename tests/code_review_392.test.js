process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-0123456789abcdef';
process.env.CSRF_SECRET = 'test-csrf-secret-0123456789abcdef';
// Fresh in-memory database per run so this suite is fully isolated from the
// file-backed database other suites share (src/models/database.js resolves
// DB_PATH at require time, so this must be set before requiring the app).
process.env.DB_PATH = ':memory:';

const http = require('http');
const { describe, it, expect, beforeAll, afterAll } = require('@jest/globals');
const bcrypt = require('bcryptjs');
const db = require('../src/models/database');
const app = require('../src/app.js');
const dashboardRoutes = require('../src/routes/dashboard');

// Distinctive ids/ticket numbers so this suite never collides with other
// test files that share the single file-backed database.
const ADMIN_USER = {
  id: 9011,
  username: 'cr392admin',
  password: 'SeedAdminPass1!',
  email: 'cr392admin@company.com',
  first_name: 'Robin',
  last_name: 'Auditor',
  role: 'admin'
};
const STAFF_USER = {
  id: 9012,
  username: 'cr392staff',
  password: 'SeedStaffPass1!',
  email: 'cr392staff@company.com',
  first_name: 'Sam',
  last_name: 'Technician',
  role: 'staff'
};

for (const u of [ADMIN_USER, STAFF_USER]) {
  db.prepare(`
    INSERT OR IGNORE INTO users (id, username, password, email, first_name, last_name, role, department)
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

describe('code review 392 — dashboard viewer-scoped ticket aggregations', () => {
  let adminSession;
  let staffSession;

  beforeAll(async () => {
    // Idempotent: seed two open tickets — one assigned to staff, one to admin
    // (a colleague's ticket). INSERT OR IGNORE makes re-runs safe against the
    // shared file-backed database.
    const insertTicket = db.prepare(`
      INSERT OR IGNORE INTO tickets (ticket_number, title, category, priority, status, requester_name, requester_email, assigned_to)
      VALUES (?, ?, 'other', 'low', 'open', 'Req', 'req@example.com', ?)
    `);
    insertTicket.run('TK-392-STAFF', 'CR392 staff ticket', STAFF_USER.id);
    insertTicket.run('TK-392-ADMIN', 'CR392 admin ticket', ADMIN_USER.id);
    // Make sure the shared TTL cache is refreshed so the seeded rows are seen.
    dashboardRoutes.resetCachedStatements();

    adminSession = await login(ADMIN_USER);
    staffSession = await login(STAFF_USER);
  });

  it('shows a privileged viewer every open ticket', async () => {
    const res = await request('GET', '/dashboard', { cookies: adminSession.cookies });
    expect(res.status).toBe(200);
    expect(res.body).toContain('TK-392-STAFF');
    expect(res.body).toContain('TK-392-ADMIN');
  });

  it('does not expose a colleague ticket to a non-privileged viewer', async () => {
    const res = await request('GET', '/dashboard', { cookies: staffSession.cookies });
    expect(res.status).toBe(200);
    // The staff member's own open ticket is shown (myTickets / recentTickets).
    expect(res.body).toContain('TK-392-STAFF');
    // The colleague's open ticket must not appear anywhere on the dashboard:
    // not in recentTickets, not in ticketStats, not in staffWorkload.
    expect(res.body).not.toContain('TK-392-ADMIN');
  });
});
