const { describe, it, expect, beforeEach } = require('@jest/globals');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const utils = require('../src/utils');
const constants = require('../src/constants');
const { lastHandlerFor } = require('./helpers');

// Regression tests for review cycle 140: partial-update field preservation on
// assets/tickets, INVALID_ sentinel mapping on licenses updates, task status
// preserve-on-absent, staff access_denied auditing, safeId strict parsing,
// dashboard alert wording/count wiring, and the vendor role-gate policy.

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

function buildReqRes(body, params, sessionUser = { id: 1, role: 'admin' }, method = 'PUT') {
  const flashCalls = [];
  const redirectCalls = [];
  const reqAuditCalls = [];
  const req = {
    body,
    params,
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
    render: () => {},
    status: () => res,
    json: () => {},
    headersSent: false
  };
  return { req, res, flashCalls, redirectCalls, reqAuditCalls };
}

function errorFlash(flashCalls) {
  const found = flashCalls.find(([t]) => t === 'error');
  return found ? found[1] : undefined;
}

const CURRENT_ASSET = {
  id: 1, asset_tag: 'AST-001', name: 'Laptop', category: 'laptop',
  manufacturer: 'Dell', model: 'Latitude', serial_number: 'SN-1',
  status: 'in_storage', condition_rating: 'good', purchase_date: null,
  purchase_price: null, warranty_expiry: null, assigned_to: null,
  location: 'DC1', notes: 'keep these notes'
};

describe('assets update preserves absent optional text fields (regression)', () => {
  const db = jest.requireMock('../src/models/database');
  beforeEach(() => {
    db.prepare().get.mockReset();
    db.prepare().run.mockReset();
    db.prepare().run.mockReturnValue({ changes: 1, lastInsertRowid: 1 });
    db.transaction.mockReset();
    db.transaction.mockImplementation((fn) => fn);
  });

  it('a partial PUT without manufacturer/model/serial/location/notes keeps the stored values', () => {
    db.prepare().get.mockReturnValue({ ...CURRENT_ASSET });
    jest.isolateModules(() => {
      const router = require('../src/routes/assets');
      const { req, res, flashCalls } = buildReqRes(
        { asset_tag: 'AST-001', name: 'Renamed', category: 'laptop' },
        { id: '1' }
      );
      lastHandlerFor(router, 'put', '/:id')(req, res, () => {});
      expect(errorFlash(flashCalls)).toBeUndefined();
      const args = db.prepare().run.mock.calls[0];
      // UPDATE param order: tag, name, category, manufacturer, model, serial,
      // status, condition, purchase, price, warranty, assignee, location, notes, id
      expect(args[3]).toBe('Dell');
      expect(args[4]).toBe('Latitude');
      expect(args[5]).toBe('SN-1');
      expect(args[12]).toBe('DC1');
      expect(args[13]).toBe('keep these notes');
    });
  });

  it('a present non-string notes value is rejected as Invalid Notes, not a server error', () => {
    db.prepare().get.mockReturnValue({ ...CURRENT_ASSET });
    jest.isolateModules(() => {
      const router = require('../src/routes/assets');
      const { req, res, flashCalls, redirectCalls } = buildReqRes(
        { asset_tag: 'AST-001', name: 'Renamed', category: 'laptop', notes: 123 },
        { id: '1' }
      );
      lastHandlerFor(router, 'put', '/:id')(req, res, () => {});
      expect(errorFlash(flashCalls)).toBe('Invalid Notes');
      expect(redirectCalls).toEqual(['/assets/1/edit']);
    });
  });

  it('an explicit empty string still clears the stored value (form clear)', () => {
    db.prepare().get.mockReturnValue({ ...CURRENT_ASSET });
    jest.isolateModules(() => {
      const router = require('../src/routes/assets');
      const { req, res, flashCalls } = buildReqRes(
        { asset_tag: 'AST-001', name: 'Renamed', category: 'laptop', notes: '' },
        { id: '1' }
      );
      lastHandlerFor(router, 'put', '/:id')(req, res, () => {});
      expect(errorFlash(flashCalls)).toBeUndefined();
      const args = db.prepare().run.mock.calls[0];
      expect(args[13]).toBeNull(); // empty string cleared the notes
    });
  });
});

