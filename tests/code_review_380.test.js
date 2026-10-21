const { describe, it, expect, beforeEach, afterEach } = require('@jest/globals');

// ---------------------------------------------------------------------------
// Regression tests for review pass 380.
//
// The defects closed by this pass:
//
//  1. POST /staff REFUSED an absent `role` ("Invalid Role") while
//     `users.role` is `NOT NULL DEFAULT 'staff'` — an API client that
//     submitted only the required fields was refused on staff and accepted
//     on every other entity.
//
//  2. EVERY create route accepted a present-but-WHITESPACE-ONLY optional text
//     value, trimming it to '' and storing NULL with a success flash, while
//     the matching PUT route rejected the identical value ("the same column,
//     two verdicts"). Affected: assets (manufacturer/model/serial/location/
//     notes), licences (vendor/license_key/notes), tickets (description/
//     requester_department), projects (description), vendors (contact_person/
//     email/address/website/notes), knowledge (tags), changes (description/
//     impact).
//
//  3. The knowledge LIST searched the article body in its ENTITY-ESCAPED
//     stored form, so the body text the reader actually sees could not be
//     typed back in.
//
//  4. The assets list and the ticket list render the assignee's name but did
//     not search it — the name a user reads off the page was unfindable.
//
//  5. POST /projects/:id/tasks could store a task as 'done' with a NULL
//     completed_at — the only producer of a state the UPDATE routes consider
//     impossible.
//
//  6. PUT /profile reported a present-but-non-string required column as a
//     MISSING field, and PUT /profile/password reported a non-string password
//     as a missing field.
//
//  7. POST /login reported a present-but-non-string password as a SERVER
//     error ("An error occurred during login") because bcrypt.compare throws
//     on a non-string.
//
//  8. PUT /projects/:projectId/tasks/:taskId reported a non-string title as
//     "Invalid Task Title" and POST /projects/:id/members reported a
//     non-string role as "Invalid Role" — both diverge from the app-wide
//     "Invalid request parameters" wording.
//
//  9. The staff DIRECTORY kept every account's username in a privileged
//     viewer's render context, contradicting its own comment (the directory
//     renders it for nobody).
//
// 10. POST /staff stored department = NULL, so the schema's documented
//     DEFAULT 'IT' could never fire and the row matched no department
//     filter.
// ---------------------------------------------------------------------------

// The real schema and the real route handlers are exercised against an
// in-memory SQLite database so the SQL behaviour is asserted for real rather
// than mirrored in the test (which would drift from the source).
jest.resetModules();
process.env.DB_PATH = ':memory:';

jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => next(),
  requireAdminOrManager: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
  canAccessResource: () => true,
  destroySessionAndRedirect: jest.fn(),
  resetCachedStatements: jest.fn()
}));

jest.mock('../src/middleware/audit', () => ({
  audit: jest.fn(),
  auditMiddleware: (req, res, next) => next(),
  resetCachedStatements: jest.fn()
}));

jest.mock('bcryptjs', () => ({
  hash: jest.fn(async () => 'hashed-password'),
  compare: jest.fn(async () => false),
  hashSync: jest.fn(() => 'hashed-password')
}));

jest.mock('../src/routes/dashboard', () => {
  const Router = require('express').Router;
  const router = Router();
  router.invalidateDashboardCache = jest.fn();
  return router;
});

const db = require('../src/models/database');
const assetsRouter = require('../src/routes/assets');
const changesRouter = require('../src/routes/changes');
const knowledgeRouter = require('../src/routes/knowledge');
const licensesRouter = require('../src/routes/licenses');
const projectsRouter = require('../src/routes/projects');
const staffRouter = require('../src/routes/staff');
const ticketsRouter = require('../src/routes/tickets');
const vendorsRouter = require('../src/routes/vendors');
const authRouter = require('../src/routes/auth');
const { lastHandlerFor } = require('./helpers');

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const ADMIN = { id: 1, role: 'admin', first_name: 'Ada', last_name: 'Lovelace' };

/** Build a request object for a list route. */
function listReq(query, user = ADMIN) {
  return {
    query,
    body: {},
    params: {},
    session: { user },
    flash: jest.fn(),
    audit: jest.fn()
  };
}

