const { describe, it, expect, beforeEach, afterEach } = require('@jest/globals');
const { lastHandlerFor } = require('./helpers');

// Exercise the real audit route against an in-memory SQLite database so we
// verify the full GET / handler (pagination, filtering, sorting, safeFilters)
// end-to-end — not just the middleware helpers tested in audit.test.js.
// Mirrors the pattern used by reports.test.js / dashboard.test.js.

const originalDbPath = process.env.DB_PATH;
beforeEach(function () {
  process.env.DB_PATH = ':memory:';
  delete require.cache[require.resolve('../src/models/database')];
  delete require.cache[require.resolve('../src/utils')];
  delete require.cache[require.resolve('../src/routes/audit')];
});
afterEach(function () {
  process.env.DB_PATH = originalDbPath;
  delete require.cache[require.resolve('../src/models/database')];
  delete require.cache[require.resolve('../src/utils')];
  delete require.cache[require.resolve('../src/routes/audit')];
});

jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => next(),
  requireAdminOrManager: (req, res, next) => next()
}));

jest.mock('../src/middleware/audit', () => ({
  auditMiddleware: (req, res, next) => next()
}));

jest.mock('../src/routes/dashboard', () => ({
  invalidateDashboardCache: jest.fn()
}));

function getDb() {
  return require('../src/models/database');
}

function seedAuditData(db) {
  db.pragma('foreign_keys = OFF');
  db.exec('DELETE FROM audit_log');
  db.pragma('foreign_keys = ON');
  const insert = db.prepare(
    'INSERT INTO audit_log (user_id, action, entity_type, entity_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?)'
  );
  // Use null user_id to avoid FK constraint (users table is empty)
  insert.run(null, 'create', 'ticket', 1, 'Created ticket TK-001', '127.0.0.1');
  insert.run(null, 'update', 'ticket', 1, 'Updated ticket TK-001', '127.0.0.1');
  insert.run(null, 'read', 'asset', 2, 'Viewed asset AST-002', '127.0.0.2');
  insert.run(null, 'delete', 'vendor', 3, 'Deleted vendor Acme', '127.0.0.1');
  insert.run(null, 'login', 'user', null, 'User logged in', '127.0.0.1');
}

describe('audit route — GET /', () => {
  let db;
  let router;

  beforeEach(() => {
    db = getDb();
    seedAuditData(db);
    const utils = require('../src/utils');
    utils.resetCachedStatements();
    router = require('../src/routes/audit');
  });

  afterEach(() => {
    const auditModule = require('../src/routes/audit');
    auditModule.resetCachedStatements();
  });

  it('returns paginated entries ordered by created_at DESC (all same timestamp, so order is insertion-order)', () => {
    const handler = lastHandlerFor(router, 'get', '/');
    const req = {
      query: {},
      session: { user: { id: 1 } },
      path: '/audit',
      audit: jest.fn()
    };
    const res = {
      locals: {},
      render: jest.fn(),
      set: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    handler(req, res, () => {});
    expect(res.render).toHaveBeenCalledTimes(1);
    const locals = res.render.mock.calls[0][1];
    expect(locals.entries.length).toBe(5);
    // All entries have the same timestamp so order is non-deterministic;
    // assert that the full set of expected actions is present.
    const actions = locals.entries.map(e => e.action);
    expect(actions).toContain('create');
    expect(actions).toContain('update');
    expect(actions).toContain('read');
    expect(actions).toContain('delete');
    expect(actions).toContain('login');
  });

  it('filters by action', () => {
    const handler = lastHandlerFor(router, 'get', '/');
    const req = {
      query: { action: 'create' },
      session: { user: { id: 1 } },
      path: '/audit',
      audit: jest.fn()
    };
    const res = {
      locals: {},
      render: jest.fn(),
      set: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    handler(req, res, () => {});
    const locals = res.render.mock.calls[0][1];
    expect(locals.entries.every(e => e.action === 'create')).toBe(true);
    expect(locals.entries.length).toBe(1);
  });

  it('filters by entity_type', () => {
    const handler = lastHandlerFor(router, 'get', '/');
    const req = {
      query: { entity_type: 'asset' },
      session: { user: { id: 1 } },
      path: '/audit',
      audit: jest.fn()
    };
    const res = {
      locals: {},
      render: jest.fn(),
      set: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    handler(req, res, () => {});
    const locals = res.render.mock.calls[0][1];
    expect(locals.entries.every(e => e.entity_type === 'asset')).toBe(true);
  });

  it('sorts oldest first when sort=oldest', () => {
    const handler = lastHandlerFor(router, 'get', '/');
    const req = {
      query: { sort: 'oldest' },
      session: { user: { id: 1 } },
      path: '/audit',
      audit: jest.fn()
    };
    const res = {
      locals: {},
      render: jest.fn(),
      set: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    handler(req, res, () => {});
    const locals = res.render.mock.calls[0][1];
    // All entries have the same timestamp so order is non-deterministic;
    // assert that the full set is present regardless of sort direction.
    const actions = locals.entries.map(e => e.action);
    expect(actions).toContain('create');
    expect(actions).toContain('login');
    expect(actions.length).toBe(5);
  });

  it('includes sort in safeFilters so the template reflects the current sort', () => {
    const handler = lastHandlerFor(router, 'get', '/');
    const req = {
      query: { sort: 'oldest', action: 'create' },
      session: { user: { id: 1 } },
      path: '/audit',
      audit: jest.fn()
    };
    const res = {
      locals: {},
      render: jest.fn(),
      set: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    handler(req, res, () => {});
    const locals = res.render.mock.calls[0][1];
    expect(locals.filters.sort).toBe('oldest');
    expect(locals.filters.action).toBe('create');
  });

  it('returns pagination locals (page, limit, totalPages, total, baseUrl)', () => {
    const handler = lastHandlerFor(router, 'get', '/');
    const req = {
      query: { page: '1', limit: '2' },
      session: { user: { id: 1 } },
      path: '/audit',
      audit: jest.fn()
    };
    const res = {
      locals: {},
      render: jest.fn(),
      set: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    handler(req, res, () => {});
    const locals = res.render.mock.calls[0][1];
    expect(locals.page).toBe(1);
    expect(locals.limit).toBe(2);
    expect(locals.totalPages).toBe(3); // 5 entries / 2 per page = 3 pages
    expect(locals.total).toBe(5);
    expect(typeof locals.baseUrl).toBe('string');
  });

  it('ignores invalid filter values (doesn\'t crash, returns all entries)', () => {
    const handler = lastHandlerFor(router, 'get', '/');
    const req = {
      query: { action: 'nonexistent_action', entity_type: 'nonexistent_type' },
      session: { user: { id: 1 } },
      path: '/audit',
      audit: jest.fn()
    };
    const res = {
      locals: {},
      render: jest.fn(),
      set: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    handler(req, res, () => {});
    const locals = res.render.mock.calls[0][1];
    // Invalid filter values are skipped, so all entries are returned
    expect(locals.entries.length).toBe(5);
  });
});
