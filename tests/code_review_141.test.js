const { describe, it, expect, beforeEach } = require('@jest/globals');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const utils = require('../src/utils');
const constants = require('../src/constants');
const { lastHandlerFor } = require('./helpers');

// Regression tests for review cycle 141: error-page csrfToken guard, per-account
// write limiter keying, tickets update enum preserve-on-absent + PII sentinel,
// projects create spent support, changes list scoping + priority guard,
// licenses non-string key rejection, list link-gating, staff open-task counting,
// dashboard Active Projects definition, report snapshot semantics, audit badge
// severity, knowledge form status options, seed progress consistency.

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

// ---------------------------------------------------------------------------
// 1. header.ejs csrfToken guard (error pages render without locals middleware)
// ---------------------------------------------------------------------------
describe('header.ejs tolerates a missing csrfToken local (regression)', () => {
  const headerFile = path.join(__dirname, '..', 'views', 'partials', 'header.ejs');

  it('renders without throwing when csrfToken is not defined (body-parser error path)', () => {
    const src = fs.readFileSync(headerFile, 'utf8');
    // The global error handler renders pages/error for errors thrown BEFORE
    // the res.locals middleware runs (e.g. a body-parser 413/400) — no
    // csrfToken local exists there, and an unguarded reference previously
    // threw a secondary ReferenceError that downgraded the styled error page
    // to a bare-text 500.
    expect(() => ejs.render(src, {}, { filename: headerFile })).not.toThrow();
    const html = ejs.render(src, {}, { filename: headerFile });
    expect(html).toContain('name="csrf-token" content=""');
  });
});

// ---------------------------------------------------------------------------
// 2. Tickets update — enum preserve-on-absent + requester PII sentinel
// ---------------------------------------------------------------------------
const CURRENT_TICKET = {
  status: 'open', category: 'hardware', priority: 'high',
  assigned_to: 3, asset_id: null, due_date: null,
  description: 'stored description', resolution_notes: 'stored notes',
  requester_name: 'Req', requester_email: 'req@x.io',
  requester_department: 'IT', requester_phone: '555-0100'
};

