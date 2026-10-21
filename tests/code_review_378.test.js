const { describe, it, expect, beforeEach } = require('@jest/globals');
const { lastHandlerFor } = require('./helpers');

// Regression tests for review cycle 378.
//
// Defects closed by this pass:
//
// (1) The project CREATE route required its `status` and `priority` enums
//     instead of applying the documented defaults. The `status` column is
//     NOT NULL DEFAULT 'planning' and `priority` is nullable DEFAULT
//     'medium', and every sibling create route (assets → 'in_storage',
//     tickets → 'open', tasks → 'todo', changes → 'scheduled', articles →
//     'draft') takes the default for an absent field. The project's own
//     UPDATE route also treats both fields as absent-preserving. A client
//     that submitted only a project name was refused with "Invalid Status"
//     / "Invalid Priority", while the README's create-route paragraph
//     states the rule the code did not implement: "An absent field still
//     takes the documented default."
//
// (2) The vendor CREATE route accepted a WHITESPACE-ONLY category and
//     stored NULL with a success flash, while the matching UPDATE route
//     rejected the identical value with "Invalid Category". A whitespace-only
//     value is neither an absent field ("not submitted") nor an intentional
//     empty string ("clear the column") — it is an invalid value, and the
//     app-wide contract says an invalid value is rejected.
//
// (3) Seven CREATE routes and three UPDATE routes reported a
//     present-but-non-string REQUIRED column as a MISSING field ("Project
//     name is required", "Vendor name is required", "Software name is
//     required", "All required fields must be filled in", "Title, content,
//     and category are required", "Title and change type are required",
//     "Task title is required") instead of the app-wide fail-closed
//     "Invalid request parameters" the sibling required columns report. A
//     JSON number is a type error, not an absent field.
//
// The heavy dependencies are mocked (the pattern used by
// tests/code_review_114.test.js / partial_update.test.js) and the individual
// route handlers are driven directly with fake req/res objects.
jest.mock('better-sqlite3');
jest.mock('../src/models/database', () => {
  const stmt = { get: jest.fn(() => null), all: jest.fn(() => []), run: jest.fn(() => ({ changes: 1, lastInsertRowid: 1 })) };
  return { prepare: jest.fn(() => stmt), exec: jest.fn(), pragma: jest.fn(), transaction: jest.fn((fn) => fn), close: jest.fn() };
});
jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => next(),
  requireAdminOrManager: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
  canAccessResource: jest.fn(() => true)
}));
jest.mock('../src/middleware/audit', () => ({
  audit: jest.fn(),
  auditMiddleware: (req, res, next) => {
    req.audit = jest.fn();
    next();
  }
}));
jest.mock('../src/routes/dashboard', () => {
  const Router = require('express').Router;
  const router = Router();
  router.invalidateDashboardCache = jest.fn();
  return router;
});

function runHandler(handler, body, params = {}, sessionUser = { id: 1, role: 'admin' }) {
  const redirectCalls = [];
  const flashCalls = [];
  let renderArgs = null;
  const req = { body, params, method: 'POST', session: { user: sessionUser }, flash: (type, msg) => flashCalls.push([type, msg]), audit: jest.fn() };
  const res = {
    redirect: (to) => {
      redirectCalls.push(to);
    },
    render: (view, locals) => {
      renderArgs = locals;
    },
    status: () => res,
    json: () => {},
    end: () => {}
  };
  handler(req, res, () => {});
  return { redirectCalls, flashCalls, renderArgs, req, res };
}

function errorFlash(flashCalls) {
  const found = flashCalls.find(([t]) => t === 'error');
  return found ? found[1] : undefined;
}

// The parameters of the last statement the (mocked) database was asked to run.
function lastRunParams() {
  const db = jest.requireMock('../src/models/database');
  const calls = db.prepare().run.mock.calls;
  return calls.length ? calls[calls.length - 1] : null;
}

