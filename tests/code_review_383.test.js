const { describe, it, expect, beforeEach, afterEach } = require('@jest/globals');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Regression tests for review pass 383.
//
// The defects closed by this pass:
//
//  1. The two quick-status routes reported a wrong-TYPED status with the
//     field-specific wording ("Invalid Status" / "Invalid Task Status") while
//     every other route in the app — including the sibling full-update route
//     in the SAME file — answers a wrong-typed body field with the app-wide
//     "Invalid request parameters". The same column, two verdicts.
//
//  2. The knowledge module SILENTLY discarded a non-privileged author's
//     status promotion: the route coerced "published" back to the stored
//     status and flashed "Article updated." / "Article created.", so the
//     author was told their publish had succeeded when nothing was published.
//
//  3. The vendor rating accepted a present-but-whitespace-only value and
//     discarded it without any feedback, while the money fields the README
//     documents it to follow REJECT the identical submission.
//
//  4. The change list applied an `assigned_to` filter to a viewer whose
//     assignee control is not rendered — a filter the viewer could neither
//     see nor clear.
//
//  5. The profile and password routes flashed "An error occurred. Please try
//     again." AFTER the write had already committed, contradicting what
//     happened (and, for the password, inviting a retry with the old
//     password that no longer works).
//
//  6. The knowledge article truncator dropped a COMPLETE entity plus all the
//     text after it, instead of only the partial entity it exists to remove.
//
//  7. The truncation message blamed "removing invalid markup" for an
//     overflow that escaping CAUSED, and the field-precedence comment
//     contradicted the code.
//
//  8. The vendor rename audit entry said "renamed from previous name"
//     without naming the previous name (and omitted the rename entirely when
//     no license references were rewritten).
//
//  9. knowledge.js, changes.js and auth.js hand-rolled the wrong-type guard
//     that the shared findNonStringField() helper already provides, and three
//     unreachable sentinel branches remained in the code.
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
  compare: jest.fn(async () => false),
  hashSync: jest.fn(() => 'hashed-password')
}));

const db = require('../src/models/database');
const authMiddleware = require('../src/middleware/auth');
const changesRouter = require('../src/routes/changes');
const knowledgeRouter = require('../src/routes/knowledge');
const licensesRouter = require('../src/routes/licenses');
const projectsRouter = require('../src/routes/projects');
const staffRouter = require('../src/routes/staff');
const ticketsRouter = require('../src/routes/tickets');
const vendorsRouter = require('../src/routes/vendors');
const authRouter = require('../src/routes/auth');
const { lastHandlerFor } = require('./helpers');
const { validateVendorRating } = require('../src/routes/vendors');
const { sanitizeKnowledgeInput, _truncationMessage } = require('../src/routes/knowledge');

const ADMIN = { id: 1, role: 'admin', first_name: 'Ada', last_name: 'Lovelace' };

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Build a request object for a route handler. */
function writeReq(body, params = {}, user = ADMIN) {
  return {
    query: {},
    body,
    params,
    method: 'PUT',
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
    }
  };
}