describe('tickets update — enum fields preserve on absence (regression)', () => {
  it('a partial PUT omitting category/priority/status keeps the stored values', () => {
    db.prepare().get.mockReturnValue({ ...CURRENT_TICKET });
    jest.isolateModules(() => {
      const router = require('../src/routes/tickets');
      const { req, res, flashCalls, reqAuditCalls } = buildReqRes(
        { title: 'Renamed only', requester_name: 'Req', requester_email: 'req@x.io' },
        { id: '1' }
      );
      lastHandlerFor(router, 'put', '/:id')(req, res, () => {});
      expect(errorFlash(flashCalls)).toBeUndefined();
      const args = db.prepare().run.mock.calls[0];
      // UPDATE param order: title, description, category, priority, status, ...
      expect(args[2]).toBe('hardware');
      expect(args[3]).toBe('high');
      expect(args[4]).toBe('open');
      // The audit entry reports the EFFECTIVE status, not the absent field.
      expect(reqAuditCalls[0][3]).toContain('status: open');
    });
  });

  it('still rejects a present-but-invalid enum value', () => {
    db.prepare().get.mockReturnValue({ ...CURRENT_TICKET });
    jest.isolateModules(() => {
      const router = require('../src/routes/tickets');
      const { req, res, flashCalls } = buildReqRes(
        { title: 'T', requester_name: 'Req', requester_email: 'req@x.io', status: 'not-a-status' },
        { id: '1' }
      );
      lastHandlerFor(router, 'put', '/:id')(req, res, () => {});
      expect(errorFlash(flashCalls)).toBe('Invalid status');
      expect(db.prepare().run).not.toHaveBeenCalled();
    });
  });

  it('an absent status on a resolved ticket does not clear resolved_at', () => {
    db.prepare().get.mockReturnValue({ ...CURRENT_TICKET, status: 'resolved' });
    jest.isolateModules(() => {
      const router = require('../src/routes/tickets');
      const { req, res } = buildReqRes(
        { title: 'T', requester_name: 'Req', requester_email: 'req@x.io' },
        { id: '1' }
      );
      lastHandlerFor(router, 'put', '/:id')(req, res, () => {});
      const args = db.prepare().run.mock.calls[0];
      // Param order tail: ..., shouldSet(13), shouldClear(14), id(15).
      // Effective status stays 'resolved' → neither set nor clear.
      expect(args[13]).toBe(0);
      expect(args[14]).toBe(0);
      expect(args[4]).toBe('resolved');
    });
  });

  it('a present non-string requester_department is rejected, not silently wiped', () => {
    db.prepare().get.mockReturnValue({ ...CURRENT_TICKET });
    jest.isolateModules(() => {
      const router = require('../src/routes/tickets');
      const { req, res, flashCalls } = buildReqRes(
        { title: 'T', requester_name: 'Req', requester_email: 'req@x.io', requester_department: 42 },
        { id: '1' }
      );
      lastHandlerFor(router, 'put', '/:id')(req, res, () => {});
      expect(errorFlash(flashCalls)).toBe('Invalid Requester Department');
      expect(db.prepare().run).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Projects — create parses spent; task-add rejects non-string description
// ---------------------------------------------------------------------------
describe('projects create — spent is stored, not silently dropped (regression)', () => {
  it('a submitted spent value reaches the INSERT', () => {
    jest.isolateModules(() => {
      const router = require('../src/routes/projects');
      const { req, res, flashCalls } = buildReqRes(
        { name: 'P', status: 'planning', priority: 'high', budget: '1000', spent: '250' },
        {}, { id: 1, role: 'admin' }, 'POST'
      );
      lastHandlerFor(router, 'post', '/')(req, res, () => {});
      expect(errorFlash(flashCalls)).toBeUndefined();
      const args = db.prepare().run.mock.calls[0];
      // INSERT param order: name, description, status, priority, start, end,
      // budget, spent, owner_id — spent is arg index 7.
      expect(args[7]).toBe(250);
    });
  });

  it('a malformed spent value is rejected instead of coerced to 0', () => {
    jest.isolateModules(() => {
      const router = require('../src/routes/projects');
      const { req, res, flashCalls } = buildReqRes(
        { name: 'P', status: 'planning', priority: 'high', budget: '1000', spent: 'abc' },
        {}, { id: 1, role: 'admin' }, 'POST'
      );
      lastHandlerFor(router, 'post', '/')(req, res, () => {});
      expect(errorFlash(flashCalls)).toBe('Invalid spent amount');
      expect(db.prepare().run).not.toHaveBeenCalled();
    });
  });
});

describe('projects task-add — non-string description is rejected (regression)', () => {
  it('a JSON number description fails closed with Invalid request parameters', () => {
    jest.isolateModules(() => {
      const router = require('../src/routes/projects');
      const { req, res, flashCalls } = buildReqRes(
        { title: 'Task', description: 42 },
        { id: '1' }, { id: 1, role: 'admin' }, 'POST'
      );
      lastHandlerFor(router, 'post', '/:id/tasks')(req, res, () => {});
      expect(errorFlash(flashCalls)).toBe('Invalid request parameters');
      expect(db.prepare().run).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Changes — list scoped for staff; update rejects non-string priority
// ---------------------------------------------------------------------------
describe('changes list is scoped to assigned changes for staff (regression)', () => {
  it('staff: the listing WHERE carries the ownership predicate and the user id', () => {
    jest.isolateModules(() => {
      const router = require('../src/routes/changes');
      const { req, res } = buildReqRes({}, {}, { id: 5, role: 'staff' }, 'GET');
      lastHandlerFor(router, 'get', '/')(req, res, () => {});
      const listingSql = db.prepare.mock.calls
        .map(c => c[0])
        .find(sql => typeof sql === 'string' && sql.includes('FROM change_log c') && sql.includes('LIMIT ? OFFSET ?'));
      expect(listingSql).toBeTruthy();
      expect(listingSql).toContain('c.assigned_to = ?');
      // selectQuery spreads [...params, limit, offset] — the staff user id
      // must be a bound parameter of the listing call.
      const allCalls = db.prepare().all.mock.calls;
      expect(allCalls.some(args => args.includes(5))).toBe(true);
    });
  });

  it('admin: the listing WHERE has no ownership predicate', () => {
    jest.isolateModules(() => {
      const router = require('../src/routes/changes');
      const { req, res } = buildReqRes({}, {}, { id: 1, role: 'admin' }, 'GET');
      lastHandlerFor(router, 'get', '/')(req, res, () => {});
      const listingSql = db.prepare.mock.calls
        .map(c => c[0])
        .find(sql => typeof sql === 'string' && sql.includes('FROM change_log c') && sql.includes('LIMIT ? OFFSET ?'));
      expect(listingSql).toBeTruthy();
      expect(listingSql).not.toContain('c.assigned_to = ?');
    });
  });
});

describe('changes update — non-string priority is rejected (regression)', () => {
  it('a JSON number priority fails closed instead of silently preserving', () => {
    db.prepare().get.mockReturnValue({
      id: 1, title: 'Old', description: null, change_type: 'maintenance', status: 'scheduled',
      priority: 'high', scheduled_start: null, scheduled_end: null, actual_start: null,
      actual_end: null, impact: null, assigned_to: null
    });
    jest.isolateModules(() => {
      const router = require('../src/routes/changes');
      const { req, res, flashCalls } = buildReqRes(
        { title: 'T', change_type: 'maintenance', status: 'scheduled', priority: 42 },
        { id: '1' }
      );
      lastHandlerFor(router, 'put', '/:id')(req, res, () => {});
      expect(errorFlash(flashCalls)).toBe('Invalid priority');
      expect(db.prepare().run).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// 5. Licenses — update rejects a present non-string license key
// ---------------------------------------------------------------------------
describe('licenses update — non-string license_key is rejected (regression)', () => {
  it('a numeric JSON key fails closed instead of being silently discarded', () => {
    jest.isolateModules(() => {
      const router = require('../src/routes/licenses');
      const { req, res, flashCalls } = buildReqRes(
        { software_name: 'Photoshop', license_key: 1234567890123 },
        { id: '1' }
      );
      lastHandlerFor(router, 'put', '/:id')(req, res, () => {});
      expect(errorFlash(flashCalls)).toBe('Invalid license key');
      expect(db.prepare().run).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Vendors — rename audit records the license-reference side effect
// ---------------------------------------------------------------------------
describe('vendors rename — audit details include the license sync count (regression)', () => {
  it('renaming a vendor with 3 dependent licenses records the side effect', () => {
    const vendorRow = {
      id: 1, name: 'Old Co', contact_person: null, email: null, phone: null,
      address: null, website: null, category: 'hardware', notes: null, rating: 4,
      contract_start: null, contract_end: null, is_active: 1,
      // _licenseDependentsCountStmt.get(...).cnt — the shared mock stmt
      // returns the same object; the count rides along as .cnt.
      cnt: 3
    };
    // One-arg .get calls return the vendor row (show stmt, license count stmt);
    // the two-arg _vendorNameExistsStmt.get(name, id) call returns null so the
    // rename passes the duplicate-name guard.
    db.prepare().get.mockImplementation((...args) => (args.length === 1 ? { ...vendorRow } : null));
    jest.isolateModules(() => {
      const router = require('../src/routes/vendors');
      const { req, res, reqAuditCalls, flashCalls } = buildReqRes(
        { name: 'New Co' },
        { id: '1' }
      );
      lastHandlerFor(router, 'put', '/:id')(req, res, () => {});
      expect(errorFlash(flashCalls)).toBeUndefined();
      expect(reqAuditCalls.length).toBeGreaterThan(0);
      expect(reqAuditCalls[0][3]).toContain('3 license reference(s) updated');
    });
  });
});

// ---------------------------------------------------------------------------
// 7. Template regressions
// ---------------------------------------------------------------------------
const baseViewLocals = () => ({
  user: { id: 5, first_name: 'S', last_name: 'T', role: 'staff', email: 's@x.io', department: 'IT' },
  flash: { success: [], error: [], info: [] },
  currentPage: '/tickets',
  csrfToken: 't',
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
  CONDITION_BADGE: constants.CONDITION_BADGE,
  CHANGE_TYPE_BADGE: constants.CHANGE_TYPE_BADGE,
  ROLE_BADGE: constants.ROLE_BADGE,
  MEMBER_ROLE_BADGE: constants.MEMBER_ROLE_BADGE,
  KB_CATEGORY_BADGE: constants.KB_CATEGORY_BADGE,
  LICENSE_TYPE_BADGE: constants.LICENSE_TYPE_BADGE,
  CONSTANTS: constants
});

function renderView(relPath, locals) {
  const file = path.join(__dirname, '..', 'views', 'pages', relPath);
  const src = fs.readFileSync(file, 'utf8');
  return ejs.render(src, locals, { filename: file });
}

describe('list templates link only rows the viewer can open (regression)', () => {
  it('tickets/index links own rows for staff, plain text for others', () => {
    const locals = baseViewLocals();
    Object.assign(locals, {
      title: 'Tickets',
      tickets: [
        { id: 1, ticket_number: 'TK-1', title: 'mine', requester_name: 'R', category: 'hardware', priority: 'high', status: 'open', assigned_to: 5, assigned_name: 'Me', created_at: '2026-01-01 10:00:00' },
        { id: 2, ticket_number: 'TK-2', title: 'theirs', requester_name: 'R', category: 'hardware', priority: 'high', status: 'open', assigned_to: 9, assigned_name: 'Other', created_at: '2026-01-01 10:00:00' }
      ],
      staff: [],
      filters: {},
      page: 1, limit: 25, totalPages: 1, total: 2,
      baseUrl: '/tickets'
    });
    const html = renderView('tickets/index.ejs', locals);
    expect(html).toContain('href="/tickets/1"');
    expect(html).not.toContain('href="/tickets/2"');
    expect(html).toContain('TK-2'); // row still visible — queue awareness kept
  });

  it('assets/index links own rows for staff, plain text for others', () => {
    const locals = baseViewLocals();
    Object.assign(locals, {
      title: 'Assets',
      assets: [
        { id: 1, asset_tag: 'AST-001', name: 'Laptop', manufacturer: 'Dell', category: 'laptop', status: 'in_use', condition_rating: 'good', assigned_to: 5, assigned_name: 'Me', location: 'DC1' },
        { id: 2, asset_tag: 'AST-002', name: 'Server', manufacturer: 'HP', category: 'server', status: 'in_use', condition_rating: 'good', assigned_to: 9, assigned_name: 'Other', location: 'DC2' }
      ],
      staff: [],
      filters: {},
      page: 1, limit: 25, totalPages: 1, total: 2,
      baseUrl: '/assets'
    });
    const html = renderView('assets/index.ejs', locals);
    expect(html).toContain('href="/assets/1"');
    expect(html).not.toContain('href="/assets/2"');
  });

  it('projects/index hides the link AND the budget line from a non-owner staff user', () => {
    const locals = baseViewLocals();
    Object.assign(locals, {
      title: 'Projects',
      projects: [
        { id: 1, name: 'theirs', description: 'd', status: 'in_progress', priority: 'high', progress: 10, owner_id: 9, owner_name: 'Other', start_date: null, end_date: null, budget: 5000, spent: 100, task_count: 0, done_count: 0 }
      ],
      filters: {},
      page: 1, limit: 25, totalPages: 1, total: 1,
      baseUrl: '/projects'
    });
    const html = renderView('projects/index.ejs', locals);
    expect(html).not.toContain('href="/projects/1"');
    expect(html).not.toContain('$5,000');
    // An admin still sees the link and the budget line.
    const adminLocals = { ...locals, user: { id: 1, role: 'admin', first_name: 'A', last_name: 'B' } };
    const adminHtml = renderView('projects/index.ejs', adminLocals);
    expect(adminHtml).toContain('href="/projects/1"');
    expect(adminHtml).toContain('$5,000');
  });
});

describe('licenses index renders "-" for unpriced (cost 0) licenses (regression)', () => {
  it('matches the show page convention instead of a misleading $0', () => {
    const locals = baseViewLocals();
    locals.user = { id: 1, role: 'admin', first_name: 'A', last_name: 'B' };
    Object.assign(locals, {
      title: 'Licenses',
      licenses: [
        { id: 1, software_name: 'Free', vendor: null, license_type: 'open_source', used_seats: 1, total_seats: 5, expiry_date: null, cost: 0 },
        { id: 2, software_name: 'Paid', vendor: null, license_type: 'open_source', used_seats: 1, total_seats: 5, expiry_date: null, cost: 1200 }
      ],
      filters: {},
      page: 1, limit: 25, totalPages: 1, total: 2,
      baseUrl: '/licenses'
    });
    const html = renderView('licenses/index.ejs', locals);
    expect(html).not.toContain('$0');
    expect(html).toContain('$1,200');
  });
});

describe('dashboard Active Projects counts planning + in_progress + on_hold (regression)', () => {
  it('renders the app-wide active-project definition', () => {
    const locals = baseViewLocals();
    Object.assign(locals, {
      title: 'Dashboard',
      ticketStats: { total: 0, open: 0, in_progress: 0, waiting: 0, resolved: 0, closed: 0, critical_open: 0 },
      assetStats: { total: 0, in_use: 0, in_storage: 0, in_repair: 0, reserved: 0 },
      projectStats: { total: 9, in_progress: 3, planning: 2, completed: 0, on_hold: 4 },
      staffCount: { total: 1 },
      expiringWarranties: [],
      expiringWarrantiesCount: 0,
      licenseAlerts: [],
      licenseAlertsCount: 0,
      upcomingChanges: [],
      ticketsByCategory: [],
      staffWorkload: [],
      myTickets: [],
      recentTickets: []
    });
    const html = renderView('dashboard.ejs', locals);
    expect(html).toContain('>9<');
  });
});

describe('staff show — Edit button mirrors the edit route gate (regression)', () => {
  function renderStaffShow(viewer, target) {
    const locals = baseViewLocals();
    Object.assign(locals, {
      title: 'Staff',
      staffUser: target,
      assignedTickets: [],
      assignedTasks: [],
      projectMemberships: [],
      assignedAssets: []
    });
    locals.user = viewer;
    return renderView('staff/show.ejs', locals);
  }

  it('a manager viewing an admin sees no Edit button (route always denies)', () => {
    const html = renderStaffShow(
      { id: 2, role: 'manager', first_name: 'M', last_name: 'G' },
      { id: 1, role: 'admin', first_name: 'A', last_name: 'B', is_active: 1 }
    );
    expect(html).not.toContain('/edit');
  });

  it('a manager viewing their own manager profile sees no Edit button either', () => {
    const html = renderStaffShow(
      { id: 2, role: 'manager', first_name: 'M', last_name: 'G' },
      { id: 2, role: 'manager', first_name: 'M', last_name: 'G', is_active: 1 }
    );
    expect(html).not.toContain('/edit');
  });

  it('a manager viewing a staff account and an admin viewing anyone see the button', () => {
    const mgrViewingStaff = renderStaffShow(
      { id: 2, role: 'manager', first_name: 'M', last_name: 'G' },
      { id: 3, role: 'staff', first_name: 'S', last_name: 'T', is_active: 1 }
    );
    expect(mgrViewingStaff).toContain('href="/staff/3/edit"');
    const adminViewingMgr = renderStaffShow(
      { id: 1, role: 'admin', first_name: 'A', last_name: 'B' },
      { id: 2, role: 'manager', first_name: 'M', last_name: 'G', is_active: 1 }
    );
    expect(adminViewingMgr).toContain('href="/staff/2/edit"');
  });
});

describe('report templates render empty states (regression)', () => {
  it('reports/staff renders a no-data row for an empty roster', () => {
    const locals = baseViewLocals();
    Object.assign(locals, { title: 'Staff Performance', performance: [], period: 30 });
    const html = renderView('reports/staff.ejs', locals);
    expect(html).toContain('No active staff to report on');
  });

  it('reports/tickets renders empty states for byPriority and topResolvers', () => {
    const locals = baseViewLocals();
    Object.assign(locals, {
      title: 'Ticket Analytics',
      ticketsByDay: [], byCategory: [], byPriority: [],
      avgResolution: { avg_days: null }, slaStats: { total_resolved: 0 },
      topResolvers: [], period: 30
    });
    const html = renderView('reports/tickets.ejs', locals);
    expect(html).toContain('No data for this period');
    expect(html).toContain('No resolutions recorded in this period');
  });
});

describe('audit index badges security actions as critical (regression)', () => {
  it('login_blocked / login_rate_limited / access_denied render badge-critical', () => {
    const locals = baseViewLocals();
    Object.assign(locals, {
      title: 'Audit Log',
      entries: [
        { created_at: '2026-01-01 10:00:00', user_name: 'u', action: 'login_blocked', entity_type: 'user', entity_id: 1, ip_address: '127.0.0.1', details: 'd' },
        { created_at: '2026-01-01 10:00:01', user_name: 'u', action: 'login_rate_limited', entity_type: 'user', entity_id: 1, ip_address: '127.0.0.1', details: 'd' },
        { created_at: '2026-01-01 10:00:02', user_name: 'u', action: 'access_denied', entity_type: 'ticket', entity_id: 1, ip_address: '127.0.0.1', details: 'd' },
        { created_at: '2026-01-01 10:00:03', user_name: 'u', action: 'read', entity_type: 'ticket', entity_id: 1, ip_address: '127.0.0.1', details: 'd' }
      ],
      filters: {},
      page: 1, limit: 25, totalPages: 1, total: 4,
      baseUrl: '/audit'
    });
    const html = renderView('audit/index.ejs', locals);
    expect(html.match(/badge-critical/g).length).toBe(3);
    expect(html).toContain('badge-medium');
  });
});

describe('knowledge form offers only effective status options to staff (regression)', () => {
  const formFile = path.join(__dirname, '..', 'views', 'pages', 'knowledge', 'form.ejs');

  it('a staff author creating an article sees only the draft option', () => {
    const locals = baseViewLocals();
    Object.assign(locals, { title: 'New Article', article: {}, isEdit: false });
    const html = ejs.render(fs.readFileSync(formFile, 'utf8'), locals, { filename: formFile });
    expect(html.match(/<option value="/g).length).toBeGreaterThanOrEqual(3); // category options + draft
    expect(html).toContain('<option value="draft"');
    expect(html).not.toContain('<option value="published"');
    expect(html).not.toContain('<option value="archived"');
  });

  it('a staff author editing a published article sees draft + published only', () => {
    const locals = baseViewLocals();
    Object.assign(locals, { title: 'Edit Article', article: { id: 1, status: 'published', category: 'networking' }, isEdit: true });
    const html = ejs.render(fs.readFileSync(formFile, 'utf8'), locals, { filename: formFile });
    expect(html).toContain('<option value="draft"');
    expect(html).toContain('<option value="published"');
    expect(html).not.toContain('<option value="archived"');
  });

  it('a privileged author sees all three status options', () => {
    const locals = baseViewLocals();
    locals.user = { id: 1, role: 'admin', first_name: 'A', last_name: 'B' };
    Object.assign(locals, { title: 'New Article', article: {}, isEdit: false });
    const html = ejs.render(fs.readFileSync(formFile, 'utf8'), locals, { filename: formFile });
    expect(html).toContain('<option value="draft"');
    expect(html).toContain('<option value="published"');
    expect(html).toContain('<option value="archived"');
  });
});

// ---------------------------------------------------------------------------
// 8. Source-level guards
// ---------------------------------------------------------------------------
describe('source-level guards (regression)', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  it('app.js keys the global write limiter per account (authKeyGenerator)', () => {
    const src = read('src/app.js');
    // The per-IP default let one NAT'd office share a single 100-write/15-min
    // budget across all mounts — the opposite of the per-account convention
    // every authenticated limiter documents.
    expect(src).toContain('keyGenerator: utilsModule.authKeyGenerator');
  });

  it('tickets list SELECT exposes assigned_to for template link gating', () => {
    const src = read('src/routes/tickets.js');
    expect(src).toMatch(/SELECT t\.id, t\.ticket_number, t\.title, t\.requester_name, t\.category, t\.priority, t\.status, t\.assigned_to, t\.created_at/);
  });

  it('staff directory open-task count uses status != done (review counts as open)', () => {
    const src = read('src/routes/staff.js');
    expect(src).toContain('FROM project_tasks WHERE status != \'done\'');
  });

  it('reports staffPerformance is called with the two period params only', () => {
    const src = read('src/routes/reports.js');
    expect(src).toContain('stmts.staffPerformance.all(period, period)');
    expect(src).not.toContain('stmts.staffPerformance.all(period, period, period)');
  });

  it('seed pins recalc-consistent progress: taskless projects 0, completed project 1/1', () => {
    const src = read('src/seed.js');
    expect(src).toContain('progress: 0, owner_id: 2'); // Zero Trust: taskless → 0
    // 'progress: 5,' must not reappear (a taskless seeded 5% would snap to 0
    // on the first task edit). The comma suffix avoids matching 'progress: 50,'.
    expect(src).not.toContain('progress: 5,');
    // Project 5 (completed, progress 100) must own a done task (1/1 = 100).
    expect(src).toContain("project_id: 5, title: 'HVAC unit replacement'");
  });

  it('README documents SEED_VERBOSE and the full env-var surface', () => {
    const readme = read('README.md');
    expect(readme).toContain('SEED_VERBOSE=1 npm run seed');
    expect(readme).toContain('SESSION_IDLE_TIMEOUT_SECONDS');
    expect(readme).toContain('SESSION_ABSOLUTE_TIMEOUT_SECONDS');
    expect(readme).toContain('SEED_DANGER');
    // Structure tree mentions the client-side JS layer.
    expect(readme).toContain('js/');
  });
});
