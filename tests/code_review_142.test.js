const { describe, it, expect, beforeEach } = require('@jest/globals');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const utils = require('../src/utils');
const { lastHandlerFor } = require('./helpers');

// Regression tests for review cycle 142: fail-closed non-string enum/value
// guards on the update routes (tickets/projects/assets/knowledge, licenses
// create), staff update absent-vs-empty preserve for department/phone, and
// the reports/assets '$0' -> '-' template convention.

jest.mock('better-sqlite3');
jest.mock('../src/models/database', () => {
  const stmt = {
    get: jest.fn(() => null),
    all: jest.fn(() => []),
    run: jest.fn(() => ({ changes: 1, lastInsertRowid: 1 }))
  };
  return {
    prepare: jest.fn(() => stmt),
    exec: jest.fn(),
    pragma: jest.fn(),
    transaction: jest.fn((fn) => fn()),
    close: jest.fn()
  };
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

function buildReqRes(body, params, sessionUser = { id: 1, role: 'admin' }, method = 'PUT', query = {}) {
  const flashCalls = [];
  const redirectCalls = [];
  const reqAuditCalls = [];
  const renderCalls = [];
  const req = {
    body,
    params,
    query,
    method,
    session: { user: sessionUser },
    flash: (type, msg) => flashCalls.push([type, msg]),
    audit: (...args) => reqAuditCalls.push(args),
    ip: '127.0.0.1'
  };
  const res = {
    redirect: (to) => {
      redirectCalls.push(to);
    },
    render: (view, locals) => {
      renderCalls.push([view, locals]);
    },
    status: () => res,
    json: () => {},
    headersSent: false
  };
  return { req, res, flashCalls, redirectCalls, reqAuditCalls, renderCalls };
}

function errorFlash(flashCalls) {
  const found = flashCalls.find(([t]) => t === 'error');
  return found ? found[1] : undefined;
}

const db = jest.requireMock('../src/models/database');

beforeEach(() => {
  db.prepare().get.mockReset();
  db.prepare().all.mockReset();
  db.prepare().all.mockReturnValue([]);
  db.prepare().run.mockReset();
  db.prepare().run.mockReturnValue({ changes: 1, lastInsertRowid: 1 });
  db.prepare.mockClear();
  db.transaction.mockReset();
  db.transaction.mockImplementation((fn) => fn);
});

// Run a route handler inside jest.isolateModules so the route module gets a
// fresh registry and re-reads the mocked db (mirrors code_review_140/141).
function withRoute(name, fn) {
  jest.isolateModules(() => {
    const router = require(`../src/routes/${name}`);
    fn(router);
  });
}

// ---------------------------------------------------------------------------
// Tickets — present non-string enum values fail closed on update
// ---------------------------------------------------------------------------
describe('tickets update — non-string status/priority/category is rejected', () => {
  it.each(['status', 'priority', 'category'])('a JSON number %s fails closed', (field) => {
    withRoute('tickets', (router) => {
      const { req, res, flashCalls } = buildReqRes(
        { title: 'T', category: 'network', priority: 'high', status: 'open', [field]: 5 },
        { id: '1' }
      );
      lastHandlerFor(router, 'put', '/:id')(req, res, () => {});
      expect(errorFlash(flashCalls)).toBe('Invalid request parameters');
      expect(db.prepare().run).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Projects — non-string status/priority fail closed on project + task update
// ---------------------------------------------------------------------------
describe('projects update — non-string status/priority is rejected', () => {
  it.each(['status', 'priority'])('a JSON number %s fails closed', (field) => {
    withRoute('projects', (router) => {
      const { req, res, flashCalls } = buildReqRes(
        { name: 'Project', status: 'in_progress', priority: 'high', [field]: 5 },
        { id: '1' }
      );
      lastHandlerFor(router, 'put', '/:id')(req, res, () => {});
      expect(errorFlash(flashCalls)).toBe('Invalid request parameters');
      expect(db.prepare().run).not.toHaveBeenCalled();
    });
  });
});

describe('projects task update — non-string status is rejected', () => {
  it('a JSON number status fails closed', () => {
    withRoute('projects', (router) => {
      const { req, res, flashCalls } = buildReqRes(
        { title: 'Task', status: 5 },
        { projectId: '1', taskId: '1' }
      );
      lastHandlerFor(router, 'put', '/:projectId/tasks/:taskId')(req, res, () => {});
      expect(errorFlash(flashCalls)).toBe('Invalid request parameters');
      expect(db.prepare().run).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Assets — non-string condition_rating/status fail closed on update
// ---------------------------------------------------------------------------
describe('assets update — non-string status/condition_rating is rejected', () => {
  it.each(['status', 'condition_rating'])('a JSON number %s fails closed', (field) => {
    withRoute('assets', (router) => {
      const { req, res, flashCalls } = buildReqRes(
        { asset_tag: 'AST-001', name: 'Laptop', category: 'laptop', status: 'in_use', condition_rating: 'good', [field]: 5 },
        { id: '1' }
      );
      lastHandlerFor(router, 'put', '/:id')(req, res, () => {});
      expect(errorFlash(flashCalls)).toBe('Invalid request parameters');
      expect(db.prepare().run).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Licenses — non-string license_type fails closed on CREATE
// ---------------------------------------------------------------------------
describe('licenses create — non-string license_type is rejected', () => {
  it('a JSON number license_type fails closed instead of storing NULL', () => {
    withRoute('licenses', (router) => {
      const { req, res, flashCalls } = buildReqRes(
        { software_name: 'Adobe CC', license_type: 5 },
        {},
        { id: 1, role: 'admin' },
        'POST'
      );
      lastHandlerFor(router, 'post', '/')(req, res, () => {});
      expect(errorFlash(flashCalls)).toBe('Invalid request parameters');
      expect(db.prepare().run).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Knowledge — non-string tags/status fail closed on create AND update
// ---------------------------------------------------------------------------
describe('knowledge create — non-string tags is rejected', () => {
  it('a JSON object tags fails closed instead of wiping stored tags', () => {
    withRoute('knowledge', (router) => {
      const { req, res, flashCalls } = buildReqRes(
        { title: 'Guide', content: 'Body', category: 'how_to', tags: { a: 1 } },
        {},
        { id: 1, role: 'admin' },
        'POST'
      );
      lastHandlerFor(router, 'post', '/')(req, res, () => {});
      expect(errorFlash(flashCalls)).toBe('Invalid request parameters');
      expect(db.prepare().run).not.toHaveBeenCalled();
    });
  });
});

describe('knowledge update — non-string tags is rejected', () => {
  it('a JSON number tags fails closed instead of wiping stored tags', () => {
    db.prepare().get.mockReturnValue({ id: 1, author_id: 2, title: 'Guide', status: 'published', is_featured: 0 });
    withRoute('knowledge', (router) => {
      const { req, res, flashCalls } = buildReqRes(
        { title: 'Guide', content: 'Body', category: 'how_to', tags: 123 },
        { id: '1' }
      );
      lastHandlerFor(router, 'put', '/:id')(req, res, () => {});
      expect(errorFlash(flashCalls)).toBe('Invalid request parameters');
      expect(db.prepare().run).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Staff — absent department/phone preserve the stored values on update
// ---------------------------------------------------------------------------
describe('staff update — absent department/phone preserve stored values', () => {
  function seedStaffRow() {
    db.prepare().get.mockReturnValue({
      id: 1, username: 'jdoe', email: 'jane@example.com', first_name: 'Jane', last_name: 'Doe',
      role: 'staff', department: 'Support', phone: '555-0100', is_active: 1
    });
  }

  it('a partial PUT that omits department/phone keeps the stored values', () => {
    seedStaffRow();
    withRoute('staff', (router) => {
      const { req, res, flashCalls } = buildReqRes(
        { email: 'new@example.com', first_name: 'Jane', last_name: 'Doe', role: 'staff' },
        { id: '1' },
        { id: 99, role: 'admin' }
      );
      lastHandlerFor(router, 'put', '/:id')(req, res, () => {});
      const calls = db.prepare().run.mock.calls;
      expect(calls).toHaveLength(1);
      const args = calls[0];
      expect(args[4]).toBe('Support');
      expect(args[5]).toBe('555-0100');
      expect(flashCalls).toContainEqual(['success', 'Staff member updated']);
    });
  });

  it('an explicit empty string still clears department/phone', () => {
    seedStaffRow();
    withRoute('staff', (router) => {
      const { req, res } = buildReqRes(
        { email: 'new@example.com', first_name: 'Jane', last_name: 'Doe', role: 'staff', department: '', phone: '' },
        { id: '1' },
        { id: 99, role: 'admin' }
      );
      lastHandlerFor(router, 'put', '/:id')(req, res, () => {});
      const calls = db.prepare().run.mock.calls;
      expect(calls).toHaveLength(1);
      const args = calls[0];
      expect(args[4]).toBeNull();
      expect(args[5]).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// reports/assets template — '-' instead of '$0' for unpriced assets
// ---------------------------------------------------------------------------
describe('reports/assets renders "-" for unpriced assets (regression)', () => {
  it('renders a dash instead of a misleading $0', () => {
    const locals = {
      user: { id: 1, first_name: 'Ada', last_name: 'Lovelace', role: 'admin' },
      flash: { success: [], error: [], info: [] },
      currentPage: '/reports/assets',
      csrfToken: 'x',
      localDate: utils.localDate,
      formatDate: utils.formatDate,
      formatDateTime: utils.formatDateTime,
      daysUntil: utils.daysUntil,
      usagePercent: utils.usagePercent,
      isExpiringSoon: utils.isExpiringSoon,
      escapeHtml: utils.escapeHtml,
      isValidEmail: utils.isValidEmail,
      titleCase: utils.titleCase,
      isPrivileged: utils.isPrivileged,
      badgeClass: utils.badgeClass,
      CONDITION_BADGE: require('../src/constants').CONDITION_BADGE,
      CONSTANTS: require('../src/constants'),
      title: 'Asset Report',
      byCategory: [
        { category: 'peripheral', count: 2, total_value: null },
        { category: 'laptop', count: 1, total_value: 5000 }
      ],
      byStatus: [{ status: 'in_use', count: 3 }],
      byCondition: [{ condition_rating: 'good', count: 3 }],
      ageDistribution: [{ age_group: '<1yr', count: 3 }],
      totalValue: { total: 0 },
      warrantyCount: 0,
      warrantyExpiring: []
    };
    const file = path.join(__dirname, '..', 'views', 'pages', 'reports', 'assets.ejs');
    const html = ejs.render(fs.readFileSync(file, 'utf8'), locals, { filename: file });
    expect(html).toContain('<span>Peripheral</span><span>2 · -</span>');
    expect(html).toContain('<span>Laptop</span><span>1 · $5,000</span>');
    expect(html).not.toContain('$0');
  });
});