describe('assets create rejects present non-string optional text fields (regression)', () => {
  const db = jest.requireMock('../src/models/database');
  beforeEach(() => {
    db.transaction.mockReset();
    db.transaction.mockImplementation((fn) => fn);
  });

  it('a numeric serial_number is rejected instead of silently storing NULL', () => {
    jest.isolateModules(() => {
      const router = require('../src/routes/assets');
      const { req, res, flashCalls } = buildReqRes(
        { name: 'New', category: 'laptop', serial_number: 12345 },
        {},
        { id: 1, role: 'admin' },
        'POST'
      );
      lastHandlerFor(router, 'post', '/')(req, res, () => {});
      expect(errorFlash(flashCalls)).toBe('Invalid request parameters');
    });
  });
});

describe('tickets update preserves absent description/resolution_notes (regression)', () => {
  const db = jest.requireMock('../src/models/database');
  beforeEach(() => {
    db.prepare().get.mockReset();
    db.prepare().get.mockReturnValue({
      status: 'open', assigned_to: null, asset_id: null, due_date: null,
      description: 'original description', resolution_notes: 'original notes',
      requester_name: 'Req', requester_email: 'r@x.com',
      requester_department: 'IT', requester_phone: null
    });
    db.prepare().run.mockReset();
    db.prepare().run.mockReturnValue({ changes: 1, lastInsertRowid: 1 });
    db.transaction.mockReset();
    db.transaction.mockImplementation((fn) => fn);
  });

  it('a partial PUT omitting description and resolution_notes keeps both stored values', () => {
    jest.isolateModules(() => {
      const router = require('../src/routes/tickets');
      const { req, res, flashCalls } = buildReqRes(
        { title: 'T', category: 'hardware', priority: 'high', status: 'open', requester_name: 'Req', requester_email: 'r@x.com' },
        { id: '1' }
      );
      lastHandlerFor(router, 'put', '/:id')(req, res, () => {});
      expect(errorFlash(flashCalls)).toBeUndefined();
      const args = db.prepare().run.mock.calls[0];
      // UPDATE param order: title, description, category, priority, status,
      // assignee, asset, due_date, resolution_notes, name, email, dept, phone
      expect(args[1]).toBe('original description');
      expect(args[8]).toBe('original notes');
    });
  });

  it('a present non-string description is rejected as Invalid Description', () => {
    jest.isolateModules(() => {
      const router = require('../src/routes/tickets');
      const { req, res, flashCalls, redirectCalls } = buildReqRes(
        { title: 'T', category: 'hardware', priority: 'high', status: 'open', requester_name: 'Req', requester_email: 'r@x.com', description: 42 },
        { id: '1' }
      );
      lastHandlerFor(router, 'put', '/:id')(req, res, () => {});
      expect(errorFlash(flashCalls)).toBe('Invalid Description');
      expect(redirectCalls).toEqual(['/tickets/1/edit']);
    });
  });
});