// ---------------------------------------------------------------------------
// 1. The project create route applies the documented enum defaults
// ---------------------------------------------------------------------------
describe('code review 378 — the project create route applies the documented defaults', () => {
  const projectsRouter = require('../src/routes/projects');

  beforeEach(() => {
    const db = jest.requireMock('../src/models/database');
    db.prepare().run.mockClear();
  });

  it('an absent status takes the documented "planning" default', () => {
    const h = lastHandlerFor(projectsRouter, 'post', '/');
    const { redirectCalls, flashCalls } = runHandler(h, { name: 'CR378 default status' });
    expect(errorFlash(flashCalls)).toBeUndefined();
    expect(redirectCalls).toEqual(['/projects/1']);
    // INSERT projects (name, description, status, priority, …)
    const params = lastRunParams();
    expect(params[2]).toBe('planning');
  });

  it('an absent priority takes the documented "medium" default', () => {
    const h = lastHandlerFor(projectsRouter, 'post', '/');
    const { redirectCalls, flashCalls } = runHandler(h, { name: 'CR378 default priority' });
    expect(errorFlash(flashCalls)).toBeUndefined();
    expect(redirectCalls).toEqual(['/projects/1']);
    const params = lastRunParams();
    expect(params[3]).toBe('medium');
  });

  it('an explicit status and priority are still stored verbatim', () => {
    const h = lastHandlerFor(projectsRouter, 'post', '/');
    const { flashCalls } = runHandler(h, { name: 'CR378 explicit enums', status: 'in_progress', priority: 'critical' });
    expect(errorFlash(flashCalls)).toBeUndefined();
    const params = lastRunParams();
    expect(params[2]).toBe('in_progress');
    expect(params[3]).toBe('critical');
  });

  it('rejects a present-but-empty status (the column is NOT NULL)', () => {
    const h = lastHandlerFor(projectsRouter, 'post', '/');
    const { redirectCalls, flashCalls } = runHandler(h, { name: 'CR378 empty status', status: '' });
    expect(redirectCalls).toEqual(['/projects/new']);
    expect(errorFlash(flashCalls)).toBe('Invalid Status');
    expect(jest.requireMock('../src/models/database').prepare().run).not.toHaveBeenCalled();
  });

  it('rejects a present-but-whitespace-only status', () => {
    const h = lastHandlerFor(projectsRouter, 'post', '/');
    const { redirectCalls, flashCalls } = runHandler(h, { name: 'CR378 blank status', status: '   ' });
    expect(redirectCalls).toEqual(['/projects/new']);
    expect(errorFlash(flashCalls)).toBe('Invalid Status');
    expect(jest.requireMock('../src/models/database').prepare().run).not.toHaveBeenCalled();
  });

  it('rejects a present-but-unknown priority', () => {
    const h = lastHandlerFor(projectsRouter, 'post', '/');
    const { redirectCalls, flashCalls } = runHandler(h, { name: 'CR378 bad priority', priority: 'urgent' });
    expect(redirectCalls).toEqual(['/projects/new']);
    expect(errorFlash(flashCalls)).toBe('Invalid Priority');
    expect(jest.requireMock('../src/models/database').prepare().run).not.toHaveBeenCalled();
  });

  it('treats a blank priority as "not submitted" and takes the default', () => {
    // The priority column is nullable with a meaningful default, so a blank
    // value means "not submitted" — the same rule the task and change create
    // routes apply and the same rule the project's own UPDATE route applies
    // (where a blank priority preserves the stored value).
    const h = lastHandlerFor(projectsRouter, 'post', '/');
    const { flashCalls } = runHandler(h, { name: 'CR378 blank priority', priority: '' });
    expect(errorFlash(flashCalls)).toBeUndefined();
    const params = lastRunParams();
    expect(params[3]).toBe('medium');
  });
});

// ---------------------------------------------------------------------------
// 2. The vendor create route rejects a whitespace-only category
// ---------------------------------------------------------------------------
describe('code review 378 — the vendor create route rejects a blank category', () => {
  const vendorsRouter = require('../src/routes/vendors');

  beforeEach(() => {
    const db = jest.requireMock('../src/models/database');
    db.prepare().run.mockClear();
  });

  it('rejects a whitespace-only category instead of silently storing NULL', () => {
    const h = lastHandlerFor(vendorsRouter, 'post', '/');
    const { redirectCalls, flashCalls } = runHandler(h, { name: 'CR378 blank category', category: '   ' });
    expect(redirectCalls).toEqual(['/vendors/new']);
    expect(errorFlash(flashCalls)).toBe('Invalid Category');
    expect(jest.requireMock('../src/models/database').prepare().run).not.toHaveBeenCalled();
  });

  it('still clears the category for an explicit empty string', () => {
    const h = lastHandlerFor(vendorsRouter, 'post', '/');
    const { flashCalls } = runHandler(h, { name: 'CR378 empty category', category: '' });
    expect(errorFlash(flashCalls)).toBeUndefined();
    // INSERT vendors (name, contact_person, email, phone, address, website, category, …)
    const params = lastRunParams();
    expect(params[6]).toBeNull();
  });

  it('still stores a valid category', () => {
    const h = lastHandlerFor(vendorsRouter, 'post', '/');
    const { flashCalls } = runHandler(h, { name: 'CR378 valid category', category: 'cloud' });
    expect(errorFlash(flashCalls)).toBeUndefined();
    const params = lastRunParams();
    expect(params[6]).toBe('cloud');
  });
});