/** The first error flashed on the request, or null. */
function errorFlash(req) {
  const call = req.flash.mock.calls.find(([type]) => type === 'error');
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
    DELETE FROM licenses;
    DELETE FROM assets;
    DELETE FROM vendors;
    DELETE FROM users;
    DELETE FROM ticket_counter;
    DELETE FROM asset_counter;
    DELETE FROM audit_log;
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

function insertTicket(row) {
  return db.prepare(`
    INSERT INTO tickets (ticket_number, title, description, category, priority, status, requester_name, requester_email, assigned_to)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.ticket_number,
    row.title || 'A ticket',
    row.description === undefined ? null : row.description,
    row.category || 'hardware',
    row.priority || 'medium',
    row.status || 'open',
    row.requester_name || 'Requester',
    row.requester_email || 'requester@example.com',
    row.assigned_to === undefined ? null : row.assigned_to
  ).lastInsertRowid;
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
    INSERT INTO project_tasks (project_id, title, description, status, priority, assigned_to, due_date)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.project_id,
    row.title || 'A task',
    row.description === undefined ? null : row.description,
    row.status || 'todo',
    row.priority || 'medium',
    row.assigned_to === undefined ? null : row.assigned_to,
    row.due_date === undefined ? null : row.due_date
  ).lastInsertRowid;
}

function insertArticle(row) {
  return db.prepare(`
    INSERT INTO knowledge_articles (title, content, category, tags, author_id, status, is_featured)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.title || 'An article',
    row.content || 'body',
    row.category || 'how_to',
    row.tags === undefined ? null : row.tags,
    row.author_id === undefined ? null : row.author_id,
    row.status || 'draft',
    row.is_featured === undefined ? 0 : row.is_featured
  ).lastInsertRowid;
}

function insertChange(row) {
  return db.prepare(`
    INSERT INTO change_log (title, change_type, status, priority, assigned_to)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    row.title || 'A change',
    row.change_type || 'maintenance',
    row.status || 'scheduled',
    row.priority || 'medium',
    row.assigned_to === undefined ? null : row.assigned_to
  ).lastInsertRowid;
}

function insertVendor(row) {
  return db.prepare(`
    INSERT INTO vendors (name, contact_person, email, phone, address, website, category, notes, rating)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.name || 'ACME',
    row.contact_person === undefined ? null : row.contact_person,
    row.email === undefined ? null : row.email,
    row.phone === undefined ? null : row.phone,
    row.address === undefined ? null : row.address,
    row.website === undefined ? null : row.website,
    row.category === undefined ? null : row.category,
    row.notes === undefined ? null : row.notes,
    row.rating === undefined ? null : row.rating
  ).lastInsertRowid;
}

function insertLicense(row) {
  return db.prepare(`
    INSERT INTO licenses (software_name, vendor, license_key, license_type, total_seats, used_seats, cost)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.software_name || 'MS365',
    row.vendor === undefined ? null : row.vendor,
    row.license_key === undefined ? null : row.license_key,
    row.license_type === undefined ? null : row.license_type,
    row.total_seats === undefined ? 1 : row.total_seats,
    row.used_seats === undefined ? 0 : row.used_seats,
    row.cost === undefined ? null : row.cost
  ).lastInsertRowid;
}

/** Read a file from the repo root. */
function readSrc(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

beforeEach(() => {
  clearTables();
  authMiddleware.canAccessResource.mockImplementation(() => true);
});

afterEach(() => {
  authMiddleware.canAccessResource.mockReset();
  authMiddleware.canAccessResource.mockImplementation(() => true);
});

// ---------------------------------------------------------------------------
// 1. The quick-status routes answer a wrong-typed status with the app-wide
//    type-error wording.
// ---------------------------------------------------------------------------
describe('code review 383 — a wrong-typed status is a type error', () => {
  it('the ticket quick-status route rejects a wrong-typed status with the app-wide wording', () => {
    const handler = lastHandlerFor(ticketsRouter, 'put', '/:id/status');
    const ticketId = insertTicket({ ticket_number: 'TK-3831' });

    const req = writeReq({ status: 42 }, { id: String(ticketId) });
    const res = makeRes();
    handler(req, res, () => {});

    expect(errorFlash(req)).toBe('Invalid request parameters');
    expect(res.redirected).toBe(`/tickets/${ticketId}`);
    // Nothing was written.
    expect(db.prepare('SELECT status FROM tickets WHERE id = ?').get(ticketId).status).toBe('open');
  });

  it('the ticket quick-status route still reports an invalid VALUE with the field-specific wording', () => {
    const handler = lastHandlerFor(ticketsRouter, 'put', '/:id/status');
    const ticketId = insertTicket({ ticket_number: 'TK-3832' });

    const req = writeReq({ status: 'not-a-status' }, { id: String(ticketId) });
    const res = makeRes();
    handler(req, res, () => {});

    expect(errorFlash(req)).toBe('Invalid Status');
    expect(db.prepare('SELECT status FROM tickets WHERE id = ?').get(ticketId).status).toBe('open');
  });

  it('the ticket full-update route answers the same wrong-typed status identically', () => {
    // The two ticket routes carry the SAME column, so the identical
    // submission must produce the identical verdict.
    const fullHandler = lastHandlerFor(ticketsRouter, 'put', '/:id');
    const quickHandler = lastHandlerFor(ticketsRouter, 'put', '/:id/status');
    const ticketId = insertTicket({ ticket_number: 'TK-3833' });

    const fullReq = writeReq({ title: 'T', requester_name: 'R', requester_email: 'r@x.io', status: 42 }, { id: String(ticketId) });
    makeRes();
    fullHandler(fullReq, makeRes(), () => {});
    const fullMessage = errorFlash(fullReq);

    const quickReq = writeReq({ status: 42 }, { id: String(ticketId) });
    quickHandler(quickReq, makeRes(), () => {});
    const quickMessage = errorFlash(quickReq);

    expect(fullMessage).toBe('Invalid request parameters');
    expect(quickMessage).toBe(fullMessage);
  });

  it('the task quick-status branch rejects a wrong-typed status with the app-wide wording', () => {
    const handler = lastHandlerFor(projectsRouter, 'put', '/:projectId/tasks/:taskId');
    const projectId = insertProject({ name: 'CR383 project' });
    const taskId = insertTask({ project_id: projectId, title: 'A task' });

    const req = writeReq({ _quick_status: '1', status: 42 }, { projectId: String(projectId), taskId: String(taskId) });
    const res = makeRes();
    handler(req, res, () => {});

    expect(errorFlash(req)).toBe('Invalid request parameters');
    expect(res.redirected).toBe(`/projects/${projectId}`);
    expect(db.prepare('SELECT status FROM project_tasks WHERE id = ?').get(taskId).status).toBe('todo');
  });

  it('the task quick-status branch still reports an invalid VALUE with the field-specific wording', () => {
    const handler = lastHandlerFor(projectsRouter, 'put', '/:projectId/tasks/:taskId');
    const projectId = insertProject({ name: 'CR383 project 2' });
    const taskId = insertTask({ project_id: projectId, title: 'A task' });

    const req = writeReq({ _quick_status: '1', status: 'bogus' }, { projectId: String(projectId), taskId: String(taskId) });
    makeRes();
    handler(req, makeRes(), () => {});

    expect(errorFlash(req)).toBe('Invalid Task Status');
  });

  it('the task full-update branch answers the same wrong-typed status identically', () => {
    const handler = lastHandlerFor(projectsRouter, 'put', '/:projectId/tasks/:taskId');
    const projectId = insertProject({ name: 'CR383 project 3' });
    const taskId = insertTask({ project_id: projectId, title: 'A task' });

    const quickReq = writeReq({ _quick_status: '1', status: 42 }, { projectId: String(projectId), taskId: String(taskId) });
    handler(quickReq, makeRes(), () => {});
    const quickMessage = errorFlash(quickReq);

    const fullReq = writeReq({ title: 'A task', description: 'd', status: 42 }, { projectId: String(projectId), taskId: String(taskId) });
    handler(fullReq, makeRes(), () => {});
    const fullMessage = errorFlash(fullReq);

    expect(quickMessage).toBe('Invalid request parameters');
    expect(fullMessage).toBe(quickMessage);
  });
});

// ---------------------------------------------------------------------------
// 2. A non-privileged author may not promote an article — and is told so
//    instead of having the promotion silently discarded.
// ---------------------------------------------------------------------------
describe('code review 383 — a forbidden status promotion is rejected, not discarded', () => {
  it('the article create route rejects a non-privileged author publishing an article', () => {
    const handler = lastHandlerFor(knowledgeRouter, 'post', '/');
    const staffId = insertUser({ username: 'bob', email: 'bob@x.io', first_name: 'Bob', last_name: 'Builder', role: 'staff' });

    const req = writeReq(
      { title: 'CR383 article', content: 'body', category: 'how_to', status: 'published' },
      {},
      { id: staffId, role: 'staff', first_name: 'Bob', last_name: 'Builder' }
    );
    const res = makeRes();
    handler(req, res, () => {});

    expect(errorFlash(req)).toBe('Invalid Status');
    expect(res.redirected).toBe('/knowledge/new');
    // Nothing was written — the article was NOT created as a draft behind
    // the author's back.
    expect(db.prepare("SELECT COUNT(*) AS c FROM knowledge_articles WHERE title = 'CR383 article'").get().c).toBe(0);
  });

  it('a non-privileged author may still create a draft article', () => {
    const handler = lastHandlerFor(knowledgeRouter, 'post', '/');
    const staffId = insertUser({ username: 'bob2', email: 'bob2@x.io', first_name: 'Bob', last_name: 'Builder', role: 'staff' });

    const req = writeReq(
      { title: 'CR383 draft article', content: 'body', category: 'how_to', status: 'draft' },
      {},
      { id: staffId, role: 'staff', first_name: 'Bob', last_name: 'Builder' }
    );
    const res = makeRes();
    handler(req, res, () => {});

    expect(errorFlash(req)).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS c FROM knowledge_articles WHERE title = 'CR383 draft article'").get().c).toBe(1);
  });

  it('a privileged user may still publish an article', () => {
    const handler = lastHandlerFor(knowledgeRouter, 'post', '/');
    const adminId = insertUser({ username: 'admin2', email: 'admin2@x.io', first_name: 'Ada', last_name: 'L', role: 'admin' });

    const req = writeReq(
      { title: 'CR383 published article', content: 'body', category: 'how_to', status: 'published' },
      {},
      { id: adminId, role: 'admin', first_name: 'Ada', last_name: 'L' }
    );
    const res = makeRes();
    handler(req, res, () => {});

    expect(errorFlash(req)).toBeNull();
    const row = db.prepare("SELECT status FROM knowledge_articles WHERE title = 'CR383 published article'").get();
    expect(row.status).toBe('published');
  });

  it('the article update route rejects a non-privileged author promoting their article', () => {
    const handler = lastHandlerFor(knowledgeRouter, 'put', '/:id');
    const staffId = insertUser({ username: 'bob3', email: 'bob3@x.io', first_name: 'Bob', last_name: 'Builder', role: 'staff' });
    const articleId = insertArticle({ title: 'CR383 own article', author_id: staffId, status: 'draft' });

    const req = writeReq(
      { title: 'CR383 own article', content: 'body', category: 'how_to', status: 'published' },
      { id: String(articleId) },
      { id: staffId, role: 'staff', first_name: 'Bob', last_name: 'Builder' }
    );
    const res = makeRes();
    handler(req, res, () => {});

    expect(errorFlash(req)).toBe('Invalid Status');
    expect(res.redirected).toBe(`/knowledge/${articleId}/edit`);
    // The status was NOT silently discarded — the request was refused and
    // nothing was written.
    expect(db.prepare('SELECT status FROM knowledge_articles WHERE id = ?').get(articleId).status).toBe('draft');
  });

  it('a non-privileged author may still keep their article published and demote it to draft', () => {
    const handler = lastHandlerFor(knowledgeRouter, 'put', '/:id');
    const staffId = insertUser({ username: 'bob4', email: 'bob4@x.io', first_name: 'Bob', last_name: 'Builder', role: 'staff' });

    // Keeping the current status is permitted.
    const publishedId = insertArticle({ title: 'CR383 published own', author_id: staffId, status: 'published' });
    let req = writeReq(
      { title: 'CR383 published own', content: 'body', category: 'how_to', status: 'published' },
      { id: String(publishedId) },
      { id: staffId, role: 'staff', first_name: 'Bob', last_name: 'Builder' }
    );
    let res = makeRes();
    handler(req, res, () => {});
    expect(errorFlash(req)).toBeNull();
    expect(db.prepare('SELECT status FROM knowledge_articles WHERE id = ?').get(publishedId).status).toBe('published');

    // Demoting to draft is permitted.
    const draftId = insertArticle({ title: 'CR383 demote own', author_id: staffId, status: 'published' });
    req = writeReq(
      { title: 'CR383 demote own', content: 'body', category: 'how_to', status: 'draft' },
      { id: String(draftId) },
      { id: staffId, role: 'staff', first_name: 'Bob', last_name: 'Builder' }
    );
    res = makeRes();
    handler(req, res, () => {});
    expect(errorFlash(req)).toBeNull();
    expect(db.prepare('SELECT status FROM knowledge_articles WHERE id = ?').get(draftId).status).toBe('draft');
  });
});

// ---------------------------------------------------------------------------
// 3. The vendor rating rejects a whitespace-only value like the money fields.
// ---------------------------------------------------------------------------
describe('code review 383 — the vendor rating rejects a whitespace-only value', () => {
  it('the validator rejects a whitespace-only rating', () => {
    expect(validateVendorRating('   ')).toEqual({
      value: null,
      error: 'Rating must be a whole number between 1 and 5'
    });
  });

  it('the create route refuses a whitespace-only rating and stores nothing', () => {
    const handler = lastHandlerFor(vendorsRouter, 'post', '/');
    const req = writeReq({ name: 'CR383 vendor', category: 'hardware', rating: '   ' });
    const res = makeRes();
    handler(req, res, () => {});

    expect(errorFlash(req)).toBe('Rating must be a whole number between 1 and 5');
    expect(res.redirected).toBe('/vendors/new');
    expect(db.prepare("SELECT COUNT(*) AS c FROM vendors WHERE name = 'CR383 vendor'").get().c).toBe(0);
  });

  it('the update route refuses a whitespace-only rating and keeps the stored one', () => {
    const handler = lastHandlerFor(vendorsRouter, 'put', '/:id');
    const vendorId = insertVendor({ name: 'CR383 rated vendor', rating: 4 });

    const req = writeReq({ name: 'CR383 rated vendor', rating: '   ' }, { id: String(vendorId) });
    const res = makeRes();
    handler(req, res, () => {});

    expect(errorFlash(req)).toBe('Rating must be a whole number between 1 and 5');
    expect(res.redirected).toBe(`/vendors/${vendorId}/edit`);
    // The stored rating is untouched — and the operator was told, instead of
    // having their typed value discarded without any feedback.
    expect(db.prepare('SELECT rating FROM vendors WHERE id = ?').get(vendorId).rating).toBe(4);
  });

  it('an EMPTY rating still preserves the stored rating (the documented money-field rule)', () => {
    const handler = lastHandlerFor(vendorsRouter, 'put', '/:id');
    const vendorId = insertVendor({ name: 'CR383 empty rating vendor', rating: 3 });

    const req = writeReq({ name: 'CR383 empty rating vendor', rating: '' }, { id: String(vendorId) });
    makeRes();
    handler(req, makeRes(), () => {});

    expect(errorFlash(req)).toBeNull();
    expect(db.prepare('SELECT rating FROM vendors WHERE id = ?').get(vendorId).rating).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 4. The change list ignores a filter its control does not offer.
// ---------------------------------------------------------------------------
describe('code review 383 — the change list ignores a filter its control hides', () => {
  it('a non-privileged viewer\'s assigned_to filter is ignored', () => {
    const handler = lastHandlerFor(changesRouter, 'get', '/');
    const staffId = insertUser({ username: 'bob5', email: 'bob5@x.io', first_name: 'Bob', last_name: 'Builder', role: 'staff' });
    const otherId = insertUser({ username: 'carol', email: 'carol@x.io', first_name: 'Carol', last_name: 'C', role: 'staff' });
    // A change assigned to the VIEWER: it is theirs and they must still see
    // it. The submitted filter names a colleague — a filter the viewer can
    // neither see (the control is hidden for them) nor clear.
    insertChange({ title: 'CR383 own change', assigned_to: staffId });
    // A change assigned to ANOTHER user: a non-privileged viewer must never
    // see it, whatever the filter says.
    insertChange({ title: 'CR383 other change', assigned_to: otherId });

    const req = writeReq({}, {}, { id: staffId, role: 'staff', first_name: 'Bob', last_name: 'Builder' });
    req.query = { assigned_to: String(otherId) };
    const res = makeRes();
    handler(req, res, () => {});

    expect(res.rendered.view).toBe('pages/changes/index');
    // The hidden filter was ignored: the viewer sees their own change and
    // NOT the colleague's.
    expect(res.rendered.locals.changes.map((c) => c.title)).toEqual(['CR383 own change']);
  });

  it('a privileged viewer\'s assigned_to filter still applies', () => {
    const handler = lastHandlerFor(changesRouter, 'get', '/');
    const otherId = insertUser({ username: 'carol2', email: 'carol2@x.io', first_name: 'Carol', last_name: 'C', role: 'staff' });
    insertChange({ title: 'CR383 carol change', assigned_to: otherId });

    const req = writeReq({}, {}, ADMIN);
    req.query = { assigned_to: String(otherId) };
    const res = makeRes();
    handler(req, res, () => {});

    expect(res.rendered.locals.changes.map((c) => c.title)).toEqual(['CR383 carol change']);
  });
});

// ---------------------------------------------------------------------------
// 5. A write that already committed is not reported as an error.
// ---------------------------------------------------------------------------
describe('code review 383 — a committed write is not reported as a failure', () => {
  it('the password route reports the committed change when the session cannot be renewed', async () => {
    const handler = lastHandlerFor(authRouter, 'put', '/profile/password');
    const userId = insertUser({ username: 'pwuser', email: 'pw@x.io', first_name: 'P', last_name: 'U', role: 'staff' });

    const bcrypt = require('bcryptjs');
    bcrypt.compare.mockResolvedValue(true);
    bcrypt.hash.mockResolvedValue('new-hash');

    const req = writeReq(
      { current_password: 'OldPassword1!', new_password: 'NewPassword1!', confirm_password: 'NewPassword1!' },
      {},
      { id: userId, role: 'staff', first_name: 'P', last_name: 'U' }
    );
    req.session.regenerate = (cb) => cb(new Error('regenerate failed'));
    const res = makeRes();

    await handler(req, res, () => {});

    const err = errorFlash(req);
    // The message must state what actually happened: the password WAS
    // changed, so the old one no longer works.
    expect(err).toMatch(/password was changed/i);
    expect(err).not.toMatch(/^An error occurred/);
    expect(res.redirected).toBe('/login');
  });

  it('the profile route reports the committed change when the session cannot be renewed', async () => {
    const handler = lastHandlerFor(authRouter, 'put', '/profile');
    const userId = insertUser({ username: 'profuser', email: 'prof@x.io', first_name: 'P', last_name: 'U', role: 'staff' });

    const req = writeReq(
      { first_name: 'Renamed', last_name: 'User', email: 'prof@x.io' },
      {},
      { id: userId, role: 'staff', first_name: 'P', last_name: 'U' }
    );
    req.session.regenerate = (cb) => cb(new Error('regenerate failed'));
    const res = makeRes();

    await handler(req, res, () => {});

    const err = errorFlash(req);
    expect(err).toMatch(/profile was updated/i);
    expect(err).not.toMatch(/^An error occurred/);
    expect(res.redirected).toBe('/login');
    // The write really did commit.
    expect(db.prepare('SELECT first_name FROM users WHERE id = ?').get(userId).first_name).toBe('Renamed');
  });
});

// ---------------------------------------------------------------------------
// 6. + 7. The article truncator drops only a PARTIAL entity, and the message
//         names the cause.
// ---------------------------------------------------------------------------
describe('code review 383 — the article truncator drops only a partial entity', () => {
  it('a COMPLETE entity followed by ordinary text is kept intact', () => {
    // The stored form of "R&D budget plan" is "R&amp;D budget plan". Truncating
    // it to 10 characters used to yield "R" — the complete "&amp;" entity and
    // the nine characters after it were all discarded.
    const result = sanitizeKnowledgeInput('title', 'R&D budget plan that is long enough to need truncating here', 'tags');
    expect(result.error).toBeNull();
    // The sanitizer does not cut a complete entity in half.
    expect(result.safeContent).not.toMatch(/&[a-zA-Z]+$/);
  });

  it('a PARTIAL entity is still dropped', () => {
    // 190 x's + "&amp;" sanitizes to 190 x's + "&amp;amp;" (199 chars, over
    // nothing) — the case that produced a trailing "&am".
    const result = sanitizeKnowledgeInput('title', 'x'.repeat(190) + '&amp;', 'tags');
    expect(result.error).toBeNull();
    expect(result.safeContent.endsWith('&am')).toBe(false);
  });

  it('the truncation message does not blame markup removal for an escaping overflow', () => {
    const message = _truncationMessage('content');
    // Escaping GROWS the stored text; markup removal shrinks it. The old
    // wording claimed the opposite.
    expect(message).not.toMatch(/removing invalid markup/i);
    expect(message).toMatch(/escaped/i);
  });

  it('the title and tags messages name their own limits', () => {
    expect(_truncationMessage('title')).toMatch(/Title/);
    expect(_truncationMessage('title')).toMatch(/200/);
    expect(_truncationMessage('tags')).toMatch(/Tags/);
    expect(_truncationMessage('tags')).toMatch(/500/);
  });

  it('the content limit is reported ahead of the title limit', () => {
    // The code checked the title first, so a submission that overflowed BOTH
    // reported the title — contradicting the comment that explained the
    // opposite. The content is the field whose stored form differs from what
    // the author typed, so it is the one reported first.
    const src = readSrc('src/routes/knowledge.js');
    const contentIdx = src.indexOf('if (safeContent.length < cleanContent.length) {');
    const titleIdx = src.indexOf('if (safeTitle.length < cleanTitle.length) {');
    expect(contentIdx).toBeGreaterThan(-1);
    expect(titleIdx).toBeGreaterThan(-1);
    expect(contentIdx).toBeLessThan(titleIdx);
  });
});

// ---------------------------------------------------------------------------
// 8. The vendor rename audit entry names the previous name.
// ---------------------------------------------------------------------------
describe('code review 383 — the vendor rename audit entry names the previous name', () => {
  it('the audit entry names the name the vendor was renamed FROM', () => {
    const handler = lastHandlerFor(vendorsRouter, 'put', '/:id');
    const vendorId = insertVendor({ name: 'CR383 old name' });

    const req = writeReq({ name: 'CR383 new name' }, { id: String(vendorId) });
    makeRes();
    handler(req, makeRes(), () => {});

    const auditCall = req.audit.mock.calls.find(([action]) => action === 'update');
    expect(auditCall).toBeDefined();
    const details = auditCall[3];
    expect(details).toContain('CR383 new name');
    expect(details).toContain('CR383 old name');
  });

  it('the rename is recorded even when no license reference was rewritten', () => {
    const handler = lastHandlerFor(vendorsRouter, 'put', '/:id');
    const vendorId = insertVendor({ name: 'CR383 orphan old' });

    const req = writeReq({ name: 'CR383 orphan new' }, { id: String(vendorId) });
    makeRes();
    handler(req, makeRes(), () => {});

    const auditCall = req.audit.mock.calls.find(([action]) => action === 'update');
    expect(auditCall[3]).toContain('CR383 orphan old');
  });
});

// ---------------------------------------------------------------------------
// 9. The shared wrong-type helper is used by every module that guards a
//    body field, and the unreachable sentinel branches are gone.
// ---------------------------------------------------------------------------
describe('code review 383 — one shared wrong-type guard, no dead sentinels', () => {
  const modules = [
    'src/routes/knowledge.js',
    'src/routes/changes.js',
    'src/routes/auth.js'
  ];

  it('no module hand-rolls the wrong-type loop any more', () => {
    for (const mod of modules) {
      const src = readSrc(mod);
      // The hand-rolled predicate the shared helper replaced.
      expect(src).not.toMatch(/typeof v !== 'string'/);
      expect(src).toContain('findNonStringField');
    }
  });

  it('the unreachable sentinel branches are removed', () => {
    // Each of these sentinels was thrown by a resolveOptionalField error
    // that could never occur: every one of resolveOptionalField's three
    // error classes was already rejected by an earlier guard.
    expect(readSrc('src/routes/vendors.js')).not.toContain("'INVALID_PHONE'");
    expect(readSrc('src/routes/vendors.js')).not.toContain("'INVALID_CATEGORY'");
    expect(readSrc('src/routes/licenses.js')).not.toContain("'INVALID_LICENSE_TYPE'");
    expect(readSrc('src/routes/staff.js')).not.toContain("'INVALID_DEPARTMENT'");
  });

  it('the removed sentinels are still unreachable, so the routes still refuse those inputs', () => {
    // The vendor category: an array, a non-string and a whitespace-only value
    // are each still refused (by the HPP guard, the type guard and the enum
    // guard respectively).
    const handler = lastHandlerFor(vendorsRouter, 'put', '/:id');
    const vendorId = insertVendor({ name: 'CR383 category vendor', category: 'hardware' });

    for (const [value, expected] of [
      [['hardware'], 'Invalid request parameters'],
      [42, 'Invalid request parameters'],
      ['   ', 'Invalid Category']
    ]) {
      const req = writeReq({ name: 'CR383 category vendor', category: value }, { id: String(vendorId) });
      makeRes();
      handler(req, makeRes(), () => {});
      expect(errorFlash(req)).toBe(expected);
    }
    expect(db.prepare('SELECT category FROM vendors WHERE id = ?').get(vendorId).category).toBe('hardware');
  });

  it('the licence type is still refused for every input the removed sentinel covered', () => {
    const handler = lastHandlerFor(licensesRouter, 'put', '/:id');
    const licenseId = insertLicense({ software_name: 'CR383 licence', license_type: 'subscription' });

    for (const [value, expected] of [
      [['subscription'], 'Invalid request parameters'],
      [42, 'Invalid request parameters'],
      ['   ', 'Invalid License Type']
    ]) {
      const req = writeReq({ software_name: 'CR383 licence', license_type: value }, { id: String(licenseId) });
      makeRes();
      handler(req, makeRes(), () => {});
      expect(errorFlash(req)).toBe(expected);
    }
    expect(db.prepare('SELECT license_type FROM licenses WHERE id = ?').get(licenseId).license_type).toBe('subscription');
  });

  it('the staff department is still refused for every input the removed sentinel covered', () => {
    const handler = lastHandlerFor(staffRouter, 'put', '/:id');
    const userId = insertUser({ username: 'deptuser', email: 'dept@x.io', first_name: 'D', last_name: 'U', role: 'staff', department: 'IT' });

    for (const [value, expected] of [
      [['IT'], 'Invalid request parameters'],
      [42, 'Invalid request parameters'],
      ['   ', 'Please enter a valid department']
    ]) {
      const req = writeReq({ email: 'dept@x.io', first_name: 'D', last_name: 'U', department: value }, { id: String(userId) });
      makeRes();
      handler(req, makeRes(), () => {});
      expect(errorFlash(req)).toBe(expected);
    }
    expect(db.prepare('SELECT department FROM users WHERE id = ?').get(userId).department).toBe('IT');
  });
});
