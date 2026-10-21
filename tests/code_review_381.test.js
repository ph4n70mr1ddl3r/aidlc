const { describe, it, expect, beforeEach, afterEach } = require('@jest/globals');

// ---------------------------------------------------------------------------
// Regression tests for review pass 381.
//
// The defects closed by this pass:
//
//  1. POST /projects/:id/tasks accepted a present-but-WHITESPACE-ONLY
//     description, trimming it to '' and storing NULL with a success flash,
//     while the matching task PUT route rejected the identical value — the
//     same column, two verdicts. Pass 380 closed this class on every CREATE
//     route but missed the task-create sub-route.
//
//  2. A wrong-TYPED body field was reported with a FIELD-SPECIFIC message on
//     the UPDATE routes ("Invalid Manufacturer", "Invalid Description",
//     "Invalid Title", "Invalid Status", …) and with the app-wide "Invalid
//     request parameters" on the matching CREATE routes — the same column,
//     two messages, depending on the verb. The changes.js create route's own
//     comment demanded the opposite ("BOTH verbs of this route report the
//     identical submission the same way").
//
//  3. staff.js was the only module whose enum (`role`) was not covered by the
//     app-wide wrong-type guard, so a non-string role was reported as an
//     invalid VALUE ("Invalid Role") — indistinguishable from an unknown
//     role.
//
//  4. The date-only horizons (the dashboard's 30-day warranty/licence
//     alerts, the asset report's 90-day warranty list and its age buckets)
//     were compared against SQLite's UTC clock, while the columns they read
//     hold the LOCAL calendar day the user typed — the app's own daysUntil()
//     arithmetic used the local calendar, so an asset could be excluded from
//     a window the app itself said it was inside.
//
//  5. The projects list and show routes handed the budget/spent columns to
//     EVERY viewer, although the templates gate them behind
//     isPrivileged(user) — a project owner who is not privileged received the
//     amounts in the render context.
//
//  6. The knowledge list applied a status filter the control could not
//     represent: an unprivileged viewer's ?status=draft filtered the list
//     while the dropdown displayed "All Status".
//
//  7. The assets and staff show routes answered a denied view with a
//     DIFFERENT message than a missing record ("You do not have permission
//     to view this …"), turning the response into an existence oracle —
//     unlike the changes/knowledge show routes, which answer both branches
//     identically.
//
//  8. The per-IP login lockout was keyed by the RAW address (so an IPv6
//     client could rotate addresses to reset it) and was cleared wholesale by
//     ANY successful login from that address (so one valid account reset the
//     shared brake for every account behind it).
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
  canAccessResource: jest.fn(() => true),
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
  // A successful login is only possible for the one password below, so the
  // lockout tests can drive a real success path.
  compare: jest.fn(async (candidate) => candidate === 'Str0ng!Passw0rd'),
  hashSync: jest.fn(() => 'hashed-password')
}));

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
const dashboardRouter = require('../src/routes/dashboard');
const reportsRouter = require('../src/routes/reports');
const { lastHandlerFor } = require('./helpers');

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const ADMIN = { id: 1, role: 'admin', first_name: 'Ada', last_name: 'Lovelace' };
const STAFF_USER = { id: 2, role: 'staff', first_name: 'Bob', last_name: 'Baker' };

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
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.username,
    row.password || 'hash',
    row.email,
    row.first_name,
    row.last_name,
    row.role || 'staff',
    row.department === undefined ? 'IT' : row.department,
    row.is_active === undefined ? 1 : row.is_active
  );
  return db.prepare('SELECT id FROM users WHERE username = ?').get(row.username).id;
}

