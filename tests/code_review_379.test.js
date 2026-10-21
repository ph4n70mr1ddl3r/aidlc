const { describe, it, expect, beforeEach, afterEach } = require('@jest/globals');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Regression tests for review pass 379.
//
// The defects closed by this pass:
//
//  1. POST /tickets REFUSED an absent `priority` ("Priority is required")
//     while the sibling `status` in the very same route took its documented
//     default — and `tickets.priority` is NOT NULL DEFAULT 'medium'. An API
//     client that submitted only the required fields was refused on tickets
//     and accepted on every other entity.
//
//  2. POST /tickets/:id/comments reported a present-but-non-string comment as
//     "Comment cannot be empty." — a TYPE error reported as a MISSING field.
//     It was the only required-text write route without a type guard.
//
//  3. Four list routes searched the two halves of a name cell the list renders
//     as ONE string, so the name the user could read was unfindable:
//     projects (owner), knowledge (author), staff (name column), and changes
//     (assignee — whose name was not searchable at all).
//
//  4. POST /projects/:id/members refused an absent `role` instead of applying
//     the schema's documented 'member' default, and its stated rationale was
//     inverted ('member' is the LEAST privileged of the three roles).
//
//  5. POST /staff accepted a whitespace-only `department` (storing NULL) that
//     PUT /staff/:id rejected — the same column, two verdicts.
//
//  6. PUT /staff/:id/reset-password reported a present-but-non-string password
//     as "Password is required" — a type error reported as a missing field.
//
//  7. The knowledge EDIT FORM double-escaped the article body: the body is
//     stored entity-escaped (it is rendered as HTML), so rendering it into a
//     plain <textarea> with EJS's escaping showed the author the literal text
//     "a &amp; b" where they had typed "a & b".
//
//  8. The seeder gave the SCHEDULED change-log rows a created_at/updated_at
//     in the FUTURE — a change scheduled five days out cannot have been
//     created three days out.
//
//  9. The ticket form's Related-Asset dropdown was capped at 1000 rows with
//     NO truncation disclosure — the only capped list in the app that
//     truncated silently.
//
// 10. src/routes/changes.js carried an unreachable type-guard loop whose
//     comment claimed the enum resolver used trim() (it never did).
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
  compare: jest.fn(async () => true),
  hashSync: jest.fn(() => 'hashed-password')
}));

const db = require('../src/models/database');
const projectsRouter = require('../src/routes/projects');
const knowledgeRouter = require('../src/routes/knowledge');
const staffRouter = require('../src/routes/staff');
const changesRouter = require('../src/routes/changes');
const ticketsRouter = require('../src/routes/tickets');
const { lastHandlerFor } = require('./helpers');
const { baseLocals, render } = require('./template_helpers');

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
    DELETE FROM assets;
    DELETE FROM users;
    DELETE FROM ticket_counter;
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