describe('licenses update maps INVALID_ sentinels to validation flashes (regression)', () => {
  const db = jest.requireMock('../src/models/database');
  beforeEach(() => {
    db.prepare().get.mockReset();
    db.prepare().get.mockReturnValue({
      id: 1, software_name: 'Soft', vendor: 'OldVendor', license_key: 'K-1',
      license_type: null, total_seats: 10, used_seats: 2, purchase_date: null,
      expiry_date: null, cost: 100, notes: null, created_at: '2026-01-01', updated_at: '2026-01-01'
    });
    db.prepare().run.mockReset();
    db.prepare().run.mockReturnValue({ changes: 1, lastInsertRowid: 1 });
    db.transaction.mockReset();
    db.transaction.mockImplementation((fn) => fn);
  });

  it('a non-string vendor value flashes "Invalid Vendor", not the generic server error', () => {
    // Regression: the update transaction threw INVALID_VENDOR /
    // INVALID_LICENSE_TYPE / INVALID_NOTES but the catch block never handled
    // them, surfacing a client validation error as "Error updating license.
    // Please try again."
    jest.isolateModules(() => {
      const router = require('../src/routes/licenses');
      const { req, res, flashCalls, redirectCalls } = buildReqRes(
        { software_name: 'Soft', vendor: 5 },
        { id: '1' }
      );
      lastHandlerFor(router, 'put', '/:id')(req, res, () => {});
      expect(errorFlash(flashCalls)).toBe('Invalid Vendor');
      expect(redirectCalls).toEqual(['/licenses/1/edit']);
    });
  });
});

describe('licenses create rejects present non-string text fields (regression)', () => {
  const db = jest.requireMock('../src/models/database');
  beforeEach(() => {
    db.transaction.mockReset();
    db.transaction.mockImplementation((fn) => fn);
  });

  it('a numeric license_key is rejected instead of silently storing NULL', () => {
    // Regression: numeric keys are a realistic JSON submission; trim() coerced
    // them to '' and the create route flashed success while storing NULL.
    jest.isolateModules(() => {
      const router = require('../src/routes/licenses');
      const { req, res, flashCalls } = buildReqRes(
        { software_name: 'Soft', license_key: 1234567890123 },
        {},
        { id: 1, role: 'admin' },
        'POST'
      );
      lastHandlerFor(router, 'post', '/')(req, res, () => {});
      expect(errorFlash(flashCalls)).toBe('Invalid request parameters');
    });
  });
});

describe('project task full-update preserves an absent status (regression)', () => {
  const db = jest.requireMock('../src/models/database');
  beforeEach(() => {
    db.prepare().get.mockReset();
    db.prepare().get.mockReturnValue({
      id: 5, project_id: 1, title: 'Task', description: 'd', status: 'done',
      priority: 'high', assigned_to: null, due_date: null,
      completed_at: '2026-01-01', created_at: '2026-01-01', updated_at: '2026-01-01'
    });
    db.prepare().all.mockReset();
    db.prepare().all.mockReturnValue({ total: 1, done: 1 });
    db.prepare().run.mockReset();
    db.prepare().run.mockReturnValue({ changes: 1, lastInsertRowid: 1 });
    db.transaction.mockReset();
    db.transaction.mockImplementation((fn) => fn);
  });

  it('a rename-only PUT keeps the stored done status and completion timestamp flag', () => {
    // Regression: the full-update route required `status`, so a valid partial
    // PUT that only renamed a task failed with "Invalid task status" — and a
    // naive fix would have clobbered completed_at via the status flag.
    jest.isolateModules(() => {
      const router = require('../src/routes/projects');
      const { req, res, flashCalls } = buildReqRes(
        { title: 'Renamed' },
        { projectId: '1', taskId: '5' }
      );
      lastHandlerFor(router, 'put', '/:projectId/tasks/:taskId')(req, res, () => {});
      expect(errorFlash(flashCalls)).toBeUndefined();
      const args = db.prepare().run.mock.calls[0];
      // UPDATE param order: title, description, status, priority, assignee,
      // due_date, completed_flag, taskId, projectId
      expect(args[2]).toBe('done');
      expect(args[6]).toBe(1); // completed_at preserved (COALESCE branch)
    });
  });
});

