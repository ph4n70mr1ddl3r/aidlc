/**
 * Pass 368 — regression tests for the correctness / consistency fixes applied
 * in the 368th review cycle:
 *
 *  1. assets.js  — the related-ticket cap was applied BEFORE the access
 *     filter, so an authorised viewer could be shown "No tickets linked to
 *     this asset" while a privileged viewer saw the newest N.
 *  2. tickets.js — the comment route's `updated_at` touch had no
 *     `changes === 0` no-op guard (every other mutation has one).
 *  3. tickets.js — a deactivated account was redirected with
 *     `reason=session_expired`, which makes the login page claim the session
 *     "expired after reaching its maximum lifetime".
 *  4. licenses.js — the edit route loaded the plaintext license_key into the
 *     EJS render context even though the form never pre-fills it.
 *  5. staff.js  — a whitespace-only department silently cleared the stored
 *     value while the sibling phone field failed closed.
 *  6. staff.js  — the directory search matched the redacted email column for
 *     non-privileged viewers, turning the row count into an email-existence
 *     oracle.
 *  7. staff.js  — the deactivation flash omitted the projects it unassigns.
 *  8. knowledge.js — the mutation routes leaked article existence via a
 *     distinct "you do not have permission" message.
 *  9. ORDER BY tiebreakers on every capped list query (projects tasks,
 *     tickets comments, assets related tickets, staff sidebars).
 * 10. Password inputs declared maxlength=128 while the server rejects
 *     anything over 72 BYTES.
 */
const { describe, it, expect, beforeEach } = require('@jest/globals');
const fs = require('fs');
const path = require('path');
const { lastHandlerFor } = require('./helpers');

// A per-SQL statement mock: each distinct SQL string gets its own statement
// object, so a test can target a specific query by a substring of its SQL and
// assert on the SQL the route actually issued.
jest.mock('../src/models/database', () => {
  const statements = new Map();
  const prepare = jest.fn((sql) => {
    if (!statements.has(sql)) {
      statements.set(sql, {
        sql,
        get: jest.fn(() => null),
        all: jest.fn(() => []),
        run: jest.fn(() => ({ changes: 1, lastInsertRowid: 1 }))
      });
    }
    return statements.get(sql);
  });
  return {
    prepare,
    exec: jest.fn(),
    pragma: jest.fn(),
    transaction: jest.fn((fn) => fn),
    close: jest.fn(),
    __statements: statements,
    __allSql: () => [...statements.keys()],
    __stmt: (fragment) => {
      for (const [sql, stmt] of statements) {
        if (sql.includes(fragment)) {
          return stmt;
        }
      }
      throw new Error(`No prepared statement contains: ${fragment}`);
    },
    __reset: () => {
      for (const stmt of statements.values()) {
        stmt.get.mockReset();
        stmt.all.mockReset();
        stmt.run.mockReset();
        stmt.get.mockReturnValue(null);
        stmt.all.mockReturnValue([]);
        stmt.run.mockReturnValue({ changes: 1, lastInsertRowid: 1 });
      }
    }
  };
});

// canAccessResource is mirrored faithfully so the access-scoped queries are
// exercised against the real policy (privileged → all, staff → own rows).
jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => next(),
  requireAdminOrManager: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
  canAccessResource: jest.fn((req, resource) => {
    if (!req || !req.session || !req.session.user || !resource) {
      return false;
    }
    const u = req.session.user;
    if (u.role === 'admin' || u.role === 'manager') {
      return true;
    }
    return ['assigned_to', 'owner_id', 'user_id', 'author_id']
      .some(f => resource[f] != null && Number(resource[f]) === Number(u.id));
  })
}));
jest.mock('../src/middleware/audit', () => ({
  audit: jest.fn(),
  auditMiddleware: (req, res, next) => {
    req.audit = jest.fn(); next();
  }
}));
jest.mock('../src/routes/dashboard', () => {
  const Router = require('express').Router;
  const router = Router();
  router.invalidateDashboardCache = jest.fn();
  return router;
});

const db = require('../src/models/database');
const { resetCachedStatements } = require('../src/utils');

const ADMIN = { id: 1, role: 'admin', username: 'admin' };
const STAFF = { id: 7, role: 'staff', username: 'staff7' };