function insertTicket(row) {
  const id = db.prepare(`
    INSERT INTO tickets (ticket_number, title, description, category, priority, status, requester_name, requester_email, assigned_to)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.ticket_number || 'TK-20260101-001',
    row.title || 'Test ticket',
    row.description || null,
    row.category || 'hardware',
    row.priority || 'medium',
    row.status || 'open',
    row.requester_name || 'Requester',
    row.requester_email || 'requester@example.com',
    row.assigned_to === undefined ? null : row.assigned_to
  ).lastInsertRowid;
  return id;
}

beforeEach(() => {
  clearTables();
  require('../src/utils').resetCachedStatements();
});

afterEach(() => {
  clearTables();
});

// ---------------------------------------------------------------------------
// 1. POST /tickets — an absent priority takes the documented default
// ---------------------------------------------------------------------------
describe('code review 379 — POST /tickets priority default', () => {
  const createHandler = () => lastHandlerFor(ticketsRouter, 'post', '/');

  it('creates the ticket with the schema default "medium" when the priority is absent', () => {
    const req = writeReq({
      title: 'Printer on fire',
      category: 'hardware',
      requester_name: 'Ada Lovelace',
      requester_email: 'ada@example.com'
    });
    const res = makeRes();

    createHandler()(req, res);

    expect(errorFlash(req)).toBeNull();
    expect(successFlash(req)).toMatch(/created successfully/);
    const row = db.prepare('SELECT priority, status FROM tickets').get();
    expect(row.priority).toBe('medium');
    expect(row.status).toBe('open');
  });

  it('still applies a submitted priority', () => {
    const req = writeReq({
      title: 'Printer on fire',
      category: 'hardware',
      requester_name: 'Ada Lovelace',
      requester_email: 'ada@example.com',
      priority: 'critical'
    });
    const res = makeRes();

    createHandler()(req, res);

    expect(errorFlash(req)).toBeNull();
    expect(db.prepare('SELECT priority FROM tickets').get().priority).toBe('critical');
  });

  it('rejects a present-but-empty priority and writes nothing', () => {
    const req = writeReq({
      title: 'Printer on fire',
      category: 'hardware',
      requester_name: 'Ada Lovelace',
      requester_email: 'ada@example.com',
      priority: ''
    });
    const res = makeRes();

    createHandler()(req, res);

    expect(errorFlash(req)).toBe('Invalid Priority');
    expect(res.redirected).toBe('/tickets/new');
    expect(db.prepare('SELECT COUNT(*) as c FROM tickets').get().c).toBe(0);
  });

  it('rejects a present-but-whitespace-only priority and writes nothing', () => {
    const req = writeReq({
      title: 'Printer on fire',
      category: 'hardware',
      requester_name: 'Ada Lovelace',
      requester_email: 'ada@example.com',
      priority: '   '
    });
    const res = makeRes();

    createHandler()(req, res);

    expect(errorFlash(req)).toBe('Invalid Priority');
    expect(db.prepare('SELECT COUNT(*) as c FROM tickets').get().c).toBe(0);
  });

  it('rejects an unknown priority and writes nothing', () => {
    const req = writeReq({
      title: 'Printer on fire',
      category: 'hardware',
      requester_name: 'Ada Lovelace',
      requester_email: 'ada@example.com',
      priority: 'urgent'
    });
    const res = makeRes();

    createHandler()(req, res);

    expect(errorFlash(req)).toBe('Invalid Priority');
    expect(db.prepare('SELECT COUNT(*) as c FROM tickets').get().c).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. POST /tickets/:id/comments — a non-string comment is a type error
// ---------------------------------------------------------------------------
describe('code review 379 — POST /tickets/:id/comments type guard', () => {
  const commentHandler = () => lastHandlerFor(ticketsRouter, 'post', '/:id/comments');

  it('reports a present-but-non-string comment as "Invalid request parameters"', () => {
    const userId = insertUser({ username: 'ada', email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace', role: 'admin' });
    const ticketId = insertTicket({ assigned_to: userId });
    const req = writeReq({ comment: 42 }, { id: String(ticketId) }, { id: userId, role: 'admin' });
    const res = makeRes();

    commentHandler()(req, res);

    expect(errorFlash(req)).toBe('Invalid request parameters');
    expect(db.prepare('SELECT COUNT(*) as c FROM ticket_comments').get().c).toBe(0);
  });

  it('still reports an absent comment as "Comment cannot be empty."', () => {
    const userId = insertUser({ username: 'ada', email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace', role: 'admin' });
    const ticketId = insertTicket({ assigned_to: userId });
    const req = writeReq({}, { id: String(ticketId) }, { id: userId, role: 'admin' });
    const res = makeRes();

    commentHandler()(req, res);

    expect(errorFlash(req)).toBe('Comment cannot be empty.');
    expect(db.prepare('SELECT COUNT(*) as c FROM ticket_comments').get().c).toBe(0);
  });

  it('still stores a valid comment', () => {
    const userId = insertUser({ username: 'ada', email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace', role: 'admin' });
    const ticketId = insertTicket({ assigned_to: userId });
    const req = writeReq({ comment: 'public note' }, { id: String(ticketId) }, { id: userId, role: 'admin' });
    const res = makeRes();

    commentHandler()(req, res);

    expect(errorFlash(req)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) as c FROM ticket_comments').get().c).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. The rendered name cell is findable (projects / knowledge / staff / changes)
// ---------------------------------------------------------------------------
describe('code review 379 — a name cell rendered as one string is searchable as that string', () => {
  it('finds a project by the owner name the card renders', () => {
    const ownerId = insertUser({ username: 'ada', email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace', role: 'admin' });
    db.prepare("INSERT INTO projects (name, description, status, priority, owner_id) VALUES ('Network upgrade', 'desc', 'planning', 'medium', ?)").run(ownerId);

    const req = listReq({ search: 'Ada Lovelace' });
    const res = makeRes();
    lastHandlerFor(projectsRouter, 'get', '/')(req, res);

    expect(res.rendered.locals.projects.map(p => p.name)).toEqual(['Network upgrade']);
  });

  it('finds a knowledge article by the author name the row renders', () => {
    const authorId = insertUser({ username: 'ada', email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace', role: 'admin' });
    db.prepare("INSERT INTO knowledge_articles (title, content, category, status, author_id) VALUES ('Reset guide', 'body', 'how_to', 'published', ?)").run(authorId);

    const req = listReq({ search: 'Ada Lovelace' });
    const res = makeRes();
    lastHandlerFor(knowledgeRouter, 'get', '/')(req, res);

    expect(res.rendered.locals.articles.map(a => a.title)).toEqual(['Reset guide']);
  });

  it('finds a staff row by the name the directory renders', () => {
    insertUser({ username: 'ada', email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace', role: 'admin' });
    insertUser({ username: 'bob', email: 'bob@example.com', first_name: 'Bob', last_name: 'Smith', role: 'staff' });

    const req = listReq({ search: 'Ada Lovelace' });
    const res = makeRes();
    lastHandlerFor(staffRouter, 'get', '/')(req, res);

    // The row is identified by the name the directory renders. The username
    // itself is redacted from the render context for EVERY row (the directory
    // renders it for nobody) — pass 380 widened pass 373's redaction from
    // "other users" to "everybody", so the row is asserted by name.
    expect(res.rendered.locals.staff.map(s => `${s.first_name} ${s.last_name}`)).toEqual(['Ada Lovelace']);
    expect(res.rendered.locals.staff.map(s => s.username)).toEqual([null]);
  });

  it('finds a change by the assignee name the row renders', () => {
    const ownerId = insertUser({ username: 'ada', email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace', role: 'admin' });
    db.prepare("INSERT INTO change_log (title, description, change_type, status, priority, scheduled_start, assigned_to) VALUES ('Patching', 'desc', 'maintenance', 'scheduled', 'medium', '2030-01-01 10:00', ?)").run(ownerId);

    const req = listReq({ search: 'Ada Lovelace' });
    const res = makeRes();
    lastHandlerFor(changesRouter, 'get', '/')(req, res);

    expect(res.rendered.locals.changes.map(c => c.title)).toEqual(['Patching']);
    // The count query and the listing must agree — the count query needed
    // the same LEFT JOIN once the search reached the assignee's name.
    expect(res.rendered.locals.total).toBe(res.rendered.locals.changes.length);
  });

  it('reports a zero total for a name that matches nothing', () => {
    const ownerId = insertUser({ username: 'ada', email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace', role: 'admin' });
    db.prepare("INSERT INTO change_log (title, description, change_type, status, priority, scheduled_start, assigned_to) VALUES ('Patching', 'desc', 'maintenance', 'scheduled', 'medium', '2030-01-01 10:00', ?)").run(ownerId);

    const req = listReq({ search: 'Grace Hopper' });
    const res = makeRes();
    lastHandlerFor(changesRouter, 'get', '/')(req, res);

    expect(res.rendered.locals.changes).toHaveLength(0);
    expect(res.rendered.locals.total).toBe(0);
  });

  it('keeps the staff directory search from reaching the redacted email for a plain staff viewer', () => {
    const adaId = insertUser({ username: 'ada', email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace', role: 'admin' });
    insertUser({ username: 'bob', email: 'bob@example.com', first_name: 'Bob', last_name: 'Smith', role: 'staff' });

    const req = listReq({ search: 'ada@example.com' }, { id: 999, role: 'staff' });
    const res = makeRes();
    lastHandlerFor(staffRouter, 'get', '/')(req, res);

    expect(res.rendered.locals.staff).toHaveLength(0);
    expect(adaId).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 4. POST /projects/:id/members — an absent role takes the 'member' default
// ---------------------------------------------------------------------------
describe('code review 379 — POST /projects/:id/members role default', () => {
  const addMemberHandler = () => lastHandlerFor(projectsRouter, 'post', '/:id/members');

  function seedProjectAndUser() {
    const ownerId = insertUser({ username: 'ada', email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace', role: 'admin' });
    const memberId = insertUser({ username: 'bob', email: 'bob@example.com', first_name: 'Bob', last_name: 'Smith', role: 'staff' });
    const projectId = db.prepare("INSERT INTO projects (name, status, priority, owner_id) VALUES ('Rollout', 'planning', 'medium', ?)").run(ownerId).lastInsertRowid;
    return { projectId, memberId };
  }

  it('adds the member with the schema default "member" when the role is absent', () => {
    const { projectId, memberId } = seedProjectAndUser();
    const req = writeReq({ user_id: String(memberId) }, { id: String(projectId) });
    const res = makeRes();

    addMemberHandler()(req, res);

    expect(errorFlash(req)).toBeNull();
    const row = db.prepare('SELECT role FROM project_members WHERE user_id = ?').get(memberId);
    expect(row.role).toBe('member');
  });

  it('still applies a submitted role', () => {
    const { projectId, memberId } = seedProjectAndUser();
    const req = writeReq({ user_id: String(memberId), role: 'lead' }, { id: String(projectId) });
    const res = makeRes();

    addMemberHandler()(req, res);

    expect(errorFlash(req)).toBeNull();
    expect(db.prepare('SELECT role FROM project_members WHERE user_id = ?').get(memberId).role).toBe('lead');
  });

  it('rejects an unknown role and adds nobody', () => {
    const { projectId, memberId } = seedProjectAndUser();
    const req = writeReq({ user_id: String(memberId), role: 'owner' }, { id: String(projectId) });
    const res = makeRes();

    addMemberHandler()(req, res);

    expect(errorFlash(req)).toBe('Invalid Role');
    expect(db.prepare('SELECT COUNT(*) as c FROM project_members').get().c).toBe(0);
  });

  it('rejects a whitespace-only role and adds nobody', () => {
    const { projectId, memberId } = seedProjectAndUser();
    const req = writeReq({ user_id: String(memberId), role: '   ' }, { id: String(projectId) });
    const res = makeRes();

    addMemberHandler()(req, res);

    expect(errorFlash(req)).toBe('Invalid Role');
    expect(db.prepare('SELECT COUNT(*) as c FROM project_members').get().c).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. POST /staff — a whitespace-only department is rejected
// ---------------------------------------------------------------------------
describe('code review 379 — POST /staff department validation', () => {
  const createStaffHandler = () => lastHandlerFor(staffRouter, 'post', '/');

  function baseBody(extra) {
    return Object.assign({
      username: 'newuser',
      password: 'Str0ng!Passw0rd',
      email: 'new@example.com',
      first_name: 'New',
      last_name: 'User',
      role: 'staff'
    }, extra);
  }

  it('rejects a whitespace-only department (the update route already did)', async () => {
    const req = writeReq(baseBody({ department: '   ' }));
    const res = makeRes();

    await createStaffHandler()(req, res);

    expect(errorFlash(req)).toBe('Please enter a valid department');
    expect(res.redirected).toBe('/staff/new');
    expect(db.prepare('SELECT COUNT(*) as c FROM users').get().c).toBe(0);
  });

  it('rejects a present-but-non-string department', async () => {
    const req = writeReq(baseBody({ department: 42 }));
    const res = makeRes();

    await createStaffHandler()(req, res);

    expect(errorFlash(req)).toBe('Invalid Department');
    expect(db.prepare('SELECT COUNT(*) as c FROM users').get().c).toBe(0);
  });

  it('still accepts an absent department (stored as the schema default)', async () => {
    const req = writeReq(baseBody());
    const res = makeRes();

    await createStaffHandler()(req, res);

    expect(errorFlash(req)).toBeNull();
    const row = db.prepare("SELECT department FROM users WHERE username = 'newuser'").get();
    // `users.department` is `TEXT DEFAULT 'IT'`. The create route writes the
    // column explicitly, so the schema default could never fire and an
    // absent department landed in NULL — rendered as "-" in the directory
    // and matched by NO department filter. Pass 380 applies the documented
    // default instead, like every other entity's absent create field.
    expect(row.department).toBe('IT');
  });

  it('still accepts a real department', async () => {
    const req = writeReq(baseBody({ department: 'Finance' }));
    const res = makeRes();

    await createStaffHandler()(req, res);

    expect(errorFlash(req)).toBeNull();
    expect(db.prepare("SELECT department FROM users WHERE username = 'newuser'").get().department).toBe('Finance');
  });
});

// ---------------------------------------------------------------------------
// 6. PUT /staff/:id/reset-password — a non-string password is a type error
// ---------------------------------------------------------------------------
describe('code review 379 — PUT /staff/:id/reset-password type guard', () => {
  const resetHandler = () => lastHandlerFor(staffRouter, 'put', '/:id/reset-password');

  it('reports a present-but-non-string new password as "Invalid request parameters"', async () => {
    const targetId = insertUser({ username: 'bob', email: 'bob@example.com', first_name: 'Bob', last_name: 'Smith', role: 'staff' });
    const req = writeReq({ new_password: 12345678, current_password: 'Str0ng!Passw0rd' }, { id: String(targetId) });
    const res = makeRes();

    await resetHandler()(req, res);

    expect(errorFlash(req)).toBe('Invalid request parameters');
  });

  it('reports a present-but-non-string current password as "Invalid request parameters"', async () => {
    const targetId = insertUser({ username: 'bob', email: 'bob@example.com', first_name: 'Bob', last_name: 'Smith', role: 'staff' });
    const req = writeReq({ new_password: 'Str0ng!Passw0rd', current_password: 42 }, { id: String(targetId) });
    const res = makeRes();

    await resetHandler()(req, res);

    expect(errorFlash(req)).toBe('Invalid request parameters');
  });

  it('still reports an absent new password as "Password is required"', async () => {
    const targetId = insertUser({ username: 'bob', email: 'bob@example.com', first_name: 'Bob', last_name: 'Smith', role: 'staff' });
    const req = writeReq({ current_password: 'Str0ng!Passw0rd' }, { id: String(targetId) });
    const res = makeRes();

    await resetHandler()(req, res);

    expect(errorFlash(req)).toBe('Password is required');
  });
});

// ---------------------------------------------------------------------------
// 7. The knowledge edit form shows the author's body text
// ---------------------------------------------------------------------------
describe('code review 379 — knowledge edit form does not double-escape the body', () => {
  const editHandler = () => lastHandlerFor(knowledgeRouter, 'get', '/:id/edit');

  it('decodes the entity-escaped body for the textarea only', () => {
    const authorId = insertUser({ username: 'ada', email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace', role: 'admin' });
    const articleId = db.prepare(`
      INSERT INTO knowledge_articles (title, content, category, status, author_id)
      VALUES ('Reset guide', 'Reset the &quot;server&quot; &amp; restart', 'how_to', 'published', ?)
    `).run(authorId).lastInsertRowid;

    const req = listReq({}, { id: authorId, role: 'admin' });
    req.params = { id: String(articleId) };
    const res = makeRes();

    editHandler()(req, res);

    const locals = res.rendered.locals;
    expect(locals.article.content).toBe('Reset the "server" & restart');
    // The stored row is untouched — only the FORM copy is decoded.
    expect(db.prepare('SELECT content FROM knowledge_articles WHERE id = ?').get(articleId).content)
      .toBe('Reset the &quot;server&quot; &amp; restart');
  });

  it('renders the decoded body in the textarea (not the escaped form)', () => {
    const authorId = insertUser({ username: 'ada', email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace', role: 'admin' });
    const articleId = db.prepare(`
      INSERT INTO knowledge_articles (title, content, category, status, author_id)
      VALUES ('Reset guide', 'Reset the &quot;server&quot; &amp; restart', 'how_to', 'published', ?)
    `).run(authorId).lastInsertRowid;

    const req = listReq({}, { id: authorId, role: 'admin' });
    req.params = { id: String(articleId) };
    const res = makeRes();
    editHandler()(req, res);

    const html = render('knowledge/form.ejs', Object.assign(baseLocals(), res.rendered.locals));
    // The browser shows the author's own text; the raw HTML carries the
    // single escaping EJS applies, not a doubly-escaped "&amp;amp;".
    expect(html).toContain('Reset the &#34;server&#34; &amp; restart');
    expect(html).not.toContain('&amp;amp;');
  });
});

// ---------------------------------------------------------------------------
// 9. The ticket form's asset dropdown discloses its cap
// ---------------------------------------------------------------------------
describe('code review 379 — ticket form asset dropdown discloses its cap', () => {
  const newFormHandler = () => lastHandlerFor(ticketsRouter, 'get', '/new');

  function insertAssets(count) {
    const stmt = db.prepare(`
      INSERT INTO assets (asset_tag, name, category, status) VALUES (?, ?, 'laptop', 'in_use')
    `);
    for (let i = 1; i <= count; i++) {
      stmt.run(`AST-${String(i).padStart(4, '0')}`, `Laptop ${String(i).padStart(4, '0')}`);
    }
  }

  it('marks the dropdown as truncated and reports the total when the cap is exceeded', () => {
    insertAssets(1001);
    const req = listReq({});
    const res = makeRes();

    newFormHandler()(req, res);

    const locals = res.rendered.locals;
    expect(locals.assetsTruncated).toBe(true);
    expect(locals.assetsTotal).toBe(1001);
    expect(locals.assets).toHaveLength(1000);
  });

  it('does NOT mark a dropdown that holds exactly the cap as truncated', () => {
    insertAssets(1000);
    const req = listReq({});
    const res = makeRes();

    newFormHandler()(req, res);

    const locals = res.rendered.locals;
    expect(locals.assetsTruncated).toBe(false);
    expect(locals.assetsTotal).toBe(1000);
    expect(locals.assets).toHaveLength(1000);
  });

  it('renders the disclosure note on the form', () => {
    insertAssets(1001);
    const req = listReq({});
    const res = makeRes();
    newFormHandler()(req, res);

    const html = render('tickets/form.ejs', Object.assign(baseLocals(), res.rendered.locals));
    expect(html).toContain('Showing 1000 of 1001 assets');
  });

  it('renders no disclosure note when the list is complete', () => {
    insertAssets(3);
    const req = listReq({});
    const res = makeRes();
    newFormHandler()(req, res);

    const html = render('tickets/form.ejs', Object.assign(baseLocals(), res.rendered.locals));
    expect(html).not.toContain('assets (listed by name)');
  });
});

// ---------------------------------------------------------------------------
// 10. The changes UPDATE route still rejects a present non-string enum
// ---------------------------------------------------------------------------
describe('code review 379 — changes update still rejects a non-string enum', () => {
  const updateHandler = () => lastHandlerFor(changesRouter, 'put', '/:id');

  function seedChange() {
    const ownerId = insertUser({ username: 'ada', email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace', role: 'admin' });
    const id = db.prepare(`
      INSERT INTO change_log (title, change_type, status, priority, assigned_to)
      VALUES ('Patching', 'maintenance', 'scheduled', 'high', ?)
    `).run(ownerId).lastInsertRowid;
    return id;
  }

  it('rejects a present-but-non-string status', () => {
    const id = seedChange();
    const req = writeReq({ status: 42 }, { id: String(id) });
    const res = makeRes();

    updateHandler()(req, res);

    expect(errorFlash(req)).toBe('Invalid request parameters');
    expect(db.prepare('SELECT status FROM change_log WHERE id = ?').get(id).status).toBe('scheduled');
  });

  it('rejects a present-but-non-string priority', () => {
    const id = seedChange();
    const req = writeReq({ priority: 42 }, { id: String(id) });
    const res = makeRes();

    updateHandler()(req, res);

    expect(errorFlash(req)).toBe('Invalid request parameters');
    expect(db.prepare('SELECT priority FROM change_log WHERE id = ?').get(id).priority).toBe('high');
  });
});

// ---------------------------------------------------------------------------
// 8. The seeder never writes a change-log row created in the future
// ---------------------------------------------------------------------------
describe('code review 379 — seeded change-log timestamps are not in the future', () => {
  function readSchemaSQL() {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'models', 'database.js'), 'utf8');
    const match = src.match(/db\.exec\(\s*`([\s\S]*?)`\s*\)/);
    if (!match) {
      throw new Error('Could not find initSchema SQL in database.js');
    }
    return match[1];
  }

  it('never stamps a change row with a created_at/updated_at after its scheduled_start', () => {
    const Database = require('better-sqlite3');
    const seedDb = new Database(':memory:');
    seedDb.pragma('foreign_keys = ON');
    seedDb.exec(readSchemaSQL());
    const { runSeed } = require('../src/seed');
    runSeed(seedDb, 'AdminPassword123!', 'StaffPassword123!');

    const rows = seedDb.prepare('SELECT title, status, created_at, updated_at, scheduled_start, actual_end FROM change_log').all();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // A record can never be created after it was last updated.
      expect(row.created_at <= row.updated_at).toBe(true);
      // ...nor after the moment it records.
      if (row.scheduled_start) {
        expect(row.created_at <= row.scheduled_start).toBe(true);
      }
      // A SCHEDULED change is still in the future, so it cannot have been
      // updated after its own start either. (A COMPLETED change legitimately
      // is: it was updated when the work actually finished.)
      if (row.status === 'scheduled' && row.scheduled_start) {
        expect(row.updated_at <= row.scheduled_start).toBe(true);
      }
      if (row.actual_end) {
        expect(row.updated_at <= row.actual_end).toBe(true);
      }
    }
    seedDb.close();
  });
});