function insertProject(row) {
  return db.prepare(`
    INSERT INTO projects (name, description, status, priority, budget, spent, owner_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.name,
    row.description === undefined ? null : row.description,
    row.status || 'planning',
    row.priority || 'medium',
    row.budget === undefined ? 1000 : row.budget,
    row.spent === undefined ? 250 : row.spent,
    row.owner_id === undefined ? null : row.owner_id
  ).lastInsertRowid;
}

function insertTask(row) {
  return db.prepare(`
    INSERT INTO project_tasks (project_id, title, description, status, priority)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    row.project_id,
    row.title || 'A task',
    row.description === undefined ? null : row.description,
    row.status || 'todo',
    row.priority || 'medium'
  ).lastInsertRowid;
}

function insertChange(row) {
  return db.prepare(`
    INSERT INTO change_log (title, change_type, status, priority, description, impact)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    row.title || 'A change',
    row.change_type || 'maintenance',
    row.status || 'scheduled',
    row.priority || 'medium',
    row.description === undefined ? null : row.description,
    row.impact === undefined ? null : row.impact
  ).lastInsertRowid;
}

function insertAsset(row) {
  return db.prepare(`
    INSERT INTO assets (asset_tag, name, manufacturer, category, status, assigned_to, warranty_expiry)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.asset_tag,
    row.name,
    row.manufacturer === undefined ? null : row.manufacturer,
    row.category || 'laptop',
    row.status || 'in_storage',
    row.assigned_to === undefined ? null : row.assigned_to,
    row.warranty_expiry === undefined ? null : row.warranty_expiry
  ).lastInsertRowid;
}

/** The local calendar day `days` from today, as "YYYY-MM-DD". */
function localDatePlus(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0')
  ].join('-');
}

beforeEach(() => {
  clearTables();
  require('../src/utils').resetCachedStatements();
});

afterEach(() => {
  clearTables();
});