// ---------------------------------------------------------------------------
// 3. A present-but-non-string REQUIRED column is an invalid value, not a
//    missing one — on every create and update route
// ---------------------------------------------------------------------------
describe('code review 378 — a non-string required column is reported as invalid', () => {
  beforeEach(() => {
    const db = jest.requireMock('../src/models/database');
    db.prepare().run.mockClear();
  });

  const CREATE_CASES = [
    {
      name: 'project create',
      router: () => require('../src/routes/projects'),
      route: ['post', '/'],
      body: { name: 42 },
      redirect: '/projects/new'
    },
    {
      name: 'vendor create',
      router: () => require('../src/routes/vendors'),
      route: ['post', '/'],
      body: { name: 42 },
      redirect: '/vendors/new'
    },
    {
      name: 'license create',
      router: () => require('../src/routes/licenses'),
      route: ['post', '/'],
      body: { software_name: 42 },
      redirect: '/licenses/new'
    },
    {
      name: 'staff create',
      router: () => require('../src/routes/staff'),
      route: ['post', '/'],
      body: { username: 'cr378user', password: 'ValidPass1!xyz', email: 42, first_name: 'A', last_name: 'B', role: 'staff' },
      redirect: '/staff/new'
    },
    {
      name: 'article create',
      router: () => require('../src/routes/knowledge'),
      route: ['post', '/'],
      body: { title: 42, content: 'body', category: 'how_to' },
      redirect: '/knowledge/new'
    },
    {
      name: 'change create',
      router: () => require('../src/routes/changes'),
      route: ['post', '/'],
      body: { title: 42, change_type: 'maintenance' },
      redirect: '/changes/new'
    },
    {
      name: 'task create',
      router: () => require('../src/routes/projects'),
      route: ['post', '/:id/tasks'],
      body: { title: 42 },
      redirect: '/projects/1',
      params: { id: '1' }
    }
  ];

  for (const c of CREATE_CASES) {
    it(`${c.name} rejects a non-string required column with "Invalid request parameters"`, () => {
      const router = c.router();
      const h = lastHandlerFor(router, c.route[0], c.route[1]);
      const { redirectCalls, flashCalls } = runHandler(h, c.body, c.params || {});
      expect(redirectCalls).toEqual([c.redirect]);
      expect(errorFlash(flashCalls)).toBe('Invalid request parameters');
      expect(jest.requireMock('../src/models/database').prepare().run).not.toHaveBeenCalled();
    });
  }

  const UPDATE_CASES = [
    {
      name: 'project update',
      router: () => require('../src/routes/projects'),
      route: ['put', '/:id'],
      body: { name: 42 },
      redirect: '/projects/1/edit',
      params: { id: '1' }
    },
    {
      name: 'article update',
      router: () => require('../src/routes/knowledge'),
      route: ['put', '/:id'],
      body: { title: 42 },
      redirect: '/knowledge/1/edit',
      params: { id: '1' },
      // The article must exist (and be owned by the session user) for the
      // route to reach the type guard at all — the existence and ownership
      // checks run first.
      dbGet: {
        id: 1, title: 'Stored title', content: 'Stored body', category: 'how_to',
        tags: null, author_id: 1, status: 'published', views: 0, is_featured: 0,
        created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00'
      }
    },
    {
      name: 'change update',
      router: () => require('../src/routes/changes'),
      route: ['put', '/:id'],
      body: { title: 42 },
      redirect: '/changes/1/edit',
      params: { id: '1' }
    }
  ];

  for (const c of UPDATE_CASES) {
    it(`${c.name} rejects a non-string required column with "Invalid request parameters"`, () => {
      const db = jest.requireMock('../src/models/database');
      db.prepare().get.mockReturnValue(c.dbGet || null);
      const router = c.router();
      const h = lastHandlerFor(router, c.route[0], c.route[1]);
      const { redirectCalls, flashCalls } = runHandler(h, c.body, c.params || {});
      expect(redirectCalls).toEqual([c.redirect]);
      expect(errorFlash(flashCalls)).toBe('Invalid request parameters');
      expect(jest.requireMock('../src/models/database').prepare().run).not.toHaveBeenCalled();
    });
  }
});