/** Build a request object for a write route. */
function writeReq(body, params = {}, user = ADMIN) {
  return {
    query: {},
    body,
    params,
    session: { user },
    flash: jest.fn(),
    audit: jest.fn()
  };
}

/** Response double that records the redirect target and the render payload. */
function makeRes() {
  return {
    redirected: null,
    rendered: null,
    statusCode: 200,
    redirect(to) {
      this.redirected = to; return this;
    },
    render(view, locals) {
      this.rendered = { view, locals }; return this;
    },
    status(code) {
      this.statusCode = code; return this;
    },
    json() {
      return this;
    },
    send() {
      return this;
    }
  };
}

/** The first error flashed on the request, or null. */
function errorFlash(req) {
  const call = req.flash.mock.calls.find(([type]) => type === 'error');
  return call ? call[1] : null;
}

/** The first success flashed on the request, or null. */
function successFlash(req) {
  const call = req.flash.mock.calls.find(([type]) => type === 'success');
  return call ? call[1] : null;
}

/** Flush the microtask queue so an async handler's continuation is observable. */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function clearTables() {
  db.pragma('foreign_keys = OFF');
  db.exec(`
    DELETE FROM ticket_comments;
    DELETE FROM tickets;
    DELETE FROM project_members;
    DELETE FROM project_tasks;
    DELETE FROM projects;
    DELETE FROM knowledge_articles;
    DELETE FROM change_log;
    DELETE FROM licenses;
    DELETE FROM assets;
    DELETE FROM vendors;
    DELETE FROM users;
    DELETE FROM ticket_counter;
    DELETE FROM asset_counter;
  `);
  db.pragma('foreign_keys = ON');
}

function insertUser(row) {
  db.prepare(`
    INSERT INTO users (username, password, email, first_name, last_name, role, department, is_active)
    VALUES (?, 'hash', ?, ?, ?, ?, ?, ?)
  `).run(
    row.username,
    row.email,
    row.first_name,
    row.last_name,
    row.role || 'staff',
    row.department === undefined ? 'IT' : row.department,
    row.is_active === undefined ? 1 : row.is_active
  );
  return db.prepare('SELECT id FROM users WHERE username = ?').get(row.username).id;
}

function insertAsset(row) {
  return db.prepare(`
    INSERT INTO assets (asset_tag, name, manufacturer, category, status, assigned_to)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    row.asset_tag,
    row.name,
    row.manufacturer === undefined ? null : row.manufacturer,
    row.category || 'laptop',
    row.status || 'in_storage',
    row.assigned_to === undefined ? null : row.assigned_to
  ).lastInsertRowid;
}

function insertTicket(row) {
  return db.prepare(`
    INSERT INTO tickets (ticket_number, title, description, category, priority, status, requester_name, requester_email, assigned_to)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.ticket_number || 'TK-20260101-001',
    row.title || 'Test ticket',
    row.description === undefined ? null : row.description,
    row.category || 'hardware',
    row.priority || 'medium',
    row.status || 'open',
    row.requester_name || 'Requester',
    row.requester_email || 'requester@example.com',
    row.assigned_to === undefined ? null : row.assigned_to
  ).lastInsertRowid;
}

beforeEach(() => {
  clearTables();
  require('../src/utils').resetCachedStatements();
});

afterEach(() => {
  clearTables();
});

