const { describe, it, expect, beforeEach, afterEach } = require('@jest/globals');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Regression tests for review pass 382.
//
// The defects closed by this pass:
//
//  1. The ticket and project routes still answered a REFUSED view with a
//     permission-specific message ("You do not have permission to view this
//     …") while a MISSING record answered "… not found" — an existence
//     oracle. Four of the six show routes (assets, staff, changes,
//     knowledge) already answered both branches identically, and the README
//     documents the rule app-wide ("a record the viewer may not open is
//     reported exactly like a record that does not exist"), so the ticket
//     show/edit/update/quick-status/comment routes and the project show
//     route were the remaining exceptions.
//
//  2. The staff department was the app's last plain-text field whose
//     wrong-TYPED value was reported with a field-specific message
//     ("Invalid Department") instead of the app-wide "Invalid request
//     parameters" the README's partial-update contract prescribes for a
//     type error. The field-specific wording is reserved for an invalid
//     VALUE.
//
//  3. The money and seat form controls declared an upper bound the routes
//     never enforced: an HTML `max` attribute is a client-side hint only, so
//     an API client stored a 250,000,000 purchase price, a 200,000,000
//     project budget and 2,000,000 licence seats with a success flash —
//     values the UI refuses to accept. The bound is now enforced on the
//     write routes and shared through one constant.
//
//  4. Four form controls under-declared the rule their route enforces: the
//     username input declared the maximum but not the minimum or the
//     character class, the asset-tag input declared the length but not the
//     AST-XXX format, the website input accepted any absolute URL while the
//     route accepts only http/https, and the `type="email"` inputs accepted
//     a dot-less domain the route rejects.
//
//  5. The staff form's "Deactivate Account" confirmation named one of the
//     five effects the route performs.
//
//  6. vendors.js carried an unreachable copy of the app-wide wrong-type
//     guard, with a stale field-specific message.
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
const assetsRouter = require('../src/routes/assets');
const licensesRouter = require('../src/routes/licenses');
const projectsRouter = require('../src/routes/projects');
const staffRouter = require('../src/routes/staff');
const ticketsRouter = require('../src/routes/tickets');
const vendorsRouter = require('../src/routes/vendors');
const { lastHandlerFor } = require('./helpers');
const { MAX_MONEY_AMOUNT, MAX_SEAT_COUNT } = require('../src/constants');

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const ADMIN = { id: 1, role: 'admin', first_name: 'Ada', last_name: 'Lovelace' };

/** Build a request object for a route handler. */
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

function insertAsset(row) {
  return db.prepare(`
    INSERT INTO assets (asset_tag, name, manufacturer, category, status, assigned_to, purchase_price)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.asset_tag,
    row.name,
    row.manufacturer === undefined ? null : row.manufacturer,
    row.category || 'laptop',
    row.status || 'in_storage',
    row.assigned_to === undefined ? null : row.assigned_to,
    row.purchase_price === undefined ? null : row.purchase_price
  ).lastInsertRowid;
}

function insertLicense(row) {
  return db.prepare(`
    INSERT INTO licenses (software_name, vendor, license_key, license_type, total_seats, used_seats, cost)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.software_name,
    row.vendor === undefined ? null : row.vendor,
    row.license_key === undefined ? null : row.license_key,
    row.license_type === undefined ? null : row.license_type,
    row.total_seats === undefined ? 1 : row.total_seats,
    row.used_seats === undefined ? 0 : row.used_seats,
    row.cost === undefined ? null : row.cost
  ).lastInsertRowid;
}