describe('staff show/edit denials leave an audit trail (regression)', () => {
  it('a staff user viewing another staff profile emits access_denied/user', () => {
    jest.isolateModules(() => {
      const router = require('../src/routes/staff');
      const { req, res, reqAuditCalls, redirectCalls } = buildReqRes(
        {},
        { id: '2' },
        { id: 1, role: 'staff' },
        'GET'
      );
      lastHandlerFor(router, 'get', '/:id')(req, res, () => {});
      const denied = reqAuditCalls.filter((a) => a[0] === 'access_denied');
      expect(denied).toHaveLength(1);
      expect(denied[0][1]).toBe('user');
      expect(denied[0][2]).toBe(2);
      expect(redirectCalls).toEqual(['/staff']);
    });
  });

  it('a manager opening an admin edit form emits access_denied/user', () => {
    const db = jest.requireMock('../src/models/database');
    db.prepare().get.mockReset();
    db.prepare().get.mockReturnValue({ id: 3, role: 'admin', username: 'a', email: 'a@x.com', first_name: 'A', last_name: 'B' });
    jest.isolateModules(() => {
      const router = require('../src/routes/staff');
      const { req, res, reqAuditCalls } = buildReqRes(
        {},
        { id: '3' },
        { id: 2, role: 'manager' },
        'GET'
      );
      lastHandlerFor(router, 'get', '/:id/edit')(req, res, () => {});
      const denied = reqAuditCalls.filter((a) => a[0] === 'access_denied');
      expect(denied).toHaveLength(1);
      expect(denied[0][1]).toBe('user');
    });
  });
});

describe('safeId requires canonical integer strings (regression)', () => {
  it('rejects prefix-parsed ids that would target a different record', () => {
    // Regression: safeId('12abc') parsed to 12 via parseInt, so
    // GET /tickets/12abc rendered ticket 12 instead of a 404 — diverging from
    // the strict /^[1-9]\d*$/ contract isPresentInvalidId enforces for form ids.
    expect(utils.safeId('12abc')).toBeNull();
    expect(utils.safeId('1e5')).toBeNull();
    expect(utils.safeId('+5')).toBeNull();
    expect(utils.safeId('05')).toBeNull();
    expect(utils.safeId(' 12')).toBe(12); // surrounding whitespace is trimmed, not prefix-parsed
    expect(utils.safeId('12 ')).toBe(12);
    expect(utils.safeId('123')).toBe(123);
    expect(utils.safeId(456)).toBe(456);
  });
});

describe('dashboard alert count wiring and wording (regression)', () => {
  const views = path.join(__dirname, '..', 'views', 'pages', 'dashboard.ejs');
  const src = fs.readFileSync(views, 'utf8');

  function renderDashboard(locals) {
    return ejs.render(src, locals, { filename: views });
  }

  const baseLocals = () => ({
    user: { id: 1, first_name: 'A', last_name: 'B', role: 'admin', email: 'a@x.com', department: 'IT' },
    flash: { success: [], error: [], info: [] },
    currentPage: '/dashboard',
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
    CONSTANTS: constants,
    title: 'Dashboard',
    ticketStats: { total: 3, open: 1, in_progress: 1, waiting: 1, resolved: 0, closed: 0, critical_open: 0 },
    assetStats: { total: 0, in_use: 0, in_storage: 0, in_repair: 0, reserved: 0 },
    projectStats: { total: 0, in_progress: 0, planning: 0, completed: 0, on_hold: 0 },
    staffCount: { total: 0 },
    expiringWarranties: [{ id: 1, name: 'a', asset_tag: 'AST-001', warranty_expiry: '2026-01-01' }],
    expiringWarrantiesCount: 25,
    licenseAlerts: [{ id: 1, software_name: 's', vendor: null, expiry_date: '2026-01-01' }],
    licenseAlertsCount: 22,
    upcomingChanges: [],
    ticketsByCategory: [],
    staffWorkload: [],
    myTickets: [],
    recentTickets: []
  });

  it('renders the uncapped count, not the capped list length, in the alert cards', () => {
    const html = renderDashboard(baseLocals());
    expect(html).toContain('25 asset(s) with a warranty expired or expiring within 30 days');
    expect(html).toContain('22 software license(s) expired or expiring within 30 days');
    expect(html).not.toContain('1 asset(s)');
    expect(html).not.toContain('1 software license(s)');
  });

  it('counts waiting tickets in the Active Tickets stat card', () => {
    const html = renderDashboard(baseLocals());
    // open(1) + in_progress(1) + waiting(1) — the app-wide active definition.
    expect(html).toContain('>3<');
  });

  it('renders an empty state for the recently-active card when no open tickets exist', () => {
    const locals = baseLocals();
    locals.recentTickets = [];
    const html = renderDashboard(locals);
    expect(html).toContain('No open tickets');
  });
});