// ---------------------------------------------------------------------------
// 1. POST /staff — an absent role takes the schema default
// ---------------------------------------------------------------------------
describe('code review 380 — POST /staff role default', () => {
  const createHandler = () => lastHandlerFor(staffRouter, 'post', '/');

  const baseBody = (extra) => Object.assign({
    username: 'newuser',
    password: 'Str0ng!Passw0rd',
    email: 'new@example.com',
    first_name: 'New',
    last_name: 'User'
  }, extra || {});

  it('creates the staff member with the schema default "staff" when the role is absent', async () => {
    const req = writeReq(baseBody());
    const res = makeRes();

    await createHandler()(req, res);
    await flush();

    expect(errorFlash(req)).toBeNull();
    expect(successFlash(req)).toMatch(/created/);
    expect(db.prepare("SELECT role FROM users WHERE username = 'newuser'").get().role).toBe('staff');
  });

  it('still applies a submitted role', async () => {
    const req = writeReq(baseBody({ role: 'manager' }));
    const res = makeRes();

    await createHandler()(req, res);
    await flush();

    expect(errorFlash(req)).toBeNull();
    expect(db.prepare("SELECT role FROM users WHERE username = 'newuser'").get().role).toBe('manager');
  });

  it('rejects a present-but-empty role and writes nothing', async () => {
    const req = writeReq(baseBody({ role: '' }));
    const res = makeRes();

    await createHandler()(req, res);
    await flush();

    expect(errorFlash(req)).toBe('Invalid Role');
    expect(res.redirected).toBe('/staff/new');
    expect(db.prepare('SELECT COUNT(*) as c FROM users').get().c).toBe(0);
  });

  it('rejects a present-but-whitespace-only role and writes nothing', async () => {
    const req = writeReq(baseBody({ role: '   ' }));
    const res = makeRes();

    await createHandler()(req, res);
    await flush();

    expect(errorFlash(req)).toBe('Invalid Role');
    expect(db.prepare('SELECT COUNT(*) as c FROM users').get().c).toBe(0);
  });

  it('rejects an unknown role and writes nothing', async () => {
    const req = writeReq(baseBody({ role: 'superuser' }));
    const res = makeRes();

    await createHandler()(req, res);
    await flush();

    expect(errorFlash(req)).toBe('Invalid Role');
    expect(db.prepare('SELECT COUNT(*) as c FROM users').get().c).toBe(0);
  });

  it('reports a present-but-non-string password as a type error', async () => {
    const req = writeReq(baseBody({ password: 12345678 }));
    const res = makeRes();

    await createHandler()(req, res);
    await flush();

    expect(errorFlash(req)).toBe('Invalid request parameters');
    expect(db.prepare('SELECT COUNT(*) as c FROM users').get().c).toBe(0);
  });

  it('reports a FALSY non-string password as a type error, not a missing field', async () => {
    const req = writeReq(baseBody({ password: 0 }));
    const res = makeRes();

    await createHandler()(req, res);
    await flush();

    expect(errorFlash(req)).toBe('Invalid request parameters');
    expect(db.prepare('SELECT COUNT(*) as c FROM users').get().c).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Every create route rejects a present-but-whitespace-only text value
// ---------------------------------------------------------------------------
describe('code review 380 — create routes reject a whitespace-only optional text value', () => {
  it('POST /assets rejects a whitespace-only manufacturer and writes nothing', () => {
    const req = writeReq({ name: 'OptiPlex', category: 'desktop', manufacturer: '   ' });
    const res = makeRes();

    lastHandlerFor(assetsRouter, 'post', '/')(req, res);

    expect(errorFlash(req)).toBe('Invalid Manufacturer');
    expect(res.redirected).toBe('/assets/new');
    expect(db.prepare('SELECT COUNT(*) as c FROM assets').get().c).toBe(0);
  });

  it('POST /assets still stores a real manufacturer', () => {
    const req = writeReq({ name: 'OptiPlex', category: 'desktop', manufacturer: 'Dell' });
    const res = makeRes();

    lastHandlerFor(assetsRouter, 'post', '/')(req, res);

    expect(errorFlash(req)).toBeNull();
    expect(db.prepare('SELECT manufacturer FROM assets').get().manufacturer).toBe('Dell');
  });

  it('POST /licenses rejects a whitespace-only license key and writes nothing', () => {
    const req = writeReq({ software_name: 'Acme ERP', license_key: '   ' });
    const res = makeRes();

    lastHandlerFor(licensesRouter, 'post', '/')(req, res);

    expect(errorFlash(req)).toBe('Invalid License Key');
    expect(res.redirected).toBe('/licenses/new');
    expect(db.prepare('SELECT COUNT(*) as c FROM licenses').get().c).toBe(0);
  });

  it('POST /licenses rejects a whitespace-only vendor and writes nothing', () => {
    const req = writeReq({ software_name: 'Acme ERP', vendor: '   ' });
    const res = makeRes();

    lastHandlerFor(licensesRouter, 'post', '/')(req, res);

    expect(errorFlash(req)).toBe('Invalid Vendor');
    expect(db.prepare('SELECT COUNT(*) as c FROM licenses').get().c).toBe(0);
  });

  it('POST /tickets rejects a whitespace-only description and writes nothing', () => {
    const req = writeReq({
      title: 'Printer on fire',
      category: 'hardware',
      requester_name: 'Ada Lovelace',
      requester_email: 'ada@example.com',
      description: '   '
    });
    const res = makeRes();

    lastHandlerFor(ticketsRouter, 'post', '/')(req, res);

    expect(errorFlash(req)).toBe('Invalid Description');
    expect(res.redirected).toBe('/tickets/new');
    expect(db.prepare('SELECT COUNT(*) as c FROM tickets').get().c).toBe(0);
  });

  it('POST /projects rejects a whitespace-only description and writes nothing', () => {
    const req = writeReq({ name: 'Network upgrade', description: '   ' });
    const res = makeRes();

    lastHandlerFor(projectsRouter, 'post', '/')(req, res);

    expect(errorFlash(req)).toBe('Invalid Description');
    expect(res.redirected).toBe('/projects/new');
    expect(db.prepare('SELECT COUNT(*) as c FROM projects').get().c).toBe(0);
  });

  it('POST /vendors rejects a whitespace-only contact person and writes nothing', () => {
    const req = writeReq({ name: 'Acme Supplies', contact_person: '   ' });
    const res = makeRes();

    lastHandlerFor(vendorsRouter, 'post', '/')(req, res);

    expect(errorFlash(req)).toBe('Invalid Contact Person');
    expect(res.redirected).toBe('/vendors/new');
    expect(db.prepare('SELECT COUNT(*) as c FROM vendors').get().c).toBe(0);
  });

  it('POST /knowledge rejects a whitespace-only tags value and writes nothing', () => {
    const req = writeReq({ title: 'Reset guide', content: 'body text', category: 'how_to', tags: '   ' });
    const res = makeRes();

    lastHandlerFor(knowledgeRouter, 'post', '/')(req, res);

    expect(errorFlash(req)).toBe('Invalid Tags');
    expect(res.redirected).toBe('/knowledge/new');
    expect(db.prepare('SELECT COUNT(*) as c FROM knowledge_articles').get().c).toBe(0);
  });

  it('POST /changes rejects a whitespace-only impact and writes nothing', () => {
    const req = writeReq({ title: 'Patching', change_type: 'maintenance', impact: '   ' });
    const res = makeRes();

    lastHandlerFor(changesRouter, 'post', '/')(req, res);

    expect(errorFlash(req)).toBe('Invalid Impact');
    expect(res.redirected).toBe('/changes/new');
    expect(db.prepare('SELECT COUNT(*) as c FROM change_log').get().c).toBe(0);
  });

  it('the matching PUT route rejects the same value with the same message', () => {
    const assetId = insertAsset({ asset_tag: 'AST-001', name: 'OptiPlex', manufacturer: 'Dell' });
    const req = writeReq({ manufacturer: '   ' }, { id: String(assetId) });
    const res = makeRes();

    lastHandlerFor(assetsRouter, 'put', '/:id')(req, res);

    expect(errorFlash(req)).toBe('Invalid Manufacturer');
    expect(db.prepare('SELECT manufacturer FROM assets WHERE id = ?').get(assetId).manufacturer).toBe('Dell');
  });
});

// ---------------------------------------------------------------------------
// 3. The knowledge list finds an article by the body text the reader sees
// ---------------------------------------------------------------------------
describe('code review 380 — the knowledge list searches the body in its readable form', () => {
  it('finds an article by the DECODED body text the show page renders', () => {
    const authorId = insertUser({ username: 'ada', email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace', role: 'admin' });
    // The body is stored ENTITY-ESCAPED (it is rendered as HTML), so the
    // stored value holds "R&amp;D budget" while the reader sees "R&D budget".
    db.prepare(`
      INSERT INTO knowledge_articles (title, content, category, status, author_id)
      VALUES ('Budget policy', 'The R&amp;D budget is fixed', 'policy', 'published', ?)
    `).run(authorId);

    const req = listReq({ search: 'R&D budget' });
    const res = makeRes();
    lastHandlerFor(knowledgeRouter, 'get', '/')(req, res);

    expect(res.rendered.locals.articles.map(a => a.title)).toEqual(['Budget policy']);
    expect(res.rendered.locals.total).toBe(res.rendered.locals.articles.length);
  });

  it('still finds an article by a plain word in the body', () => {
    const authorId = insertUser({ username: 'ada', email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace', role: 'admin' });
    db.prepare(`
      INSERT INTO knowledge_articles (title, content, category, status, author_id)
      VALUES ('Budget policy', 'The R&amp;D budget is fixed', 'policy', 'published', ?)
    `).run(authorId);

    const req = listReq({ search: 'budget' });
    const res = makeRes();
    lastHandlerFor(knowledgeRouter, 'get', '/')(req, res);

    expect(res.rendered.locals.articles.map(a => a.title)).toEqual(['Budget policy']);
  });
});

// ---------------------------------------------------------------------------
// 4. The "Assigned To" name cell the asset and ticket lists render is findable
// ---------------------------------------------------------------------------
describe('code review 380 — the rendered "Assigned To" cell is searchable', () => {
  it('finds an asset by the assignee name the row renders', () => {
    const assigneeId = insertUser({ username: 'bob', email: 'bob@example.com', first_name: 'Bob', last_name: 'Smith', role: 'staff' });
    insertAsset({ asset_tag: 'AST-777', name: 'OptiPlex', manufacturer: 'Dell', assigned_to: assigneeId });

    const req = listReq({ search: 'Bob Smith' });
    const res = makeRes();
    lastHandlerFor(assetsRouter, 'get', '/')(req, res);

    expect(res.rendered.locals.assets.map(a => a.asset_tag)).toEqual(['AST-777']);
    // The count query needs the same JOIN as the listing, or the two disagree.
    expect(res.rendered.locals.total).toBe(res.rendered.locals.assets.length);
  });

  it('finds a ticket by the assignee name the row renders', () => {
    const assigneeId = insertUser({ username: 'bob', email: 'bob@example.com', first_name: 'Bob', last_name: 'Smith', role: 'staff' });
    insertTicket({ ticket_number: 'TK-20260101-777', title: 'Broken laptop', assigned_to: assigneeId });

    const req = listReq({ search: 'Bob Smith' });
    const res = makeRes();
    lastHandlerFor(ticketsRouter, 'get', '/')(req, res);

    expect(res.rendered.locals.tickets.map(t => t.ticket_number)).toEqual(['TK-20260101-777']);
    expect(res.rendered.locals.total).toBe(res.rendered.locals.tickets.length);
  });

  it('still reports a zero total for a name that matches nothing', () => {
    const assigneeId = insertUser({ username: 'bob', email: 'bob@example.com', first_name: 'Bob', last_name: 'Smith', role: 'staff' });
    insertAsset({ asset_tag: 'AST-777', name: 'OptiPlex', manufacturer: 'Dell', assigned_to: assigneeId });

    const req = listReq({ search: 'Nobody Here' });
    const res = makeRes();
    lastHandlerFor(assetsRouter, 'get', '/')(req, res);

    expect(res.rendered.locals.total).toBe(0);
    expect(res.rendered.locals.assets).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. A task created as 'done' carries a completion timestamp
// ---------------------------------------------------------------------------
describe('code review 380 — POST /projects/:id/tasks derives completed_at', () => {
  const addTaskHandler = () => lastHandlerFor(projectsRouter, 'post', '/:id/tasks');

  it('stores a completion timestamp for a task created as "done"', () => {
    const projectId = db.prepare("INSERT INTO projects (name, status, priority) VALUES ('Network upgrade', 'planning', 'medium')").run().lastInsertRowid;
    const req = writeReq({ title: 'Patch servers', status: 'done' }, { id: String(projectId) });
    const res = makeRes();

    addTaskHandler()(req, res);

    expect(errorFlash(req)).toBeNull();
    const row = db.prepare('SELECT status, completed_at FROM project_tasks WHERE project_id = ?').get(projectId);
    expect(row.status).toBe('done');
    expect(row.completed_at).toBeTruthy();
  });

  it('stores no completion timestamp for a task created in any other state', () => {
    const projectId = db.prepare("INSERT INTO projects (name, status, priority) VALUES ('Network upgrade', 'planning', 'medium')").run().lastInsertRowid;
    const req = writeReq({ title: 'Patch servers', status: 'in_progress' }, { id: String(projectId) });
    const res = makeRes();

    addTaskHandler()(req, res);

    expect(errorFlash(req)).toBeNull();
    const row = db.prepare('SELECT status, completed_at FROM project_tasks WHERE project_id = ?').get(projectId);
    expect(row.status).toBe('in_progress');
    expect(row.completed_at).toBeNull();
  });

  it('still defaults an absent status to "todo"', () => {
    const projectId = db.prepare("INSERT INTO projects (name, status, priority) VALUES ('Network upgrade', 'planning', 'medium')").run().lastInsertRowid;
    const req = writeReq({ title: 'Patch servers' }, { id: String(projectId) });
    const res = makeRes();

    addTaskHandler()(req, res);

    expect(errorFlash(req)).toBeNull();
    const row = db.prepare('SELECT status, completed_at FROM project_tasks WHERE project_id = ?').get(projectId);
    expect(row.status).toBe('todo');
    expect(row.completed_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. The profile routes report a wrong-typed value as a type error
// ---------------------------------------------------------------------------
describe('code review 380 — the profile routes fail closed on a wrong type', () => {
  const profileHandler = () => lastHandlerFor(authRouter, 'put', '/profile');
  const passwordHandler = () => lastHandlerFor(authRouter, 'put', '/profile/password');

  it('reports a present-but-non-string required profile column as "Invalid request parameters"', async () => {
    const userId = insertUser({ username: 'ada', email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace', role: 'admin' });
    const req = writeReq({ first_name: 42 }, {}, { id: userId, role: 'admin' });
    const res = makeRes();

    await profileHandler()(req, res);
    await flush();

    expect(errorFlash(req)).toBe('Invalid request parameters');
    expect(db.prepare('SELECT first_name FROM users WHERE id = ?').get(userId).first_name).toBe('Ada');
  });

  it('reports a present-but-non-string new password as "Invalid request parameters"', async () => {
    const userId = insertUser({ username: 'ada', email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace', role: 'admin' });
    const req = writeReq(
      { current_password: 'Str0ng!Passw0rd', new_password: 12345678, confirm_password: 12345678 },
      {},
      { id: userId, role: 'admin' }
    );
    const res = makeRes();

    await passwordHandler()(req, res);
    await flush();

    expect(errorFlash(req)).toBe('Invalid request parameters');
  });

  it('reports a present-but-non-string current password as "Invalid request parameters"', async () => {
    const userId = insertUser({ username: 'ada', email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace', role: 'admin' });
    const req = writeReq(
      { current_password: 42, new_password: 'Str0ng!Passw0rd', confirm_password: 'Str0ng!Passw0rd' },
      {},
      { id: userId, role: 'admin' }
    );
    const res = makeRes();

    await passwordHandler()(req, res);
    await flush();

    expect(errorFlash(req)).toBe('Invalid request parameters');
  });

  it('still reports an absent new password as a missing field', async () => {
    const userId = insertUser({ username: 'ada', email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace', role: 'admin' });
    const req = writeReq({ current_password: 'Str0ng!Passw0rd' }, {}, { id: userId, role: 'admin' });
    const res = makeRes();

    await passwordHandler()(req, res);
    await flush();

    expect(errorFlash(req)).toBe('New password is required.');
  });
});

// ---------------------------------------------------------------------------
// 7. A non-string login credential is a client error, not a server error
// ---------------------------------------------------------------------------
describe('code review 380 — POST /login rejects a non-string credential', () => {
  const loginHandler = () => lastHandlerFor(authRouter, 'post', '/login');

  it('reports a present-but-non-string password as invalid credentials', async () => {
    const req = writeReq({ username: 'ada', password: 42 }, {}, { id: 1, role: 'admin' });
    req.ip = '203.0.113.5';
    const res = makeRes();

    await loginHandler()(req, res);
    await flush();

    expect(errorFlash(req)).toBe('Invalid Login Credentials');
    expect(res.redirected).toBe('/login');
  });

  it('reports a FALSY non-string password as invalid credentials, not a missing field', async () => {
    const req = writeReq({ username: 'ada', password: 0 }, {}, { id: 1, role: 'admin' });
    req.ip = '203.0.113.5';
    const res = makeRes();

    await loginHandler()(req, res);
    await flush();

    expect(errorFlash(req)).toBe('Invalid Login Credentials');
  });

  it('still reports a missing credential as a missing field', async () => {
    const req = writeReq({ username: 'ada' }, {}, { id: 1, role: 'admin' });
    req.ip = '203.0.113.5';
    const res = makeRes();

    await loginHandler()(req, res);
    await flush();

    expect(errorFlash(req)).toBe('Please enter username and password.');
  });
});

// ---------------------------------------------------------------------------
// 8. The project task/member routes use the app-wide type-error wording
// ---------------------------------------------------------------------------
describe('code review 380 — project task/member type-error wording', () => {
  it('PUT /projects/:projectId/tasks/:taskId reports a non-string title as "Invalid request parameters"', () => {
    const projectId = db.prepare("INSERT INTO projects (name, status, priority) VALUES ('Network upgrade', 'planning', 'medium')").run().lastInsertRowid;
    const taskId = db.prepare("INSERT INTO project_tasks (project_id, title, status) VALUES (?, 'Patch servers', 'todo')").run(projectId).lastInsertRowid;
    const req = writeReq({ title: 42 }, { projectId: String(projectId), taskId: String(taskId) });
    const res = makeRes();

    lastHandlerFor(projectsRouter, 'put', '/:projectId/tasks/:taskId')(req, res);

    expect(errorFlash(req)).toBe('Invalid request parameters');
    expect(db.prepare('SELECT title FROM project_tasks WHERE id = ?').get(taskId).title).toBe('Patch servers');
  });

  it('POST /projects/:id/members reports a non-string role as "Invalid request parameters"', () => {
    const projectId = db.prepare("INSERT INTO projects (name, status, priority) VALUES ('Network upgrade', 'planning', 'medium')").run().lastInsertRowid;
    const userId = insertUser({ username: 'bob', email: 'bob@example.com', first_name: 'Bob', last_name: 'Smith', role: 'staff' });
    const req = writeReq({ user_id: String(userId), role: 42 }, { id: String(projectId) });
    const res = makeRes();

    lastHandlerFor(projectsRouter, 'post', '/:id/members')(req, res);

    expect(errorFlash(req)).toBe('Invalid request parameters');
    expect(db.prepare('SELECT COUNT(*) as c FROM project_members').get().c).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 9. The staff directory never carries a username in its render context
// ---------------------------------------------------------------------------
describe('code review 380 — the staff directory redacts the username for every row', () => {
  it('zeroes the username even for the privileged viewer and their own row', () => {
    insertUser({ username: 'ada', email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace', role: 'admin' });
    insertUser({ username: 'bob', email: 'bob@example.com', first_name: 'Bob', last_name: 'Smith', role: 'staff' });

    const req = listReq({}, { id: 1, role: 'admin' });
    const res = makeRes();
    lastHandlerFor(staffRouter, 'get', '/')(req, res);

    expect(res.rendered.locals.staff).toHaveLength(2);
    expect(res.rendered.locals.staff.map(s => s.username)).toEqual([null, null]);
    // The other PII columns are still delivered to a privileged viewer.
    expect(res.rendered.locals.staff.map(s => s.email).sort()).toEqual(['ada@example.com', 'bob@example.com']);
  });
});

// ---------------------------------------------------------------------------
// 10. POST /staff applies the schema's documented department default
// ---------------------------------------------------------------------------
describe('code review 380 — POST /staff department default', () => {
  const createHandler = () => lastHandlerFor(staffRouter, 'post', '/');

  it('stores the schema default "IT" when no department is submitted', async () => {
    const req = writeReq({
      username: 'newuser',
      password: 'Str0ng!Passw0rd',
      email: 'new@example.com',
      first_name: 'New',
      last_name: 'User'
    });
    const res = makeRes();

    await createHandler()(req, res);
    await flush();

    expect(errorFlash(req)).toBeNull();
    expect(db.prepare("SELECT department FROM users WHERE username = 'newuser'").get().department).toBe('IT');
  });
});