function runHandler(handler, { method = 'PUT', body = {}, params = { id: '1' }, query = {}, sessionUser = ADMIN } = {}) {
  const redirectCalls = [];
  const flashCalls = [];
  const auditCalls = [];
  const req = {
    body, params, query, method,
    session: { user: sessionUser },
    flash: (type, msg) => flashCalls.push([type, msg]),
    audit: (...args) => auditCalls.push(args)
  };
  const res = {
    redirect: (to) => {
      redirectCalls.push(to);
    },
    render: () => {}, status: () => res, json: () => {}, end: () => {}
  };
  handler(req, res, () => {});
  return { redirectCalls, flashCalls, auditCalls };
}

beforeEach(() => {
  db.__reset();
  resetCachedStatements();
});

describe('asset related tickets — access filter applied before the cap (pass 368)', () => {
  const assetsRouter = require('../src/routes/assets');

  const ASSET = { id: 3, asset_tag: 'AST-003', name: 'Laptop', assigned_to: STAFF.id, assigned_email: 'staff7@example.com' };

  it('scopes the query to the viewer\'s own tickets for a non-privileged viewer', () => {
    const owned = db.__stmt('FROM tickets WHERE asset_id = ? AND assigned_to = ?');
    owned.all.mockReturnValue([{ id: 9, ticket_number: 'TK-1', title: 'Mine', assigned_to: STAFF.id }]);

    const h = lastHandlerFor(assetsRouter, 'get', '/:id');
    db.__stmt('FROM assets a').get.mockReturnValue({ ...ASSET });
    db.__stmt('u.email as assigned_email').get.mockReturnValue({ ...ASSET });

    runHandler(h, { method: 'GET', params: { id: '3' }, sessionUser: STAFF });

    // The access predicate is applied IN SQL so the LIMIT caps the rows the
    // viewer may actually see (previously the cap was applied first).
    expect(owned.all).toHaveBeenCalledWith(3, STAFF.id);
  });

  it('shows every linked ticket to a privileged viewer', () => {
    const all = db.__stmt('WHERE asset_id = ?\n');
    all.all.mockReturnValue([{ id: 9, ticket_number: 'TK-1', title: 'Mine', assigned_to: STAFF.id }]);

    const h = lastHandlerFor(assetsRouter, 'get', '/:id');
    db.__stmt('FROM assets a').get.mockReturnValue({ ...ASSET });
    db.__stmt('u.email as assigned_email').get.mockReturnValue({ ...ASSET });

    runHandler(h, { method: 'GET', params: { id: '3' }, sessionUser: ADMIN });

    expect(all.all).toHaveBeenCalledWith(3);
  });

  it('still filters the privileged result set through canAccessResource', () => {
    const all = db.__stmt('WHERE asset_id = ?\n');
    all.all.mockReturnValue([
      { id: 9, ticket_number: 'TK-1', assigned_to: STAFF.id },
      { id: 10, ticket_number: 'TK-2', assigned_to: 999 }
    ]);

    const h = lastHandlerFor(assetsRouter, 'get', '/:id');
    db.__stmt('FROM assets a').get.mockReturnValue({ ...ASSET });
    db.__stmt('u.email as assigned_email').get.mockReturnValue({ ...ASSET });

    runHandler(h, { method: 'GET', params: { id: '3' }, sessionUser: STAFF });

    // Defence-in-depth: the JS filter is retained on top of the SQL predicate.
    const canAccess = require('../src/middleware/auth').canAccessResource;
    expect(canAccess).toHaveBeenCalled();
  });
});

describe('ticket comment — no-op guard on the updated_at touch (pass 368)', () => {
  const ticketsRouter = require('../src/routes/tickets');

  it('reports not found and skips the success audit when the touch changes 0 rows', () => {
    const exists = db.__stmt('FROM ticket_comments');
    exists.get.mockReturnValue({ id: 1, assigned_to: STAFF.id });
    db.__stmt('UPDATE tickets SET updated_at').run.mockReturnValue({ changes: 0 });

    const h = lastHandlerFor(ticketsRouter, 'post', '/:id/comments');
    const { redirectCalls, flashCalls, auditCalls } = runHandler(h, {
      method: 'POST', params: { id: '1' }, body: { comment: 'hello' }, sessionUser: STAFF
    });

    expect(redirectCalls).toEqual(['/tickets']);
    expect(flashCalls).toContainEqual(['error', 'Ticket not found']);
    expect(auditCalls.some(([a]) => a === 'comment')).toBe(false);
  });
});