// ---------------------------------------------------------------------------
// 1. POST /projects/:id/tasks — a whitespace-only description is rejected
// ---------------------------------------------------------------------------
describe('code review 381 — task create rejects a whitespace-only description', () => {
  const addTaskHandler = () => lastHandlerFor(projectsRouter, 'post', '/:id/tasks');
  const updateTaskHandler = () => lastHandlerFor(projectsRouter, 'put', '/:projectId/tasks/:taskId');

  it('refuses the value and stores no task', () => {
    const projectId = insertProject({ name: 'Rollout' });
    const req = writeReq({ title: 'A task', description: '   ' }, { id: String(projectId) });
    const res = makeRes();

    addTaskHandler()(req, res);

    expect(errorFlash(req)).toBe('Invalid Description');
    expect(res.redirected).toBe(`/projects/${projectId}`);
    expect(db.prepare('SELECT COUNT(*) as c FROM project_tasks').get().c).toBe(0);
  });

  it('reports the SAME message as the matching task UPDATE route', () => {
    const projectId = insertProject({ name: 'Rollout' });
    const taskId = insertTask({ project_id: projectId, description: 'keep me' });
    const req = writeReq({ title: 'A task', description: '   ' }, { projectId: String(projectId), taskId: String(taskId) });
    const res = makeRes();

    updateTaskHandler()(req, res);

    expect(errorFlash(req)).toBe('Invalid Description');
    expect(db.prepare('SELECT description FROM project_tasks WHERE id = ?').get(taskId).description).toBe('keep me');
  });

  it('still accepts an absent description', () => {
    const projectId = insertProject({ name: 'Rollout' });
    const req = writeReq({ title: 'A task' }, { id: String(projectId) });
    const res = makeRes();

    addTaskHandler()(req, res);

    expect(errorFlash(req)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) as c FROM project_tasks').get().c).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. A wrong-typed field answers the same on both verbs
// ---------------------------------------------------------------------------
describe('code review 381 — a wrong-typed field answers identically on both verbs', () => {
  it('changes.js: PUT reports a wrong-typed status/priority/description/impact like POST', () => {
    const id = insertChange({ title: 'Patch', description: 'keep', impact: 'low' });
    const cases = [
      ['status', 42],
      ['priority', 42],
      ['description', 123],
      ['impact', { a: 1 }]
    ];
    for (const [field, value] of cases) {
      const req = writeReq({ title: 'Patch', change_type: 'maintenance', [field]: value }, { id: String(id) });
      const res = makeRes();

      lastHandlerFor(changesRouter, 'put', '/:id')(req, res);

      expect(errorFlash(req)).toBe('Invalid request parameters');
    }
    // Nothing was written.
    const row = db.prepare('SELECT status, priority, description, impact FROM change_log WHERE id = ?').get(id);
    expect(row.status).toBe('scheduled');
    expect(row.priority).toBe('medium');
    expect(row.description).toBe('keep');
    expect(row.impact).toBe('low');
  });

  it('changes.js: POST reports the same wrong-typed values identically', () => {
    for (const [field, value] of [['status', 42], ['priority', 42], ['description', 123], ['impact', { a: 1 }]]) {
      const req = writeReq({ title: 'Patch', change_type: 'maintenance', [field]: value });
      const res = makeRes();

      lastHandlerFor(changesRouter, 'post', '/')(req, res);

      expect(errorFlash(req)).toBe('Invalid request parameters');
    }
    expect(db.prepare('SELECT COUNT(*) as c FROM change_log').get().c).toBe(0);
  });

  it('changes.js: an unknown enum VALUE keeps its field-specific message', () => {
    const id = insertChange({ title: 'Patch' });
    const req = writeReq({ title: 'Patch', change_type: 'maintenance', status: 'invented' }, { id: String(id) });
    const res = makeRes();

    lastHandlerFor(changesRouter, 'put', '/:id')(req, res);

    expect(errorFlash(req)).toBe('Invalid Status');
  });

  it('tickets.js: PUT reports a wrong-typed title/requester/description like POST', () => {
    const cases = [
      ['title', 42],
      ['requester_name', 42],
      ['requester_email', 42],
      ['description', 42],
      ['resolution_notes', 42],
      ['requester_department', 42]
    ];
    for (const [field, value] of cases) {
      const req = writeReq({
        title: 'T', category: 'hardware', requester_name: 'Req', requester_email: 'r@x.com', [field]: value
      }, { id: '1' });
      const res = makeRes();

      lastHandlerFor(ticketsRouter, 'put', '/:id')(req, res);

      expect(errorFlash(req)).toBe('Invalid request parameters');
    }
  });

  it('tickets.js: POST reports the same wrong-typed values identically', () => {
    const cases = [
      ['title', 42],
      ['requester_name', 42],
      ['requester_email', 42],
      ['description', 42],
      ['requester_department', 42]
    ];
    for (const [field, value] of cases) {
      const req = writeReq({
        title: 'T', category: 'hardware', requester_name: 'Req', requester_email: 'r@x.com', [field]: value
      });
      const res = makeRes();

      lastHandlerFor(ticketsRouter, 'post', '/')(req, res);

      expect(errorFlash(req)).toBe('Invalid request parameters');
    }
  });

  it('assets.js: PUT reports a wrong-typed optional text field like POST', () => {
    let n = 0;
    for (const field of ['manufacturer', 'model', 'serial_number', 'location', 'notes']) {
      n += 1;
      const id = insertAsset({ asset_tag: `AST-00${n}`, name: 'Laptop' });
      const req = writeReq({ asset_tag: 'AST-001', name: 'Laptop', category: 'laptop', [field]: 123 }, { id: String(id) });
      const res = makeRes();

      lastHandlerFor(assetsRouter, 'put', '/:id')(req, res);

      expect(errorFlash(req)).toBe('Invalid request parameters');
    }
  });

  it('licenses.js: PUT reports a wrong-typed vendor/key/notes like POST', () => {
    for (const field of ['vendor', 'license_key', 'notes']) {
      const req = writeReq({ software_name: 'Photoshop', [field]: 123 }, { id: '1' });
      const res = makeRes();

      lastHandlerFor(licensesRouter, 'put', '/:id')(req, res);

      expect(errorFlash(req)).toBe('Invalid request parameters');
    }
  });

  it('vendors.js: PUT reports a wrong-typed optional text field like POST', () => {
    for (const field of ['contact_person', 'email', 'address', 'website', 'notes']) {
      const req = writeReq({ name: 'Acme', [field]: 123 }, { id: '1' });
      const res = makeRes();

      lastHandlerFor(vendorsRouter, 'put', '/:id')(req, res);

      expect(errorFlash(req)).toBe('Invalid request parameters');
    }
  });

  it('projects.js: PUT reports a wrong-typed description like POST', () => {
    const id = insertProject({ name: 'Rollout' });
    const req = writeReq({ name: 'Rollout', description: 123 }, { id: String(id) });
    const res = makeRes();

    lastHandlerFor(projectsRouter, 'put', '/:id')(req, res);

    expect(errorFlash(req)).toBe('Invalid request parameters');
    expect(db.prepare('SELECT description FROM projects WHERE id = ?').get(id).description).toBeNull();
  });

  it('projects.js: the task PUT reports a wrong-typed description like the task POST', () => {
    const projectId = insertProject({ name: 'Rollout' });
    const taskId = insertTask({ project_id: projectId, description: 'keep me' });
    const req = writeReq({ title: 'A task', description: 123 }, { projectId: String(projectId), taskId: String(taskId) });
    const res = makeRes();

    lastHandlerFor(projectsRouter, 'put', '/:projectId/tasks/:taskId')(req, res);

    expect(errorFlash(req)).toBe('Invalid request parameters');
    expect(db.prepare('SELECT description FROM project_tasks WHERE id = ?').get(taskId).description).toBe('keep me');
  });

  it('a whitespace-only value keeps its field-specific message on both verbs', () => {
    const id = insertChange({ title: 'Patch', description: 'keep' });
    const req = writeReq({ title: 'Patch', change_type: 'maintenance', description: '   ' }, { id: String(id) });
    const res = makeRes();

    lastHandlerFor(changesRouter, 'put', '/:id')(req, res);

    expect(errorFlash(req)).toBe('Invalid Description');
  });
});

// ---------------------------------------------------------------------------
// 3. staff.js — the role enum answers a wrong type app-wide
// ---------------------------------------------------------------------------
describe('code review 381 — staff role enum type error', () => {
  const createHandler = () => lastHandlerFor(staffRouter, 'post', '/');
  const updateHandler = () => lastHandlerFor(staffRouter, 'put', '/:id');

  const baseBody = (extra) => Object.assign({
    username: 'newuser',
    password: 'Str0ng!Passw0rd',
    email: 'new@example.com',
    first_name: 'New',
    last_name: 'User'
  }, extra || {});

  it('reports a non-string role as a type error on create', async () => {
    const req = writeReq(baseBody({ role: 5 }));
    const res = makeRes();

    await createHandler()(req, res);
    await flush();

    expect(errorFlash(req)).toBe('Invalid request parameters');
    expect(db.prepare('SELECT COUNT(*) as c FROM users').get().c).toBe(0);
  });

  it('reports a non-string role as a type error on update', async () => {
    const id = insertUser({ username: 'existing', email: 'e@example.com', first_name: 'E', last_name: 'X' });
    const req = writeReq({ email: 'e@example.com', first_name: 'E', last_name: 'X', role: true }, { id: String(id) });
    const res = makeRes();

    await updateHandler()(req, res);
    await flush();

    expect(errorFlash(req)).toBe('Invalid request parameters');
    expect(db.prepare('SELECT role FROM users WHERE id = ?').get(id).role).toBe('staff');
  });

  it('still reports an unknown role VALUE with the field-specific message', async () => {
    const req = writeReq(baseBody({ role: 'superuser' }));
    const res = makeRes();

    await createHandler()(req, res);
    await flush();

    expect(errorFlash(req)).toBe('Invalid Role');
  });
});

// ---------------------------------------------------------------------------
// 4. The date-only horizons use the LOCAL calendar
// ---------------------------------------------------------------------------
describe('code review 381 — the date-only horizons use the local calendar', () => {
  it("the dashboard's warranty and licence horizons are measured locally", () => {
    const stmts = dashboardRouter.__stmts;
    expect(stmts.expiringWarranties.source).toContain("date('now', 'localtime', '+30 days')");
    expect(stmts.expiringWarrantiesCount.source).toContain("date('now', 'localtime', '+30 days')");
    expect(stmts.licenseAlerts.source).toContain("date('now', 'localtime', '+30 days')");
    expect(stmts.licenseAlertsCount.source).toContain("date('now', 'localtime', '+30 days')");
    // The count and the list must use the SAME horizon.
    const horizon = /date\('now', 'localtime', '\+30 days'\)/;
    expect(stmts.expiringWarranties.source.match(horizon).length).toBe(1);
    expect(stmts.expiringWarrantiesCount.source.match(horizon).length).toBe(1);
  });

  it("the asset report's warranty horizon and age buckets are measured locally", () => {
    const stmts = reportsRouter.__stmts;
    expect(stmts.warrantyExpiring.source).toContain("date('now', 'localtime', '+90 days')");
    expect(stmts.warrantyExpiringCount.source).toContain("date('now', 'localtime', '+90 days')");
    expect(stmts.ageDistribution.source).toContain("julianday('now', 'localtime')");
  });

  it('an asset on the local 30-day boundary is inside the dashboard warranty horizon', () => {
    const boundary = localDatePlus(30);
    insertAsset({ asset_tag: 'AST-900', name: 'Boundary', warranty_expiry: boundary });
    const rows = dashboardRouter.__stmts.expiringWarranties.all();
    expect(rows.map(r => r.asset_tag)).toContain('AST-900');
  });
});

// ---------------------------------------------------------------------------
// 5. The projects money columns are withheld from unprivileged viewers
// ---------------------------------------------------------------------------
describe('code review 381 — project money columns are withheld from unprivileged viewers', () => {
  it('the projects list nulls budget/spent for a non-privileged viewer', () => {
    insertProject({ name: 'Rollout', budget: 5000, spent: 1234 });
    const req = listReq({}, STAFF_USER);
    const res = makeRes();

    lastHandlerFor(projectsRouter, 'get', '/')(req, res);

    expect(res.rendered.locals.projects).toHaveLength(1);
    expect(res.rendered.locals.projects[0].budget).toBeNull();
    expect(res.rendered.locals.projects[0].spent).toBeNull();
  });

  it('the projects list still delivers the money to a privileged viewer', () => {
    insertProject({ name: 'Rollout', budget: 5000, spent: 1234 });
    const req = listReq({}, ADMIN);
    const res = makeRes();

    lastHandlerFor(projectsRouter, 'get', '/')(req, res);

    expect(res.rendered.locals.projects[0].budget).toBe(5000);
    expect(res.rendered.locals.projects[0].spent).toBe(1234);
  });

  it('the project show route nulls budget/spent for a non-privileged viewer', () => {
    const id = insertProject({ name: 'Rollout', budget: 5000, spent: 1234 });
    const req = writeReq({}, { id: String(id) }, STAFF_USER);
    const res = makeRes();

    lastHandlerFor(projectsRouter, 'get', '/:id')(req, res);

    expect(res.rendered.locals.project.budget).toBeNull();
    expect(res.rendered.locals.project.spent).toBeNull();
  });

  it('the project show route still delivers the money to a privileged viewer', () => {
    const id = insertProject({ name: 'Rollout', budget: 5000, spent: 1234 });
    const req = writeReq({}, { id: String(id) }, ADMIN);
    const res = makeRes();

    lastHandlerFor(projectsRouter, 'get', '/:id')(req, res);

    expect(res.rendered.locals.project.budget).toBe(5000);
    expect(res.rendered.locals.project.spent).toBe(1234);
  });
});

// ---------------------------------------------------------------------------
// 6. The knowledge list applies only the statuses its control offers
// ---------------------------------------------------------------------------
describe('code review 381 — the knowledge status filter matches the control', () => {
  const listHandler = () => lastHandlerFor(knowledgeRouter, 'get', '/');

  function insertArticle(row) {
    return db.prepare(`
      INSERT INTO knowledge_articles (title, content, category, status, author_id, tags)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      row.title,
      row.content || 'Body text',
      row.category || 'other',
      row.status || 'published',
      row.author_id === undefined ? null : row.author_id,
      row.tags || null
    ).lastInsertRowid;
  }

  it('ignores a status the unprivileged control does not offer', () => {
    const authorId = insertUser({ username: 'author', email: 'a@example.com', first_name: 'A', last_name: 'B' });
    insertArticle({ title: 'Draft article', status: 'draft', author_id: authorId });
    const req = listReq({ status: 'draft' }, { id: authorId, role: 'staff', first_name: 'A', last_name: 'B' });
    const res = makeRes();

    listHandler()(req, res);

    // The filter is NOT applied — the dropdown cannot represent it, so the
    // list must not be filtered by it either.
    expect(res.rendered.locals.total).toBe(1);
    expect(res.rendered.locals.filters.status).toBe('draft');
    expect(res.rendered.locals.articles).toHaveLength(1);
  });

  it('applies the status filter for a privileged viewer', () => {
    const authorId = insertUser({ username: 'author2', email: 'a2@example.com', first_name: 'A', last_name: 'B' });
    insertArticle({ title: 'Draft article', status: 'draft', author_id: authorId });
    insertArticle({ title: 'Live article', status: 'published', author_id: authorId });
    const req = listReq({ status: 'draft' }, ADMIN);
    const res = makeRes();

    listHandler()(req, res);

    expect(res.rendered.locals.total).toBe(1);
    expect(res.rendered.locals.articles.map(a => a.title)).toEqual(['Draft article']);
  });
});

// ---------------------------------------------------------------------------
// 7. The show routes answer a denial exactly like a missing record
// ---------------------------------------------------------------------------
describe('code review 381 — the show routes do not enumerate', () => {
  it('the assets show route answers a denial with "Asset not found"', () => {
    const id = insertAsset({ asset_tag: 'AST-001', name: 'Laptop' });
    jest.requireMock('../src/middleware/auth').canAccessResource.mockReturnValue(false);
    const req = writeReq({}, { id: String(id) });
    const res = makeRes();

    lastHandlerFor(assetsRouter, 'get', '/:id')(req, res);

    expect(errorFlash(req)).toBe('Asset not found');
    jest.requireMock('../src/middleware/auth').canAccessResource.mockReturnValue(true);
  });

  it('the assets show route answers a MISSING record with the same message', () => {
    const req = writeReq({}, { id: '999999' });
    const res = makeRes();

    lastHandlerFor(assetsRouter, 'get', '/:id')(req, res);

    expect(errorFlash(req)).toBe('Asset not found');
  });

  it('the staff show route answers a denial with "Staff member not found"', () => {
    const id = insertUser({ username: 'someone', email: 's@example.com', first_name: 'S', last_name: 'X' });
    const req = writeReq({}, { id: String(id) }, STAFF_USER);
    const res = makeRes();

    lastHandlerFor(staffRouter, 'get', '/:id')(req, res);

    expect(errorFlash(req)).toBe('Staff member not found');
  });

  it('the staff show route answers a MISSING record with the same message', () => {
    const req = writeReq({}, { id: '999999' }, STAFF_USER);
    const res = makeRes();

    lastHandlerFor(staffRouter, 'get', '/:id')(req, res);

    expect(errorFlash(req)).toBe('Staff member not found');
  });
});

// ---------------------------------------------------------------------------
// 8. The per-IP login lockout
// ---------------------------------------------------------------------------
describe('code review 381 — the per-IP login lockout', () => {
  const loginHandler = () => lastHandlerFor(authRouter, 'post', '/login');

  let ipCounter = 0;
  function uniqueIp() {
    ipCounter += 1;
    return `203.0.113.${ipCounter + 100}`;
  }

  async function runLogin(body, ip) {
    let redirectedTo = null;
    const flashCalls = [];
    const req = {
      body,
      params: {},
      method: 'POST',
      ip,
      session: { regenerate: (cb) => cb() },
      flash: (type, msg) => flashCalls.push([type, msg])
    };
    const res = {
      redirect: (to) => {
        redirectedTo = to;
      },
      render: () => {},
      status: () => res,
      json: () => {}
    };
    await loginHandler()(req, res, () => {});
    await new Promise((resolve) => setImmediate(resolve));
    return { redirectedTo, flashCalls };
  }

  it('a successful login does NOT clear another account\'s failures at the same source', async () => {
    jest.requireMock('../src/middleware/audit').audit.mockClear();
    const ip = uniqueIp();
    insertUser({
      username: 'victim', password: 'hash', email: 'v@example.com', first_name: 'V', last_name: 'X'
    });
    insertUser({
      username: 'holder', password: 'hash', email: 'h@example.com', first_name: 'H', last_name: 'X'
    });

    // Four failures for 'victim' at this source.
    for (let i = 0; i < 4; i++) {
      await runLogin({ username: 'victim', password: 'wrong-password' }, ip);
    }
    // A successful login for a DIFFERENT account must not reset the shared
    // per-source brake.
    await runLogin({ username: 'holder', password: 'Str0ng!Passw0rd' }, ip);

    // One more failure for 'victim' must therefore still be the fifth, which
    // locks the account: the sixth attempt is blocked.
    await runLogin({ username: 'victim', password: 'wrong-password' }, ip);
    const sixth = await runLogin({ username: 'victim', password: 'wrong-password' }, ip);
    expect(sixth.redirectedTo).toBe('/login');
    const blocked = jest.requireMock('../src/middleware/audit').audit.mock.calls
      .filter((call) => call[0].action === 'login_blocked');
    expect(blocked.length).toBe(1);
  });

  it('the per-source key groups IPv6 clients by their /56 prefix', async () => {
    jest.requireMock('../src/middleware/audit').audit.mockClear();
    const a = '2001:db8:1234:5600::1';
    const b = '2001:db8:1234:5600::2';
    const c = '2001:db8:9999:5600::1';
    const stamp = Date.now();

    // Five DISTINCT accounts from one address of the /56 prefix, so only the
    // per-SOURCE counter can reach the threshold (no single account does).
    for (let i = 0; i < 5; i++) {
      await runLogin({ username: `v6a${i}-${stamp}`, password: 'wrong-password' }, a);
    }
    // A sixth attempt from a DIFFERENT address of the SAME /56 prefix shares
    // the source key, so the source is locked.
    await runLogin({ username: `v6b-${stamp}`, password: 'wrong-password' }, b);
    const blockedSame = jest.requireMock('../src/middleware/audit').audit.mock.calls
      .filter((call) => call[0].action === 'login_blocked').length;
    expect(blockedSame).toBe(1);

    // A different /56 prefix is a different source: it is not locked by the
    // failures recorded for the first prefix.
    jest.requireMock('../src/middleware/audit').audit.mockClear();
    await runLogin({ username: `v6c-${stamp}`, password: 'wrong-password' }, c);
    const blockedOther = jest.requireMock('../src/middleware/audit').audit.mock.calls
      .filter((call) => call[0].action === 'login_blocked').length;
    expect(blockedOther).toBe(0);
  });
});