describe('nav hides the Vendors link from non-privileged users (regression)', () => {
  const navFile = path.join(__dirname, '..', 'views', 'partials', 'nav.ejs');
  const navSrc = fs.readFileSync(navFile, 'utf8');

  function renderNav(user) {
    return ejs.render(navSrc, {
      user,
      flash: { success: [], error: [], info: [] },
      currentPage: '/dashboard',
      csrfToken: 't',
      title: 'T',
      titleCase: (s) => s,
      isPrivileged: (u) => u && (u.role === 'admin' || u.role === 'manager')
    }, { filename: navFile });
  }

  it('staff users do not see the Vendors nav item; admins do', () => {
    expect(renderNav({ id: 1, role: 'staff', first_name: 'S', last_name: 'T' })).not.toContain('href="/vendors"');
    expect(renderNav({ id: 1, role: 'admin', first_name: 'A', last_name: 'B' })).toContain('href="/vendors"');
  });

  it('the vendors link sits inside the privileged block in source order', () => {
    const privilegedStart = navSrc.indexOf('<% if (isPrivileged(user)) { %>');
    const vendorsAt = navSrc.indexOf('href="/vendors"');
    const licensesAt = navSrc.indexOf('href="/licenses"');
    expect(licensesAt).toBeGreaterThan(privilegedStart);
    expect(vendorsAt).toBeGreaterThan(privilegedStart);
  });
});

describe('source-level guards (regression)', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  it('seed progress values match recalcProjectProgress (2/5 = 40, 2/4 = 50)', () => {
    const seedSrc = read('src/seed.js');
    expect(seedSrc).toContain('progress: 40');
    expect(seedSrc).toContain('progress: 50');
    expect(seedSrc).not.toContain('progress: 35');
    expect(seedSrc).not.toContain('progress: 65');
  });

  it('app.js floors the idle timeout at the lastAccess throttle interval', () => {
    // Regression: the comment claimed a ">= 5 minutes" floor that no code
    // enforced; a sub-60s idle window falsely expired continuously-active
    // users because lastAccess can be up to 60s stale.
    const appSrc = read('src/app.js');
    expect(appSrc).toMatch(/SESSION_IDLE_TIMEOUT_SECONDS = Math\.max\(_LAST_ACCESS_THROTTLE_MS \/ 1000, _parsePositiveSeconds\(/);
  });

  it('vendors.js no longer gates the show route through the ownership-field helper', () => {
    const vendorsSrc = read('src/routes/vendors.js');
    const importMatch = vendorsSrc.match(/const \{[^}]*\} = require\('[^']*middleware\/auth'\);/);
    expect(importMatch).toBeTruthy();
    expect(importMatch[0]).not.toContain('canAccessResource');
    expect(vendorsSrc).not.toMatch(/[^-\w]canAccessResource\s*\(/);
  });

  it('license key reveal client no longer maintains a dead in-memory key cache', () => {
    const jsSrc = read('public/js/app.js');
    expect(jsSrc).not.toContain('_licenseKeys');
  });

  it('dashboard and reports warranty comments no longer claim the queries mirror each other', () => {
    const dashSrc = read('src/routes/dashboard.js');
    const reportsSrc = read('src/routes/reports.js');
    expect(dashSrc).not.toMatch(/Mirrors the\s+\n?\s*reports warrantyExpiring query/);
    expect(reportsSrc).not.toContain("Mirrors the dashboard's defensive LIMIT 20");
    // Both now document the real relationship (different horizons/caps).
    expect(dashSrc).toContain('30-day glance horizon');
    expect(reportsSrc).toContain('90-day report horizon');
  });
});
