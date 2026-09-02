const { describe, it, expect, beforeEach } = require('@jest/globals');
const { lastHandlerFor } = require('./helpers');

// Pass 114 regression suite. Loads the REAL route handlers with heavyweight
// deps mocked (same pattern as partial_update.test.js / hpp.test.js), then
// drives individual handlers with fake req/res objects to pin the fail-closed
// validation and access-policy fixes from this review pass.
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
    req.audit = jest.fn(); next();
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
  const req = { body, params, method: 'PUT', session: { user: sessionUser }, flash: (type, msg) => flashCalls.push([type, msg]), audit: jest.fn() };
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

// ---------------------------------------------------------------------------
// resolveOptionalField — present non-string values must fail closed
// ---------------------------------------------------------------------------
describe('resolveOptionalField — present non-string values return the error sentinel', () => {
  const { resolveOptionalField } = require('../src/utils');

  it('returns { error: true } for a present non-string raw value (JSON number)', () => {
    // Previously a JSON {"email": 123} collapsed to the clear branch and
    // silently wiped the stored value while flashing success.
    expect(resolveOptionalField(123, null, 200, 'stored@x.com')).toEqual({ error: true });
    expect(resolveOptionalField(false, null, 200, 'stored')).toEqual({ error: true });
    expect(resolveOptionalField({ a: 1 }, null, 200, 'stored')).toEqual({ error: true });
  });

  it('still preserves the existing value when the field is absent', () => {
    expect(resolveOptionalField(undefined, null, 200, 'stored')).toBe('stored');
    expect(resolveOptionalField(null, null, 200, 'stored')).toBe('stored');
  });

  it('still clears (null) for an explicit empty-string submission and truncates non-empty strings', () => {
    expect(resolveOptionalField('', null, 200, 'stored')).toBeNull();
    expect(resolveOptionalField('new value', 'new value', 200, 'stored')).toBe('new value');
    expect(resolveOptionalField('x'.repeat(300), 'x'.repeat(300), 200, 'stored').length).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// assets update — present-but-invalid status is rejected (fail-closed)
// ---------------------------------------------------------------------------
describe('assets update — present-but-invalid status is rejected', () => {
  const assetsRouter = require('../src/routes/assets');

  beforeEach(() => {
    const db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    stmt.run.mockClear();
    stmt.get.mockReturnValue({
      id: 1, asset_tag: 'AST-001', name: 'Laptop', category: 'laptop',
      status: 'in_use', condition_rating: 'good', purchase_price: 100,
      purchase_date: '2024-01-01', warranty_expiry: null, assigned_to: null,
      manufacturer: null, model: null, serial_number: null, location: null, notes: null
    });
  });

  it('rejects a typo\'d status instead of silently keeping the stored one', () => {
    const h = lastHandlerFor(assetsRouter, 'put', '/:id');
    const { redirectCalls, flashCalls } = runHandler(h, {
      asset_tag: 'AST-001', name: 'Laptop', category: 'laptop', status: 'in-use'
    }, { id: '1' });
    expect(redirectCalls).toEqual(['/assets/1/edit']);
    expect(errorFlash(flashCalls)).toBe('Invalid status');
    const db = jest.requireMock('../src/models/database');
    expect(db.prepare().run).not.toHaveBeenCalled();
  });

  it('still preserves the stored status when the field is absent/empty (partial submission)', () => {
    const h = lastHandlerFor(assetsRouter, 'put', '/:id');
    const { redirectCalls } = runHandler(h, {
      asset_tag: 'AST-001', name: 'Laptop', category: 'laptop', status: ''
    }, { id: '1' });
    expect(redirectCalls).toEqual(['/assets/1']);
    const calls = jest.requireMock('../src/models/database').prepare().run.mock.calls;
    const params = calls[calls.length - 1];
    expect(params[6]).toBe('in_use'); // status column (index 6) — preserved from stored row
  });
});

// ---------------------------------------------------------------------------
// projects — member add id coercion + quick-status validation
// ---------------------------------------------------------------------------
describe('projects member add — malformed user_id is rejected, not parseInt-coerced', () => {
  const projectsRouter = require('../src/routes/projects');

  beforeEach(() => {
    const db = jest.requireMock('../src/models/database');
    db.prepare().run.mockClear();
  });

  it('rejects user_id "5abc" (previously safeId coerced it to member #5)', () => {
    const h = lastHandlerFor(projectsRouter, 'post', '/:id/members');
    const { redirectCalls, flashCalls } = runHandler(h, {
      user_id: '5abc', role: 'member'
    }, { id: '1' });
    expect(redirectCalls).toEqual(['/projects/1']);
    expect(errorFlash(flashCalls)).toBe('Invalid user');
    expect(jest.requireMock('../src/models/database').prepare().run).not.toHaveBeenCalled();
  });

  it('still rejects a missing user_id', () => {
    const h = lastHandlerFor(projectsRouter, 'post', '/:id/members');
    const { flashCalls } = runHandler(h, { role: 'member' }, { id: '1' });
    expect(errorFlash(flashCalls)).toBe('Invalid user');
  });
});

describe('projects task quick-status — invalid status is rejected, not reported as "unchanged"', () => {
  const projectsRouter = require('../src/routes/projects');

  beforeEach(() => {
    const db = jest.requireMock('../src/models/database');
    db.prepare().run.mockClear();
  });

  it('rejects a bogus quick-status value with an error flash (mirrors tickets.js)', () => {
    const h = lastHandlerFor(projectsRouter, 'put', '/:projectId/tasks/:taskId');
    const { redirectCalls, flashCalls } = runHandler(h, {
      _quick_status: '1', status: 'bogus'
    }, { projectId: '1', taskId: '2' });
    expect(redirectCalls).toEqual(['/projects/1']);
    expect(errorFlash(flashCalls)).toBe('Invalid task status');
    expect(jest.requireMock('../src/models/database').prepare().run).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// changes / vendors — JSON non-string optional fields fail closed
// ---------------------------------------------------------------------------
describe('changes update — JSON non-string description is rejected instead of clearing', () => {
  const changesRouter = require('../src/routes/changes');

  beforeEach(() => {
    const db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    stmt.run.mockClear();
    stmt.get.mockReturnValue({
      id: 1, title: 'Old', description: 'Existing description', change_type: 'maintenance',
      status: 'scheduled', priority: 'medium', scheduled_start: '2026-09-01 02:00',
      scheduled_end: '2026-09-01 04:00', actual_start: null, actual_end: null,
      impact: 'Low', assigned_to: null
    });
  });

  it('rejects {"description": 123} with "Invalid Description" and no UPDATE', () => {
    const h = lastHandlerFor(changesRouter, 'put', '/:id');
    const { redirectCalls, flashCalls } = runHandler(h, {
      title: 'Title', change_type: 'maintenance', status: 'scheduled', description: 123
    }, { id: '1' });
    expect(redirectCalls).toEqual(['/changes/1/edit']);
    expect(errorFlash(flashCalls)).toBe('Invalid Description');
    expect(jest.requireMock('../src/models/database').prepare().run).not.toHaveBeenCalled();
  });

  it('rejects {"impact": {}} with "Invalid Impact" and no UPDATE', () => {
    const h = lastHandlerFor(changesRouter, 'put', '/:id');
    const { flashCalls } = runHandler(h, {
      title: 'Title', change_type: 'maintenance', status: 'scheduled', impact: { a: 1 }
    }, { id: '1' });
    expect(errorFlash(flashCalls)).toBe('Invalid Impact');
    expect(jest.requireMock('../src/models/database').prepare().run).not.toHaveBeenCalled();
  });
});

describe('vendors — JSON non-string optional fields fail closed', () => {
  const vendorsRouter = require('../src/routes/vendors');

  beforeEach(() => {
    const db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    stmt.run.mockClear();
    stmt.get.mockReturnValue({
      id: 1, name: 'Acme', contact_person: 'Bob', email: 'bob@acme.com',
      phone: null, address: null, website: null, category: null,
      contract_start: null, contract_end: null, notes: null, rating: null, is_active: 1
    });
  });

  it('update rejects {"email": 123} instead of silently clearing the stored email', () => {
    const h = lastHandlerFor(vendorsRouter, 'put', '/:id');
    const { redirectCalls, flashCalls } = runHandler(h, { name: 'Acme', email: 123 }, { id: '1' });
    expect(redirectCalls).toEqual(['/vendors/1/edit']);
    expect(errorFlash(flashCalls)).toBe('Invalid Email');
    expect(jest.requireMock('../src/models/database').prepare().run).not.toHaveBeenCalled();
  });

  it('create rejects a falsy non-string contract date (JSON 0) instead of storing NULL', () => {
    // Regression: the create guard previously used truthiness, so 0/false
    // bypassed it while the update route's _resolveClearableDate rejected
    // the same input.
    const h = lastHandlerFor(vendorsRouter, 'post', '/');
    const { redirectCalls, flashCalls } = runHandler(h, { name: 'Acme', contract_start: 0 });
    expect(redirectCalls).toEqual(['/vendors/new']);
    expect(errorFlash(flashCalls)).toBe('Invalid contract start date');
    expect(jest.requireMock('../src/models/database').prepare().run).not.toHaveBeenCalled();
  });

  it('create rejects a non-string optional text field instead of storing NULL', () => {
    const h = lastHandlerFor(vendorsRouter, 'post', '/');
    const { redirectCalls, flashCalls } = runHandler(h, { name: 'Acme', website: 42 });
    expect(redirectCalls).toEqual(['/vendors/new']);
    expect(errorFlash(flashCalls)).toBe('Invalid request parameters');
    expect(jest.requireMock('../src/models/database').prepare().run).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// staff — non-string department rejected; race-path message matches outer check
// ---------------------------------------------------------------------------
describe('staff update — non-string department is rejected instead of clearing', () => {
  const staffRouter = require('../src/routes/staff');

  beforeEach(() => {
    const db = jest.requireMock('../src/models/database');
    db.prepare().run.mockClear();
  });

  it('rejects {"department": 5} with "Invalid Department" and no UPDATE', () => {
    const h = lastHandlerFor(staffRouter, 'put', '/:id');
    const { redirectCalls, flashCalls } = runHandler(h, {
      email: 'a@b.co', first_name: 'A', last_name: 'B', role: 'staff', department: 5
    }, { id: '2' });
    expect(redirectCalls).toEqual(['/staff/2/edit']);
    expect(errorFlash(flashCalls)).toBe('Invalid Department');
    expect(jest.requireMock('../src/models/database').prepare().run).not.toHaveBeenCalled();
  });

  it('create rejects a non-string department too', () => {
    const h = lastHandlerFor(staffRouter, 'post', '/');
    const { flashCalls } = runHandler(h, {
      username: 'newuser1', password: 'ValidPass1!xyz', email: 'a@b.co',
      first_name: 'A', last_name: 'B', role: 'staff', department: 5
    });
    expect(errorFlash(flashCalls)).toBe('Invalid Department');
  });
});

// ---------------------------------------------------------------------------
// licenses list route — access policy pinned (admin/manager only)
// ---------------------------------------------------------------------------
describe('licenses list route access policy', () => {
  const fs = require('fs');
  const path = require('path');

  it('GET /licenses is gated by requireAdminOrManager like the show route', () => {
    // The list renders the same cost/seat data the show route is gated on;
    // leaving it staff-accessible rendered the show gate meaningless.
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'licenses.js'), 'utf8');
    expect(src).toMatch(/router\.get\('\/',\s*requireAdminOrManager,/);
  });

  it('the list SELECT no longer fetches the unrendered notes column', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'licenses.js'), 'utf8');
    const listSql = src.slice(src.indexOf('SELECT l.id, l.software_name, l.vendor, l.license_type'), src.indexOf('ORDER BY l.software_name ASC'));
    expect(listSql).not.toContain('l.notes');
  });
});

// ---------------------------------------------------------------------------
// templates — PII gating on the ticket edit form
// ---------------------------------------------------------------------------
describe('tickets form — requester PII fields gated for non-privileged editors', () => {
  const ejs = require('ejs');
  const fs = require('fs');
  const path = require('path');
  const utils = require('../src/utils');
  const constants = require('../src/constants');

  function renderForm(user, ticket, isEdit) {
    const file = path.join(__dirname, '..', 'views', 'pages', 'tickets', 'form.ejs');
    const locals = {
      user,
      flash: { success: [], error: [], info: [] },
      currentPage: '/x',
      csrfToken: 't',
      title: 'T',
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
      ticket, staff: [], assets: [], isEdit
    };
    return ejs.render(fs.readFileSync(file, 'utf8'), locals, { filename: file });
  }

  const ticket = {
    id: 1, title: 'T', category: 'hardware', priority: 'high', status: 'open',
    requester_name: 'Bob', requester_email: 'bob@x.com', requester_department: 'IT',
    requester_phone: '555-1234'
  };

  it('omits requester email/department/phone inputs for a non-privileged editor', () => {
    const html = renderForm({ id: 9, role: 'staff', first_name: 'S', last_name: 'U' }, ticket, true);
    expect(html).not.toContain('name="requester_email"');
    expect(html).not.toContain('name="requester_department"');
    expect(html).not.toContain('name="requester_phone"');
    // requester_name stays editable for everyone
    expect(html).toContain('name="requester_name"');
  });

  it('renders the PII inputs for a privileged editor and on create', () => {
    const priv = renderForm({ id: 1, role: 'admin', first_name: 'A', last_name: 'D' }, ticket, true);
    expect(priv).toContain('name="requester_email"');
    expect(priv).toContain('name="requester_phone"');
    const create = renderForm({ id: 9, role: 'staff', first_name: 'S', last_name: 'U' }, ticket, false);
    expect(create).toContain('name="requester_email"');
  });
});

// ---------------------------------------------------------------------------
// licenses index — already-expired licenses are highlighted too
// ---------------------------------------------------------------------------
describe('licenses index — expired licenses highlighted like expiring-soon ones', () => {
  const ejs = require('ejs');
  const fs = require('fs');
  const path = require('path');
  const utils = require('../src/utils');
  const constants = require('../src/constants');

  function renderIndex(expiry_date) {
    const file = path.join(__dirname, '..', 'views', 'pages', 'licenses', 'index.ejs');
    const locals = {
      user: { id: 1, role: 'admin', first_name: 'A', last_name: 'D' },
      flash: { success: [], error: [], info: [] },
      currentPage: '/x',
      csrfToken: 't',
      title: 'L',
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
      licenses: [{ id: 1, software_name: 'S', vendor: 'V', license_type: 'subscription', total_seats: 10, used_seats: 1, expiry_date, cost: 1 }],
      filters: {}, page: 1, limit: 25, totalPages: 1, total: 1, baseUrl: '/licenses'
    };
    return ejs.render(fs.readFileSync(file, 'utf8'), locals, { filename: file });
  }

  function daysAgoISO(days) {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d.toISOString().slice(0, 10);
  }

  it('highlights a license that expired last week (danger style)', () => {
    // isExpiringSoon alone ignores negative daysUntil — an expired license
    // previously rendered exactly like a healthy future-dated one.
    expect(renderIndex(daysAgoISO(7))).toContain('color:var(--danger)');
  });

  it('does not highlight a license expiring far in the future', () => {
    const future = new Date();
    future.setFullYear(future.getFullYear() + 1);
    expect(renderIndex(future.toISOString().slice(0, 10))).not.toContain('color:var(--danger)');
  });
});

// ---------------------------------------------------------------------------
// error page — reflects the actual status code
// ---------------------------------------------------------------------------
describe('error page — displays the real status code instead of a hardcoded 500', () => {
  const ejs = require('ejs');
  const fs = require('fs');
  const path = require('path');

  function renderError(locals) {
    const file = path.join(__dirname, '..', 'views', 'pages', 'error.ejs');
    // The header partial requires csrfToken; in the app it is provided by the
    // global res.locals middleware that runs before the error handler.
    return ejs.render(fs.readFileSync(file, 'utf8'), { csrfToken: 't', ...locals }, { filename: file });
  }

  it('shows 413 / Request Error for a 4xx status', () => {
    const html = renderError({ title: 'Error', statusCode: 413, error: { message: 'too large' } });
    expect(html).toContain('>413<');
    expect(html).toContain('Request Error');
  });

  it('defaults to 500 / Server Error when no statusCode is passed', () => {
    const html = renderError({ title: 'Error', error: { message: 'boom' } });
    expect(html).toContain('>500<');
    expect(html).toContain('Server Error');
  });
});

// ---------------------------------------------------------------------------
// changes — INVALID_DATE_FIELDS use title-case matching vendors.js convention
// ---------------------------------------------------------------------------
describe('changes — INVALID_DATE_FIELDS value casing matches title-case convention', () => {
  // The dynamic error path in changes.js reconstructs the flash message as
  // `Invalid ${dateFieldName}` where dateFieldName comes from INVALID_DATE_FIELDS.
  // vendors.js line 626 title-cases every word for the same pattern, producing
  // "Invalid Contact Person" rather than "Invalid contact person". This test
  // pins the casing so a future refactor cannot silently revert to lowercase.
  it('INVALID_DATE_FIELDS values are title-cased', () => {
    // The module does not export INVALID_DATE_FIELDS directly, but we can
    // inspect the error messages produced by the update handler by triggering
    // a bad datetime and verifying the flash message uses title-case field names.
    const db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    stmt.run.mockClear();
    stmt.get.mockReturnValueOnce({
      id: 1, title: 'Change', description: 'Desc', change_type: 'maintenance',
      status: 'scheduled', priority: 'medium',
      scheduled_start: '2026-01-01 10:00', scheduled_end: '2026-01-01 12:00',
      actual_start: null, actual_end: null, impact: null, assigned_to: null
    });
    // Direct unit check on the exported helper is not enough — we need the
    // actual flash message. Use a minimal request to drive the full handler.
    const router = require('../src/routes/changes');
    const h = lastHandlerFor(router, 'put', '/:id');
    const flashCalls = [];
    const req = {
      params: { id: '1' },
      method: 'PUT',
      session: { user: { id: 1, role: 'admin' } },
      flash: (type, msg) => flashCalls.push([type, msg]),
      body: { title: 'Change', change_type: 'maintenance', status: 'scheduled', scheduled_start: 'not-a-datetime' }
    };
    const res = {
      redirect: () => {},
      render: () => {},
      status: () => res,
      json: () => {},
      end: () => {}
    };
    h(req, res, () => {});
    const errFlash = flashCalls.find(([t]) => t === 'error')?.[1];
    expect(errFlash).toBeDefined();
    // The message must use title-case field names to match the convention
    // enforced by the vendors.js dynamic error path (line 626).
    expect(errFlash).toMatch(/^Invalid [A-Z]/);
  });
});