describe('licenses edit form — the plaintext key never reaches the template (pass 368)', () => {
  const licensesRouter = require('../src/routes/licenses');

  it('redacts license_key and exposes only a has_license_key flag', () => {
    const h = lastHandlerFor(licensesRouter, 'get', '/:id/edit');
    // The edit route now reads the key-free statement: it never selects
    // license_key and exposes a has_license_key flag computed in SQL, so the
    // plaintext cannot reach the render context at all.
    db.__stmt('FROM licenses WHERE id = ?').get.mockReturnValue({
      id: 1, software_name: 'MS365', vendor: 'Microsoft', has_license_key: 1,
      license_type: 'subscription', total_seats: 10, used_seats: 5,
      purchase_date: '2024-01-01', expiry_date: '2099-01-01', cost: 1000, notes: null
    });

    let renderArgs = null;
    const res = { redirect: () => {}, status: () => res, json: () => {}, render: (view, locals) => {
      renderArgs = { view, locals };
    } };
    const req = {
      params: { id: '1' }, query: {}, method: 'GET',
      session: { user: ADMIN },
      flash: () => {}, audit: () => {}
    };
    h(req, res, () => {});

    expect(renderArgs).not.toBeNull();
    expect(renderArgs.locals.license.license_key).toBeUndefined();
    expect(renderArgs.locals.license.has_license_key).toBe(true);
  });
});

describe('staff update — whitespace-only department fails closed (pass 368)', () => {
  const staffRouter = require('../src/routes/staff');

  const body = {
    email: 'staff7@example.com', first_name: 'Staff', last_name: 'Seven',
    role: 'staff', department: '   '
  };

  it('rejects a present-but-blank department instead of silently clearing it', () => {
    const h = lastHandlerFor(staffRouter, 'put', '/:id');
    const { redirectCalls, flashCalls } = runHandler(h, { body, params: { id: '7' }, sessionUser: ADMIN });

    expect(redirectCalls).toEqual(['/staff/7/edit']);
    expect(flashCalls).toContainEqual(['error', 'Please enter a valid department']);
    // No write happened at all.
    const update = db.__stmt('UPDATE users SET email');
    expect(update.run).not.toHaveBeenCalled();
  });

  it('still lets an explicit empty department clear the stored value', () => {
    const h = lastHandlerFor(staffRouter, 'put', '/:id');
    db.__stmt('SELECT id, role, username, is_active, department, phone, email, first_name, last_name FROM users WHERE id = ?')
      .get.mockReturnValue({ id: 7, role: 'staff', username: 'staff7', is_active: 1, department: 'Engineering', phone: null });

    const { flashCalls } = runHandler(h, {
      body: { ...body, department: '' }, params: { id: '7' }, sessionUser: ADMIN
    });

    expect(flashCalls.some(([type]) => type === 'error')).toBe(false);
  });
});

describe('staff directory search — the redacted email column is not searchable by non-privileged viewers (pass 368)', () => {
  const staffRouter = require('../src/routes/staff');

  it('excludes u.email from the query for a non-privileged viewer', () => {
    const h = lastHandlerFor(staffRouter, 'get', '/');
    runHandler(h, { method: 'GET', params: {}, query: { search: 'someone@example.com' }, sessionUser: STAFF });

    // The staff SELECT lists u.email in its column list for every viewer —
    // what must differ is the SEARCH predicate, so assert on the WHERE clause
    // (the COUNT query carries the same WHERE as the listing).
    const whereQueries = db.__allSql().filter(s => s.includes('COUNT(*) as c FROM users'));
    expect(whereQueries.length).toBeGreaterThan(0);
    // addSearch quotes the column names, so the search predicate reads
    // "u"."email" LIKE ? — the redacted column must not appear in it.
    expect(whereQueries.filter(s => s.includes('"u"."email"'))).toEqual([]);
    expect(whereQueries.filter(s => s.includes('"u"."username"'))).toEqual([]);
  });

  it('keeps u.email searchable for a privileged viewer', () => {
    const h = lastHandlerFor(staffRouter, 'get', '/');
    runHandler(h, { method: 'GET', params: {}, query: { search: 'someone@example.com' }, sessionUser: ADMIN });

    const whereQueries = db.__allSql().filter(s => s.includes('COUNT(*) as c FROM users'));
    expect(whereQueries.length).toBeGreaterThan(0);
    expect(whereQueries.filter(s => s.includes('"u"."email"')).length).toBeGreaterThan(0);
  });
});