/** Read a view template from disk. */
function readView(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', 'views', relativePath), 'utf8');
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
// 1. The ticket and project routes answer a refusal exactly like a missing
//    record (the README's app-wide "Non-enumerating errors" rule).
// ---------------------------------------------------------------------------
describe('non-enumerating denials — tickets and projects', () => {
  it('the ticket show route answers a refusal exactly like a missing record', () => {
    const handler = lastHandlerFor(ticketsRouter, 'get', '/:id');
    const ticketId = insertTicket({ ticket_number: 'TK-0001' });

    // Missing record.
    let req = writeReq({}, { id: '999999' });
    let res = makeRes();
    handler(req, res, () => {});
    const missingMessage = errorFlash(req);

    // Refused record.
    authMiddleware.canAccessResource.mockImplementation(() => false);
    req = writeReq({}, { id: String(ticketId) });
    res = makeRes();
    handler(req, res, () => {});
    const deniedMessage = errorFlash(req);

    expect(missingMessage).toBe('Ticket not found');
    expect(deniedMessage).toBe(missingMessage);
    expect(req.audit).toHaveBeenCalledWith('access_denied', 'ticket', ticketId, expect.stringContaining('Unauthorized view attempt'));
  });

  it('the ticket edit route answers a refusal exactly like a missing record', () => {
    const handler = lastHandlerFor(ticketsRouter, 'get', '/:id/edit');
    const ticketId = insertTicket({ ticket_number: 'TK-0002' });

    let req = writeReq({}, { id: '999999' });
    let res = makeRes();
    handler(req, res, () => {});
    const missingMessage = errorFlash(req);

    authMiddleware.canAccessResource.mockImplementation(() => false);
    req = writeReq({}, { id: String(ticketId) });
    res = makeRes();
    handler(req, res, () => {});
    const deniedMessage = errorFlash(req);

    expect(missingMessage).toBe('Ticket not found');
    expect(deniedMessage).toBe(missingMessage);
  });

  it('the ticket update route answers a refusal exactly like a missing record', () => {
    const handler = lastHandlerFor(ticketsRouter, 'put', '/:id');
    const ticketId = insertTicket({ ticket_number: 'TK-0003' });

    let req = writeReq({ title: 'Renamed' }, { id: '999999' });
    let res = makeRes();
    handler(req, res, () => {});
    const missingMessage = errorFlash(req);

    authMiddleware.canAccessResource.mockImplementation(() => false);
    req = writeReq({ title: 'Renamed' }, { id: String(ticketId) });
    res = makeRes();
    handler(req, res, () => {});
    const deniedMessage = errorFlash(req);

    expect(missingMessage).toBe('Ticket not found');
    expect(deniedMessage).toBe(missingMessage);
    // Nothing was written.
    expect(db.prepare('SELECT title FROM tickets WHERE id = ?').get(ticketId).title).toBe('A ticket');
  });

  it('the ticket quick-status route answers a refusal exactly like a missing record', () => {
    const handler = lastHandlerFor(ticketsRouter, 'put', '/:id/status');
    const ticketId = insertTicket({ ticket_number: 'TK-0004' });

    let req = writeReq({ status: 'open' }, { id: '999999' });
    let res = makeRes();
    handler(req, res, () => {});
    const missingMessage = errorFlash(req);

    authMiddleware.canAccessResource.mockImplementation(() => false);
    req = writeReq({ status: 'open' }, { id: String(ticketId) });
    res = makeRes();
    handler(req, res, () => {});
    const deniedMessage = errorFlash(req);

    expect(missingMessage).toBe('Ticket not found');
    expect(deniedMessage).toBe(missingMessage);
  });

  it('the ticket comment route answers a refusal exactly like a missing record', () => {
    const handler = lastHandlerFor(ticketsRouter, 'post', '/:id/comments');
    const userId = insertUser({ username: 'commenter', email: 'c@example.com', first_name: 'C', last_name: 'O' });
    const ticketId = insertTicket({ ticket_number: 'TK-0005' });

    let req = writeReq({ comment: 'hello' }, { id: '999999' }, { id: userId, role: 'staff' });
    let res = makeRes();
    handler(req, res, () => {});
    const missingMessage = errorFlash(req);

    authMiddleware.canAccessResource.mockImplementation(() => false);
    req = writeReq({ comment: 'hello' }, { id: String(ticketId) }, { id: userId, role: 'staff' });
    res = makeRes();
    handler(req, res, () => {});
    const deniedMessage = errorFlash(req);

    expect(missingMessage).toBe('Ticket not found');
    expect(deniedMessage).toBe(missingMessage);
    expect(db.prepare('SELECT COUNT(*) as c FROM ticket_comments').get().c).toBe(0);
  });

  it('the project show route answers a refusal exactly like a missing record', () => {
    const handler = lastHandlerFor(projectsRouter, 'get', '/:id');
    const projectId = insertProject({ name: 'A project' });

    let req = writeReq({}, { id: '999999' });
    let res = makeRes();
    handler(req, res, () => {});
    const missingMessage = errorFlash(req);

    authMiddleware.canAccessResource.mockImplementation(() => false);
    req = writeReq({}, { id: String(projectId) });
    res = makeRes();
    handler(req, res, () => {});
    const deniedMessage = errorFlash(req);

    expect(missingMessage).toBe('Project not found');
    expect(deniedMessage).toBe(missingMessage);
    expect(req.audit).toHaveBeenCalledWith('access_denied', 'project', projectId, expect.stringContaining('Unauthorized view attempt'));
  });

  it('no route module still uses a permission-specific denial message', () => {
    const routesDir = path.join(__dirname, '..', 'src', 'routes');
    const files = fs.readdirSync(routesDir).filter((f) => f.endsWith('.js'));
    for (const file of files) {
      const src = fs.readFileSync(path.join(routesDir, file), 'utf8');
      expect(src).not.toMatch(/req\.flash\('error', 'You do not have permission/);
      expect(src).not.toMatch(/req\.flash\('error', 'You can only (edit|update|comment)/);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The staff department's wrong-typed value answers the app-wide wording.
// ---------------------------------------------------------------------------
describe('staff department — wrong type answers the app-wide type error', () => {
  it('the create route reports a wrong-typed department as a type error', async () => {
    const handler = lastHandlerFor(staffRouter, 'post', '/');
    const req = writeReq({
      username: 'newuser', password: 'Str0ng!Passw0rd', email: 'new@example.com',
      first_name: 'New', last_name: 'User', role: 'staff', department: 42
    });
    const res = makeRes();

    await handler(req, res);

    expect(errorFlash(req)).toBe('Invalid request parameters');
    expect(db.prepare('SELECT COUNT(*) as c FROM users').get().c).toBe(0);
  });

  it('the update route reports a wrong-typed department as a type error', () => {
    const handler = lastHandlerFor(staffRouter, 'put', '/:id');
    const userId = insertUser({ username: 'deptuser', email: 'd@example.com', first_name: 'D', last_name: 'U', department: 'Ops' });
    const req = writeReq({
      email: 'd@example.com', first_name: 'D', last_name: 'U', role: 'staff', department: 42
    }, { id: String(userId) });
    const res = makeRes();

    handler(req, res, () => {});

    expect(errorFlash(req)).toBe('Invalid request parameters');
    expect(db.prepare('SELECT department FROM users WHERE id = ?').get(userId).department).toBe('Ops');
  });

  it('a whitespace-only department still answers the field-specific message', async () => {
    const handler = lastHandlerFor(staffRouter, 'post', '/');
    const req = writeReq({
      username: 'newuser', password: 'Str0ng!Passw0rd', email: 'new@example.com',
      first_name: 'New', last_name: 'User', role: 'staff', department: '   '
    });
    const res = makeRes();

    await handler(req, res);

    expect(errorFlash(req)).toBe('Please enter a valid department');
  });
});

// ---------------------------------------------------------------------------
// 3. The money and seat bounds the forms declare are enforced on the routes.
// ---------------------------------------------------------------------------
describe('money and seat bounds are enforced server-side', () => {
  it('the asset create route rejects a price above the declared bound', () => {
    const handler = lastHandlerFor(assetsRouter, 'post', '/');
    const req = writeReq({ name: 'Big', category: 'laptop', purchase_price: '250000000' });
    const res = makeRes();

    handler(req, res, () => {});

    expect(errorFlash(req)).toBe(`Purchase Price must be at most ${MAX_MONEY_AMOUNT}`);
    expect(db.prepare('SELECT COUNT(*) as c FROM assets').get().c).toBe(0);
  });

  it('the asset create route still accepts a price inside the bound', () => {
    const handler = lastHandlerFor(assetsRouter, 'post', '/');
    const req = writeReq({ name: 'Sane', category: 'laptop', purchase_price: '1234.56' });
    const res = makeRes();

    handler(req, res, () => {});

    expect(errorFlash(req)).toBe(null);
    expect(successFlash(req)).toContain('created successfully');
    expect(db.prepare('SELECT purchase_price FROM assets WHERE name = ?').get('Sane').purchase_price).toBeCloseTo(1234.56, 2);
  });

  it('the asset update route rejects a price above the declared bound', () => {
    const handler = lastHandlerFor(assetsRouter, 'put', '/:id');
    const assetId = insertAsset({ asset_tag: 'AST-001', name: 'Existing', purchase_price: 100 });
    const req = writeReq({ purchase_price: '250000000' }, { id: String(assetId) });
    const res = makeRes();

    handler(req, res, () => {});

    expect(errorFlash(req)).toBe(`Purchase Price must be at most ${MAX_MONEY_AMOUNT}`);
    expect(db.prepare('SELECT purchase_price FROM assets WHERE id = ?').get(assetId).purchase_price).toBe(100);
  });

  it('the project create route rejects a budget above the declared bound', () => {
    const handler = lastHandlerFor(projectsRouter, 'post', '/');
    const req = writeReq({ name: 'Big project', budget: '200000000' });
    const res = makeRes();

    handler(req, res, () => {});

    expect(errorFlash(req)).toBe(`Budget must be at most ${MAX_MONEY_AMOUNT}`);
    expect(db.prepare('SELECT COUNT(*) as c FROM projects').get().c).toBe(0);
  });

  it('the project create route rejects a spent amount above the declared bound', () => {
    const handler = lastHandlerFor(projectsRouter, 'post', '/');
    const req = writeReq({ name: 'Big project', spent: '200000000' });
    const res = makeRes();

    handler(req, res, () => {});

    expect(errorFlash(req)).toBe(`Spent Amount must be at most ${MAX_MONEY_AMOUNT}`);
    expect(db.prepare('SELECT COUNT(*) as c FROM projects').get().c).toBe(0);
  });

  it('the project update route rejects a budget above the declared bound', () => {
    const handler = lastHandlerFor(projectsRouter, 'put', '/:id');
    const projectId = insertProject({ name: 'Existing', budget: 100 });
    const req = writeReq({ budget: '200000000' }, { id: String(projectId) });
    const res = makeRes();

    handler(req, res, () => {});

    expect(errorFlash(req)).toBe(`Budget must be at most ${MAX_MONEY_AMOUNT}`);
    expect(db.prepare('SELECT budget FROM projects WHERE id = ?').get(projectId).budget).toBe(100);
  });

  it('the project update route rejects a spent amount above the declared bound', () => {
    const handler = lastHandlerFor(projectsRouter, 'put', '/:id');
    const projectId = insertProject({ name: 'Existing', spent: 100 });
    const req = writeReq({ spent: '200000000' }, { id: String(projectId) });
    const res = makeRes();

    handler(req, res, () => {});

    expect(errorFlash(req)).toBe(`Spent Amount must be at most ${MAX_MONEY_AMOUNT}`);
    expect(db.prepare('SELECT spent FROM projects WHERE id = ?').get(projectId).spent).toBe(100);
  });

  it('the licence create route rejects a cost above the declared bound', () => {
    const handler = lastHandlerFor(licensesRouter, 'post', '/');
    const req = writeReq({ software_name: 'Big licence', cost: '250000000' });
    const res = makeRes();

    handler(req, res, () => {});

    expect(errorFlash(req)).toBe(`Cost must be at most ${MAX_MONEY_AMOUNT}`);
    expect(db.prepare('SELECT COUNT(*) as c FROM licenses').get().c).toBe(0);
  });

  it('the licence update route rejects a cost above the declared bound', () => {
    const handler = lastHandlerFor(licensesRouter, 'put', '/:id');
    const licenseId = insertLicense({ software_name: 'Existing', cost: 100 });
    const req = writeReq({ cost: '250000000' }, { id: String(licenseId) });
    const res = makeRes();

    handler(req, res, () => {});

    expect(errorFlash(req)).toBe(`Cost must be at most ${MAX_MONEY_AMOUNT}`);
    expect(db.prepare('SELECT cost FROM licenses WHERE id = ?').get(licenseId).cost).toBe(100);
  });

  it('the licence create route rejects a seat count above the declared bound', () => {
    const handler = lastHandlerFor(licensesRouter, 'post', '/');
    const req = writeReq({ software_name: 'Big licence', total_seats: '2000000' });
    const res = makeRes();

    handler(req, res, () => {});

    expect(errorFlash(req)).toBe(`Total Seats must be at most ${MAX_SEAT_COUNT}`);
    expect(db.prepare('SELECT COUNT(*) as c FROM licenses').get().c).toBe(0);
  });

  it('the licence create route rejects a used-seat count above the declared bound', () => {
    const handler = lastHandlerFor(licensesRouter, 'post', '/');
    const req = writeReq({ software_name: 'Big licence', total_seats: '500', used_seats: '2000000' });
    const res = makeRes();

    handler(req, res, () => {});

    expect(errorFlash(req)).toBe(`Used Seats must be at most ${MAX_SEAT_COUNT}`);
    expect(db.prepare('SELECT COUNT(*) as c FROM licenses').get().c).toBe(0);
  });

  it('the licence update route rejects a seat count above the declared bound', () => {
    const handler = lastHandlerFor(licensesRouter, 'put', '/:id');
    const licenseId = insertLicense({ software_name: 'Existing', total_seats: 10, used_seats: 1 });
    const req = writeReq({ total_seats: '2000000' }, { id: String(licenseId) });
    const res = makeRes();

    handler(req, res, () => {});

    expect(errorFlash(req)).toBe(`Total Seats must be at most ${MAX_SEAT_COUNT}`);
    expect(db.prepare('SELECT total_seats FROM licenses WHERE id = ?').get(licenseId).total_seats).toBe(10);
  });

  it('a seat count inside the bound is still accepted', () => {
    const handler = lastHandlerFor(licensesRouter, 'post', '/');
    const req = writeReq({ software_name: 'Sane licence', total_seats: '500', used_seats: '42' });
    const res = makeRes();

    handler(req, res, () => {});

    expect(errorFlash(req)).toBe(null);
    expect(successFlash(req)).toContain('created');
    const row = db.prepare('SELECT total_seats, used_seats FROM licenses WHERE software_name = ?').get('Sane licence');
    expect(row.total_seats).toBe(500);
    expect(row.used_seats).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// 4. The form controls declare the rule their route enforces.
// ---------------------------------------------------------------------------
describe('form controls mirror the rules the routes enforce', () => {
  it('the money inputs declare the shared bound instead of a literal', () => {
    for (const file of ['pages/assets/form.ejs', 'pages/projects/form.ejs', 'pages/licenses/form.ejs']) {
      const src = readView(file);
      expect(src).toContain('max="<%= CONSTANTS.MAX_MONEY_AMOUNT %>"');
      // The old hard-coded literal must be gone — it was the only place the
      // bound was declared, and it was never enforced.
      expect(src).not.toContain('99999999.99');
    }
  });

  it('the seat inputs declare the shared bound instead of a literal', () => {
    const src = readView('pages/licenses/form.ejs');
    expect(src).toContain('max="<%= CONSTANTS.MAX_SEAT_COUNT %>"');
    expect(src).not.toContain('max="1000000"');
  });

  it('the username input declares the minimum length and the character class', () => {
    const src = readView('pages/staff/form.ejs');
    expect(src).toContain('minlength="<%= CONSTANTS.MIN_USERNAME %>"');
    expect(src).toContain('pattern="[A-Za-z0-9._\\-]{<%= CONSTANTS.MIN_USERNAME %>,<%= CONSTANTS.MAX_USERNAME %>}"');
  });

  it('every pattern the templates declare compiles under the "v" regex flag', () => {
    // The HTML `pattern` attribute is compiled with the 'v' flag by current
    // browsers, where a bare "-" inside a character class is a SYNTAX ERROR
    // (it must be escaped as "\-"). An invalid pattern is ignored by the
    // browser, so the constraint it carries would silently do nothing.
    const viewsDir = path.join(__dirname, '..', 'views');
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? walk(p) : (e.name.endsWith('.ejs') ? [p] : []);
    });
    for (const file of walk(viewsDir)) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/\bpattern="([^"]*)"/g)) {
        const pattern = m[1]
          .replace(/<%=\s*CONSTANTS\.(\w+)\s*%>/g, (_, key) => String(require('../src/constants')[key]));
        expect(() => new RegExp(`^(?:${pattern})$`, 'v')).not.toThrow();
      }
    }
  });

  it('the asset-tag input declares the AST-XXX format the route enforces', () => {
    const src = readView('pages/assets/form.ejs');
    expect(src).toContain('pattern="AST-\\d{3,}"');
  });

  it('the website input declares the http/https scheme the route enforces', () => {
    const src = readView('pages/vendors/form.ejs');
    expect(src).toContain('pattern="https?://.+"');
  });

  it('the email inputs declare the dot-required rule the route enforces', () => {
    for (const file of ['pages/tickets/form.ejs', 'pages/staff/form.ejs', 'pages/auth/profile.ejs', 'pages/vendors/form.ejs']) {
      const src = readView(file);
      expect(src).toContain('pattern="[^\\s@]+@[^\\s@]+\\.[^\\s@]+"');
    }
  });
});

// ---------------------------------------------------------------------------
// 5. The deactivate confirmation names what the route actually does.
// ---------------------------------------------------------------------------
describe('the deactivate confirmation matches the route', () => {
  it('names the tickets, tasks, changes, projects and memberships the route releases', () => {
    const src = readView('pages/staff/show.ejs');
    const confirm = /data-confirm="Deactivate this account\?([^"]*)"/.exec(src);
    expect(confirm).not.toBe(null);
    const text = confirm[1];
    expect(text).toMatch(/tickets/);
    expect(text).toMatch(/tasks/);
    expect(text).toMatch(/changes/);
    expect(text).toMatch(/projects/);
  });

  it('the route really does unassign all five kinds of record', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'staff.js'), 'utf8');
    for (const stmt of [
      '_unassignTicketsStmt.run',
      '_unassignTasksStmt.run',
      '_unassignChangesStmt.run',
      '_unassignProjectOwnerStmt.run',
      '_releaseProjectMembersStmt.run'
    ]) {
      expect(src).toContain(stmt);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. vendors.js no longer carries the unreachable wrong-type guard.
// ---------------------------------------------------------------------------
describe('vendors.js — no stale duplicate wrong-type guard', () => {
  it('the update route has exactly one wrong-type guard and no stale message', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'vendors.js'), 'utf8');
    expect(src).not.toContain("'Invalid Vendor Name'");
    // The app-wide guard still covers the name.
    const guard = /findNonStringField\(req\.body, \[([^\]]*)\]\)/.exec(src);
    expect(guard).not.toBe(null);
    expect(guard[1]).toMatch(/'name'/);
  });

  it('a wrong-typed vendor name is still rejected with the app-wide wording', () => {
    const handler = lastHandlerFor(vendorsRouter, 'put', '/:id');
    const req = writeReq({ name: 12345 }, { id: '1' });
    const res = makeRes();

    handler(req, res, () => {});

    expect(errorFlash(req)).toBe('Invalid request parameters');
  });
});
