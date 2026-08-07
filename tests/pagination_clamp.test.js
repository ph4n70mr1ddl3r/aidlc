const { describe, it, expect, beforeEach, afterEach } = require('@jest/globals');
const { lastHandlerFor } = require('./helpers');

// Regression contract for the pagination page-clamp fix: every paginated list
// route must clamp a requested page beyond the last page (e.g. ?page=999) to
// totalPages. Previously paginate() clamped page to [1, MAX_PAGE] only, so an
// out-of-range page returned an empty list and the pagination partial rendered
// a broken "Showing N–M" range (M < N). The clamp must live in every list
// route because paginate() has no knowledge of totalPages at call time.

const originalDbPath = process.env.DB_PATH;
beforeEach(function () {
  process.env.DB_PATH = ':memory:';
  delete require.cache[require.resolve('../src/models/database')];
  delete require.cache[require.resolve('../src/utils')];
  delete require.cache[require.resolve('../src/routes/dashboard')];
  delete require.cache[require.resolve('../src/routes/audit')];
  delete require.cache[require.resolve('../src/routes/assets')];
  delete require.cache[require.resolve('../src/routes/tickets')];
  delete require.cache[require.resolve('../src/routes/knowledge')];
  delete require.cache[require.resolve('../src/routes/vendors')];
  delete require.cache[require.resolve('../src/routes/changes')];
  delete require.cache[require.resolve('../src/routes/licenses')];
  delete require.cache[require.resolve('../src/routes/projects')];
  delete require.cache[require.resolve('../src/routes/staff')];
});
afterEach(function () {
  process.env.DB_PATH = originalDbPath;
});

jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => next(),
  requireAdminOrManager: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
  canAccessResource: () => true
}));

jest.mock('../src/middleware/audit', () => ({
  auditMiddleware: (req, res, next) => next()
}));

jest.mock('../src/routes/dashboard', () => ({
  invalidateDashboardCache: jest.fn()
}));

// Every paginated list route that renders the pagination partial.
const LIST_ROUTES = ['audit', 'assets', 'tickets', 'knowledge', 'vendors', 'changes', 'licenses', 'projects', 'staff'];

describe.each(LIST_ROUTES)('pagination page clamp — GET / in %s', (name) => {
  it('clamps ?page=999 to totalPages (1) for an empty table', () => {
    const router = require(`../src/routes/${name}`);
    const handler = lastHandlerFor(router, 'get', '/');
    const req = {
      query: { page: '999' },
      session: { user: { id: 1 } },
      path: `/${name}`,
      audit: jest.fn(),
      flash: jest.fn()
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
    expect(locals.totalPages).toBe(1);
    expect(locals.page).toBe(1);
  });
});