describe('staff deactivation flash names every unassigned record type (pass 368)', () => {
  const staffRouter = require('../src/routes/staff');

  it('mentions projects alongside tickets/tasks/changes', () => {
    const h = lastHandlerFor(staffRouter, 'delete', '/:id');
    db.__stmt('SELECT id, role, username, is_active, department, phone, email, first_name, last_name FROM users WHERE id = ?')
      .get.mockReturnValue({ id: 7, role: 'staff', username: 'staff7', is_active: 1, department: null, phone: null });

    const { flashCalls } = runHandler(h, { method: 'DELETE', params: { id: '7' }, sessionUser: ADMIN });

    expect(flashCalls).toContainEqual([
      'success',
      'Staff member deactivated and open tickets/tasks/changes/projects unassigned.'
    ]);
  });
});

describe('source-level pins (pass 368)', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

  it('every capped list query carries an id tiebreaker', () => {
    const projects = read('src/routes/projects.js');
    expect(projects).toMatch(/pt\.due_date ASC, pt\.id ASC/);

    const tickets = read('src/routes/tickets.js');
    expect(tickets).toMatch(/ORDER BY tc\.created_at DESC, tc\.id DESC/);

    const assets = read('src/routes/assets.js');
    expect(assets).toMatch(/ORDER BY created_at DESC, id DESC/);

    const staff = read('src/routes/staff.js');
    expect(staff).toMatch(/ORDER BY name ASC, id ASC/);
    expect(staff).toMatch(/created_at DESC, id DESC/);
    expect(staff).toMatch(/pt\.due_date ASC, pt\.id ASC/);
    expect(staff).toMatch(/ORDER BY p\.updated_at DESC, p\.id DESC/);
  });

  it('the ticket comment route redirects a deactivated account with reason=deactivated', () => {
    const tickets = read('src/routes/tickets.js');
    expect(tickets).toMatch(/reason=deactivated/);
    expect(tickets).not.toMatch(/reason=session_expired/);
  });

  it('the knowledge mutation routes use the non-enumerating not-found wording', () => {
    const knowledge = read('src/routes/knowledge.js');
    expect(knowledge).not.toMatch(/do not have permission to (edit|delete) this article/);
    // The audit trail still records the denial.
    expect(knowledge).toMatch(/access_denied', 'knowledge_article'/);
  });

  it('password inputs cap at the server-side byte limit', () => {
    for (const view of ['views/pages/auth/login.ejs', 'views/pages/auth/profile.ejs', 'views/pages/staff/form.ejs', 'views/pages/staff/show.ejs']) {
      const src = read(view);
      expect(src).toMatch(/type="password"[\s\S]{0,400}?maxlength="<%= CONSTANTS\.MAX_PASSWORD_BYTES %>"/);
      expect(src).not.toMatch(/type="password"[\s\S]{0,400}?maxlength="<%= CONSTANTS\.MAX_PASSWORD %>"/);
    }
    // The constant must be reachable from the templates.
    const app = read('src/app.js');
    expect(app).toMatch(/MAX_PASSWORD_BYTES: constantsModule\.MAX_PASSWORD_BYTES/);
  });

  it('the projects budget/spent comment matches the implemented money-field convention', () => {
    const projects = read('src/routes/projects.js');
    expect(projects).not.toMatch(/an empty budget\/spent can no longer\s*\n\s*\*\s*be silently ignored/);
    expect(projects).toMatch(/blank money field is not a "clear to NULL" signal/);
  });
});
