const { describe, it, expect, beforeEach } = require('@jest/globals');
const { lastHandlerFor } = require('./helpers');

// Load the REAL route handlers with heavyweight deps mocked (same pattern as
// hpp.test.js / projects_update.test.js), then drive individual handlers with
// fake req/res objects to assert fail-closed validation and partial-submission
// field preservation behavior that the HPP suite does not cover.
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

function lastRunParams() {
  const db = jest.requireMock('../src/models/database');
  const calls = db.prepare().run.mock.calls;
  // Statement .run(...) is called with positional (spread) args, so the last
  // call's argument list IS the params array.
  return calls[calls.length - 1];
}

describe('assets update — partial submission preserves stored fields', () => {
  const assetsRouter = require('../src/routes/assets');

  beforeEach(() => {
    const db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    stmt.run.mockClear();
    stmt.get.mockReturnValue({
      id: 1, asset_tag: 'AST-001', name: 'Laptop', category: 'laptop',
      status: 'in_use', condition_rating: 'poor', purchase_price: 100,
      purchase_date: '2024-01-01', warranty_expiry: null, assigned_to: null,
      manufacturer: null, model: null, serial_number: null, location: null, notes: null
    });
  });

  it('preserves the stored condition_rating when the field is absent (regression: reset to "good")', () => {
    const h = lastHandlerFor(assetsRouter, 'put', '/:id');
    const { redirectCalls } = runHandler(h, {
      asset_tag: 'AST-001', name: 'Laptop', category: 'laptop', status: 'in_use'
    }, { id: '1' });
    expect(redirectCalls).toHaveLength(1);
    const params = lastRunParams();
    expect(params[7]).toBe('poor'); // condition_rating column (index 7)
  });

  it('still applies a submitted condition_rating', () => {
    const h = lastHandlerFor(assetsRouter, 'put', '/:id');
    runHandler(h, {
      asset_tag: 'AST-001', name: 'Laptop', category: 'laptop', status: 'in_use', condition_rating: 'fair'
    }, { id: '1' });
    const params = lastRunParams();
    expect(params[7]).toBe('fair');
  });

  it('rejects a partial update that would persist warranty expiry before purchase date', () => {
    // Stored: purchase=2024-01-01, warranty=2026-06-01. The edit moves
    // purchase_date forward to 2027-01-01 and leaves warranty_expiry empty. The
    // submitted-only range check (sWarranty is null) passes, but the RESOLVED
    // warranty is still the stored 2026-06-01 → warranty < purchase must be
    // rejected (mirrors the vendors/changes/projects resolved-value fix).
    const db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    stmt.get.mockReturnValue({
      id: 1, asset_tag: 'AST-001', name: 'Laptop', category: 'laptop',
      status: 'in_use', condition_rating: 'good', purchase_price: 100,
      purchase_date: '2024-01-01', warranty_expiry: '2026-06-01', assigned_to: null,
      manufacturer: null, model: null, serial_number: null, location: null, notes: null
    });
    stmt.run.mockClear();
    const h = lastHandlerFor(assetsRouter, 'put', '/:id');
    const { redirectCalls, flashCalls } = runHandler(h, {
      asset_tag: 'AST-001', name: 'Laptop', category: 'laptop', status: 'in_use',
      purchase_date: '2027-01-01'
    }, { id: '1' });
    expect(redirectCalls).toEqual(['/assets/1/edit']);
    const errorFlash = flashCalls.find(([t]) => t === 'error');
    expect(errorFlash).toBeDefined();
    expect(errorFlash[1]).toBe('Warranty expiry must be on or after purchase date');
    expect(stmt.run).not.toHaveBeenCalled();
  });

  it('clears a stored warranty_expiry when the field is submitted empty (regression: empty preserved the stale date)', () => {
    // Stored warranty_expiry = '2026-06-01'. Submitting warranty_expiry: '' must
    // CLEAR it (null), matching vendors.js / licenses.js / changes.js (absent
    // preserves, empty clears). Previously the empty value was treated as
    // "preserve existing", so a purchase/warranty date could never be unset via
    // the edit form.
    const db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    stmt.get.mockReturnValue({
      id: 1, asset_tag: 'AST-001', name: 'Laptop', category: 'laptop',
      status: 'in_use', condition_rating: 'good', purchase_price: 100,
      purchase_date: '2024-01-01', warranty_expiry: '2026-06-01', assigned_to: null,
      manufacturer: null, model: null, serial_number: null, location: null, notes: null
    });
    stmt.run.mockClear();
    const h = lastHandlerFor(assetsRouter, 'put', '/:id');
    runHandler(h, {
      asset_tag: 'AST-001', name: 'Laptop', category: 'laptop', status: 'in_use',
      warranty_expiry: ''
    }, { id: '1' });
    const params = lastRunParams();
    expect(params[10]).toBeNull(); // warranty_expiry column (index 10)
  });

  it('still preserves a stored warranty_expiry when the field is ABSENT (partial API submission)', () => {
    const db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    stmt.get.mockReturnValue({
      id: 1, asset_tag: 'AST-001', name: 'Laptop', category: 'laptop',
      status: 'in_use', condition_rating: 'good', purchase_price: 100,
      purchase_date: '2024-01-01', warranty_expiry: '2026-06-01', assigned_to: null,
      manufacturer: null, model: null, serial_number: null, location: null, notes: null
    });
    stmt.run.mockClear();
    const h = lastHandlerFor(assetsRouter, 'put', '/:id');
    runHandler(h, {
      asset_tag: 'AST-001', name: 'Laptop', category: 'laptop', status: 'in_use'
    }, { id: '1' });
    const params = lastRunParams();
    expect(params[10]).toBe('2026-06-01'); // preserved — field was absent, not cleared
  });
});

describe('licenses update — partial submission preserves stored optional fields', () => {
  const licensesRouter = require('../src/routes/licenses');

  beforeEach(() => {
    const db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    stmt.run.mockClear();
    stmt.get.mockReturnValue({
      id: 1, software_name: 'Adobe CC', vendor: 'Adobe Inc', license_key: null,
      license_type: 'subscription', total_seats: 25, used_seats: 7,
      purchase_date: '2024-01-01', expiry_date: '2025-01-01', cost: 100, notes: 'keep me'
    });
  });

  it('preserves vendor/license_type/notes/dates/cost when absent (regression: wiped to NULL)', () => {
    const h = lastHandlerFor(licensesRouter, 'put', '/:id');
    const { redirectCalls } = runHandler(h, { software_name: 'Adobe CC' }, { id: '1' });
    expect(redirectCalls).toHaveLength(1);
    // [software_name, vendor, license_key, license_type, seats, used, purchase_date, expiry_date, cost, notes, id]
    const params = lastRunParams();
    expect(params[1]).toBe('Adobe Inc');
    expect(params[3]).toBe('subscription');
    expect(params[6]).toBe('2024-01-01');
    expect(params[7]).toBe('2025-01-01');
    expect(params[8]).toBe(100);
    expect(params[9]).toBe('keep me');
  });
});

describe('tickets update — partial submission preserves stored due_date and requester PII', () => {
  const ticketsRouter = require('../src/routes/tickets');

  beforeEach(() => {
    const db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    stmt.run.mockClear();
    stmt.get.mockReturnValue({
      id: 1, status: 'open', assigned_to: 1, due_date: '2026-06-01',
      requester_name: 'Bob', requester_email: 'bob@x.com',
      requester_department: 'IT', requester_phone: '555-123-4567'
    });
  });

  it('preserves the stored due_date when absent (regression: wiped to NULL)', () => {
    const h = lastHandlerFor(ticketsRouter, 'put', '/:id');
    const { redirectCalls } = runHandler(h, {
      title: 'Broken laptop', category: 'hardware', priority: 'medium', status: 'open',
      requester_name: 'Bob', requester_email: 'bob@x.com'
    }, { id: '1' });
    expect(redirectCalls).toHaveLength(1);
    const params = lastRunParams();
    expect(params[7]).toBe('2026-06-01'); // due_date column (index 7)
  });

  it('preserves requester PII for a non-privileged editor who cannot see it', () => {
    const h = lastHandlerFor(ticketsRouter, 'put', '/:id');
    const { redirectCalls } = runHandler(h, {
      title: 'Broken laptop', category: 'hardware', priority: 'medium', status: 'open',
      requester_name: 'Bob'
    }, { id: '1' }, { id: 2, role: 'staff' });
    expect(redirectCalls).toHaveLength(1);
    const params = lastRunParams();
    // requester_email (10), requester_department (11), requester_phone (12)
    expect(params[10]).toBe('bob@x.com');
    expect(params[11]).toBe('IT');
    expect(params[12]).toBe('555-123-4567');
  });
});

describe('ticket edit form — requester PII redacted for non-privileged users', () => {
  const ticketsRouter = require('../src/routes/tickets');

  beforeEach(() => {
    const db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    stmt.get.mockReturnValue({
      id: 1, status: 'open', assigned_to: 1, due_date: '2026-06-01',
      requester_name: 'Bob', requester_email: 'bob@x.com',
      requester_department: 'IT', requester_phone: '555-123-4567'
    });
  });

  it('redacts requester email/phone/department for staff editors (regression: leaked via edit form)', () => {
    const h = lastHandlerFor(ticketsRouter, 'get', '/:id/edit');
    const { renderArgs } = runHandler(h, {}, { id: '1' }, { id: 2, role: 'staff' });
    expect(renderArgs).not.toBeNull();
    expect(renderArgs.ticket.requester_email).toBeUndefined();
    expect(renderArgs.ticket.requester_phone).toBeUndefined();
    expect(renderArgs.ticket.requester_department).toBeUndefined();
  });

  it('keeps requester PII for privileged editors', () => {
    const h = lastHandlerFor(ticketsRouter, 'get', '/:id/edit');
    const { renderArgs } = runHandler(h, {}, { id: '1' }, { id: 1, role: 'admin' });
    expect(renderArgs).not.toBeNull();
    expect(renderArgs.ticket.requester_email).toBe('bob@x.com');
  });
});

describe('ticket show page — requester PII loaded then redacted for non-privileged viewers', () => {
  const ticketsRouter = require('../src/routes/tickets');

  beforeEach(() => {
    const db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    stmt.get.mockReturnValue({
      id: 1, ticket_number: 'TCK-1', title: 'Broken laptop', status: 'open',
      requester_name: 'Bob', requester_email: 'bob@x.com',
      requester_department: 'IT', requester_phone: '555-123-4567'
    });
  });

  it('keeps requester PII for privileged viewers (regression: dropped from show query)', () => {
    const h = lastHandlerFor(ticketsRouter, 'get', '/:id');
    const { renderArgs } = runHandler(h, {}, { id: '1' }, { id: 1, role: 'admin' });
    expect(renderArgs).not.toBeNull();
    expect(renderArgs.ticket.requester_email).toBe('bob@x.com');
    expect(renderArgs.ticket.requester_department).toBe('IT');
    expect(renderArgs.ticket.requester_phone).toBe('555-123-4567');
  });

  it('redacts requester email/phone/department for staff viewers', () => {
    const h = lastHandlerFor(ticketsRouter, 'get', '/:id');
    const { renderArgs } = runHandler(h, {}, { id: '1' }, { id: 2, role: 'staff' });
    expect(renderArgs).not.toBeNull();
    expect(renderArgs.ticket.requester_email).toBeUndefined();
    expect(renderArgs.ticket.requester_phone).toBeUndefined();
    expect(renderArgs.ticket.requester_department).toBeUndefined();
  });
});

describe('phone fail-closed — a present-but-malformed value must be rejected, not stored as NULL', () => {
  it('tickets create rejects a garbage phone', () => {
    const ticketsRouter = require('../src/routes/tickets');
    const h = lastHandlerFor(ticketsRouter, 'post', '/');
    const { redirectCalls, flashCalls } = runHandler(h, {
      title: 'Broken laptop', category: 'hardware', priority: 'medium',
      requester_name: 'Test', requester_email: 't@x.com', requester_phone: 'abc'
    });
    expect(redirectCalls[0]).toBe('/tickets/new');
    expect(flashCalls.some(([t]) => t === 'error')).toBe(true);
  });

  it('tickets update rejects a garbage phone', () => {
    const ticketsRouter = require('../src/routes/tickets');
    const h = lastHandlerFor(ticketsRouter, 'put', '/:id');
    const { redirectCalls } = runHandler(h, {
      title: 'Broken laptop', category: 'hardware', priority: 'medium', status: 'open',
      requester_name: 'Test', requester_email: 't@x.com', requester_phone: 'abc'
    }, { id: '1' });
    expect(redirectCalls[0]).toBe('/tickets/1/edit');
  });

  it('staff create rejects a garbage phone', () => {
    const staffRouter = require('../src/routes/staff');
    const h = lastHandlerFor(staffRouter, 'post', '/');
    const { redirectCalls } = runHandler(h, {
      username: 'jdoe', password: 'Str0ngPass!', email: 'j@x.com',
      first_name: 'Jane', last_name: 'Doe', phone: 'abc'
    });
    expect(redirectCalls[0]).toBe('/staff/new');
  });

  it('staff update rejects a non-string (JSON number) phone', () => {
    const staffRouter = require('../src/routes/staff');
    const h = lastHandlerFor(staffRouter, 'put', '/:id');
    const { redirectCalls } = runHandler(h, {
      email: 'j@x.com', first_name: 'Jane', last_name: 'Doe', phone: 5551234567
    }, { id: '1' });
    expect(redirectCalls[0]).toBe('/staff/1/edit');
  });

  it('auth profile rejects a garbage phone', () => {
    const authRouter = require('../src/routes/auth');
    const h = lastHandlerFor(authRouter, 'put', '/profile');
    const { redirectCalls } = runHandler(h, {
      first_name: 'Jane', last_name: 'Doe', email: 'j@x.com', phone: 'abc'
    });
    expect(redirectCalls[0]).toBe('/profile');
  });

  it('vendors create rejects a garbage phone', () => {
    const vendorsRouter = require('../src/routes/vendors');
    const h = lastHandlerFor(vendorsRouter, 'post', '/');
    const { redirectCalls } = runHandler(h, { name: 'Acme', phone: 'abc' });
    expect(redirectCalls[0]).toBe('/vendors/new');
  });

  it('vendors update rejects a garbage phone', () => {
    const vendorsRouter = require('../src/routes/vendors');
    const h = lastHandlerFor(vendorsRouter, 'put', '/:id');
    const { redirectCalls } = runHandler(h, { name: 'Acme', phone: 'abc' }, { id: '1' });
    expect(redirectCalls[0]).toBe('/vendors/1/edit');
  });
});

describe('assignee/owner id fail-closed — a present-but-malformed id must be rejected, not coerced to unassigned', () => {
  it('assets create rejects a garbage assignee', () => {
    const assetsRouter = require('../src/routes/assets');
    const h = lastHandlerFor(assetsRouter, 'post', '/');
    const { redirectCalls, flashCalls } = runHandler(h, {
      name: 'Laptop', category: 'laptop', assigned_to: 'abc'
    });
    expect(redirectCalls[0]).toBe('/assets/new');
    expect(flashCalls.some(([t]) => t === 'error')).toBe(true);
  });

  it('assets update rejects a garbage assignee', () => {
    const assetsRouter = require('../src/routes/assets');
    const h = lastHandlerFor(assetsRouter, 'put', '/:id');
    const { redirectCalls } = runHandler(h, {
      asset_tag: 'AST-001', name: 'Laptop', category: 'laptop', assigned_to: '3.5'
    }, { id: '1' });
    expect(redirectCalls[0]).toBe('/assets/1/edit');
  });

  it('projects update rejects a garbage owner id', () => {
    const projectsRouter = require('../src/routes/projects');
    const h = lastHandlerFor(projectsRouter, 'put', '/:id');
    const { redirectCalls } = runHandler(h, { name: 'Test project', owner_id: 'abc' }, { id: '1' });
    expect(redirectCalls[0]).toBe('/projects/1/edit');
  });

  it('changes create rejects a garbage assignee', () => {
    const changesRouter = require('../src/routes/changes');
    const h = lastHandlerFor(changesRouter, 'post', '/');
    const { redirectCalls } = runHandler(h, {
      title: 'Server upgrade', change_type: 'planned', status: 'open', assigned_to: 'abc'
    });
    expect(redirectCalls[0]).toBe('/changes/new');
  });

  it('tickets create rejects a garbage assignee and asset', () => {
    const ticketsRouter = require('../src/routes/tickets');
    const h = lastHandlerFor(ticketsRouter, 'post', '/');
    const { redirectCalls } = runHandler(h, {
      title: 'Broken laptop', category: 'hardware', priority: 'medium',
      requester_name: 'Test', requester_email: 't@x.com', assigned_to: 'abc'
    });
    expect(redirectCalls[0]).toBe('/tickets/new');
  });

  it('tickets update rejects a garbage asset id', () => {
    const ticketsRouter = require('../src/routes/tickets');
    const h = lastHandlerFor(ticketsRouter, 'put', '/:id');
    const { redirectCalls } = runHandler(h, {
      title: 'Broken laptop', category: 'hardware', priority: 'medium', status: 'open',
      requester_name: 'Test', requester_email: 't@x.com', asset_id: '0x10'
    }, { id: '1' });
    expect(redirectCalls[0]).toBe('/tickets/1/edit');
  });
});

describe('ensureAssigneeInList (dropdown helper)', () => {
  it('prepends a deactivated current assignee to the active staff list', () => {
    const utils = require('../src/utils');
    const db = jest.requireMock('../src/models/database');
    db.prepare().get.mockReturnValue({ id: 5, first_name: 'Zed', last_name: 'T' });
    const result = utils.ensureAssigneeInList([{ id: 1, first_name: 'A', last_name: 'B' }], 5, db);
    expect(result.map(r => r.id)).toEqual([5, 1]);
  });

  it('returns the list unchanged when the assignee is already present (no dupes)', () => {
    const utils = require('../src/utils');
    const db = jest.requireMock('../src/models/database');
    const staff = [{ id: 5, first_name: 'Zed', last_name: 'T' }];
    expect(utils.ensureAssigneeInList(staff, 5, db)).toBe(staff);
  });

  it('returns the list unchanged for a null or unknown assignee id', () => {
    const utils = require('../src/utils');
    const db = jest.requireMock('../src/models/database');
    db.prepare().get.mockReturnValue(null);
    const staff = [{ id: 1, first_name: 'A', last_name: 'B' }];
    expect(utils.ensureAssigneeInList(staff, null, db)).toBe(staff);
    expect(utils.ensureAssigneeInList(staff, 999, db)).toBe(staff);
  });
});

describe('inactive assignee preservation on update (regression: wiped to unassigned on edit)', () => {
  it('tickets update preserves the current (inactive) assignee when unchanged', () => {
    const db = jest.requireMock('../src/models/database');
    db.prepare().run.mockClear();
    db.prepare().get.mockReset();
    db.prepare().get
      .mockReturnValueOnce({ id: 1, status: 'open', assigned_to: 5, due_date: null, requester_name: 'Bob', requester_email: 'bob@x.com', requester_department: null, requester_phone: null })
      .mockReturnValueOnce(null) // isActiveUser(5) -> deactivated
      .mockReturnValue({ id: 1 });
    const ticketsRouter = require('../src/routes/tickets');
    const h = lastHandlerFor(ticketsRouter, 'put', '/:id');
    const { redirectCalls, flashCalls } = runHandler(h, {
      title: 'Broken laptop', category: 'hardware', priority: 'medium', status: 'open',
      requester_name: 'Bob', requester_email: 'bob@x.com', assigned_to: '5'
    }, { id: '1' });
    expect(redirectCalls[0]).toBe('/tickets/1');
    expect(flashCalls.some(([t]) => t === 'error')).toBe(false);
    const params = lastRunParams();
    expect(params[5]).toBe(5); // assigned_to column
  });

  it('tickets update still rejects switching to a DIFFERENT inactive assignee', () => {
    const db = jest.requireMock('../src/models/database');
    db.prepare().get.mockReset();
    db.prepare().get
      .mockReturnValueOnce({ id: 1, status: 'open', assigned_to: 5, due_date: null, requester_name: 'Bob', requester_email: 'bob@x.com', requester_department: null, requester_phone: null })
      .mockReturnValueOnce(null) // isActiveUser(6) -> deactivated
      .mockReturnValue({ id: 1 });
    const ticketsRouter = require('../src/routes/tickets');
    const h = lastHandlerFor(ticketsRouter, 'put', '/:id');
    const { redirectCalls, flashCalls } = runHandler(h, {
      title: 'Broken laptop', category: 'hardware', priority: 'medium', status: 'open',
      requester_name: 'Bob', requester_email: 'bob@x.com', assigned_to: '6'
    }, { id: '1' });
    expect(redirectCalls[0]).toBe('/tickets/1/edit');
    expect(flashCalls.some(([t]) => t === 'error')).toBe(true);
  });

  it('assets update preserves the current (inactive) assignee when unchanged', () => {
    const db = jest.requireMock('../src/models/database');
    db.prepare().run.mockClear();
    db.prepare().get.mockReset();
    const asset = { id: 1, asset_tag: 'AST-001', name: 'Laptop', category: 'laptop', status: 'in_use', condition_rating: 'good', purchase_price: 100, purchase_date: '2024-01-01', warranty_expiry: null, assigned_to: 5, manufacturer: null, model: null, serial_number: null, location: null, notes: null };
    db.prepare().get
      .mockReturnValueOnce(asset)  // outer existingAsset fetch
      .mockReturnValueOnce(asset)  // transaction-consistent re-fetch
      .mockReturnValueOnce(null)   // isActiveUser(5) -> deactivated
      .mockReturnValue({ id: 1 });
    const assetsRouter = require('../src/routes/assets');
    const h = lastHandlerFor(assetsRouter, 'put', '/:id');
    const { redirectCalls } = runHandler(h, {
      asset_tag: 'AST-001', name: 'Laptop', category: 'laptop', status: 'in_use', assigned_to: '5'
    }, { id: '1' });
    expect(redirectCalls[0]).toBe('/assets/1');
    const params = lastRunParams();
    expect(params[11]).toBe(5); // assigned_to column
  });

  it('assets update still rejects switching to a DIFFERENT inactive assignee', () => {
    const db = jest.requireMock('../src/models/database');
    db.prepare().get.mockReset();
    const asset = { id: 1, asset_tag: 'AST-001', name: 'Laptop', category: 'laptop', status: 'in_use', condition_rating: 'good', purchase_price: 100, purchase_date: '2024-01-01', warranty_expiry: null, assigned_to: 5, manufacturer: null, model: null, serial_number: null, location: null, notes: null };
    db.prepare().get
      .mockReturnValueOnce(asset)   // transaction-consistent re-fetch
      .mockReturnValueOnce(null)    // isActiveUser(6) -> deactivated
      .mockReturnValue({ id: 1 });
    const assetsRouter = require('../src/routes/assets');
    const h = lastHandlerFor(assetsRouter, 'put', '/:id');
    const { redirectCalls } = runHandler(h, {
      asset_tag: 'AST-001', name: 'Laptop', category: 'laptop', status: 'in_use', assigned_to: '6'
    }, { id: '1' });
    expect(redirectCalls[0]).toBe('/assets/1/edit');
  });

  it('changes update preserves the current (inactive) assignee when unchanged', () => {
    const db = jest.requireMock('../src/models/database');
    db.prepare().run.mockClear();
    db.prepare().get.mockReset();
    db.prepare().get
      .mockReturnValueOnce({ id: 1, title: 'Server upgrade', description: null, change_type: 'maintenance', status: 'scheduled', priority: 'medium', scheduled_start: null, scheduled_end: null, actual_start: null, actual_end: null, impact: null, assigned_to: 5 })
      .mockReturnValueOnce(null) // isActiveUser(5) -> deactivated
      .mockReturnValue({ id: 1 });
    const changesRouter = require('../src/routes/changes');
    const h = lastHandlerFor(changesRouter, 'put', '/:id');
    const { redirectCalls } = runHandler(h, {
      title: 'Server upgrade', change_type: 'maintenance', status: 'scheduled', assigned_to: '5'
    }, { id: '1' });
    expect(redirectCalls[0]).toBe('/changes/1');
    const params = lastRunParams();
    expect(params[10]).toBe(5); // assigned_to column
  });

  it('changes update still rejects switching to a DIFFERENT inactive assignee', () => {
    const db = jest.requireMock('../src/models/database');
    db.prepare().get.mockReset();
    db.prepare().get
      .mockReturnValueOnce({ id: 1, title: 'Server upgrade', description: null, change_type: 'maintenance', status: 'scheduled', priority: 'medium', scheduled_start: null, scheduled_end: null, actual_start: null, actual_end: null, impact: null, assigned_to: 5 })
      .mockReturnValueOnce(null) // isActiveUser(6) -> deactivated
      .mockReturnValue({ id: 1 });
    const changesRouter = require('../src/routes/changes');
    const h = lastHandlerFor(changesRouter, 'put', '/:id');
    const { redirectCalls } = runHandler(h, {
      title: 'Server upgrade', change_type: 'maintenance', status: 'scheduled', assigned_to: '6'
    }, { id: '1' });
    expect(redirectCalls[0]).toBe('/changes/1/edit');
  });

  it('projects update preserves the current (inactive) owner when unchanged', () => {
    const db = jest.requireMock('../src/models/database');
    db.prepare().run.mockClear();
    db.prepare().get.mockReset();
    db.prepare().get
      .mockReturnValueOnce({ budget: null, spent: null, status: 'in_progress', priority: 'medium', start_date: null, end_date: null, owner_id: 5 })
      .mockReturnValueOnce(null) // isActiveUser(5) -> deactivated
      .mockReturnValue({ total: 0, done: 0 }); // recalcProjectProgress progress query
    const projectsRouter = require('../src/routes/projects');
    const h = lastHandlerFor(projectsRouter, 'put', '/:id');
    const { redirectCalls } = runHandler(h, {
      name: 'Net migration', status: 'in_progress', owner_id: '5'
    }, { id: '1' });
    expect(redirectCalls[0]).toBe('/projects/1');
    // The project UPDATE run has 10 args; the recalc progress run has 2 — find
    // the project update to read its owner_id (index 8).
    const projectUpdate = db.prepare().run.mock.calls.find(c => c.length === 10);
    expect(projectUpdate[8]).toBe(5);
  });

  it('projects update still rejects switching to a DIFFERENT inactive owner', () => {
    const db = jest.requireMock('../src/models/database');
    db.prepare().get.mockReset();
    db.prepare().get
      .mockReturnValueOnce({ budget: null, spent: null, status: 'in_progress', priority: 'medium', start_date: null, end_date: null, owner_id: 5 })
      .mockReturnValueOnce(null) // isActiveUser(6) -> deactivated
      .mockReturnValue({ total: 0, done: 0 });
    const projectsRouter = require('../src/routes/projects');
    const h = lastHandlerFor(projectsRouter, 'put', '/:id');
    const { redirectCalls } = runHandler(h, {
      name: 'Net migration', status: 'in_progress', owner_id: '6'
    }, { id: '1' });
    expect(redirectCalls[0]).toBe('/projects/1/edit');
  });
});

describe('edit forms include a deactivated current assignee/owner in the dropdown', () => {
  it('ticket edit form renders the inactive assignee in the staff dropdown', () => {
    const db = jest.requireMock('../src/models/database');
    db.prepare().get.mockReset();
    db.prepare().get
      .mockReturnValueOnce({ id: 1, status: 'open', assigned_to: 5, due_date: null, requester_name: 'Bob', requester_email: 'bob@x.com', requester_department: 'IT', requester_phone: null })
      .mockReturnValue({ id: 5, first_name: 'Zed', last_name: 'T' });
    const ticketsRouter = require('../src/routes/tickets');
    const h = lastHandlerFor(ticketsRouter, 'get', '/:id/edit');
    const { renderArgs } = runHandler(h, {}, { id: '1' }, { id: 1, role: 'admin' });
    expect(renderArgs).not.toBeNull();
    expect(renderArgs.staff.map(s => Number(s.id))).toContain(5);
  });
});

describe('vendors update — partial submission cannot persist contract_end < contract_start', () => {
  it('rejects a partial update that moves contract_start past the stored contract_end', () => {
    const db = jest.requireMock('../src/models/database');
    db.prepare().get.mockReset();
    db.prepare().get.mockReturnValue({
      id: 1, name: 'Acme', contact_person: null, email: null, phone: null,
      address: null, website: null, category: null, notes: null, rating: 4,
      contract_start: '2024-01-01', contract_end: '2024-01-01', is_active: 1
    });
    const vendorsRouter = require('../src/routes/vendors');
    const h = lastHandlerFor(vendorsRouter, 'put', '/:id');
    // Only contract_start submitted: without resolved-value checking, the
    // stored contract_end (2024-01-01) would be preserved and the range check
    // skipped, persisting an invalid end < start pair.
    const { redirectCalls, flashCalls } = runHandler(h, {
      name: 'Acme', contract_start: '2025-01-01'
    }, { id: '1' });
    expect(redirectCalls[0]).toBe('/vendors/1/edit');
    expect(flashCalls.some(([t, m]) => t === 'error' && m === 'Contract end must be on or after contract start')).toBe(true);
  });

  it('still accepts a partial update that keeps the dates in range', () => {
    const db = jest.requireMock('../src/models/database');
    db.prepare().run.mockClear();
    db.prepare().get.mockReset();
    db.prepare().get.mockReturnValue({
      id: 1, name: 'Acme', contact_person: null, email: null, phone: null,
      address: null, website: null, category: null, notes: null, rating: 4,
      contract_start: '2024-01-01', contract_end: '2025-01-01', is_active: 1
    });
    const vendorsRouter = require('../src/routes/vendors');
    const h = lastHandlerFor(vendorsRouter, 'put', '/:id');
    const { redirectCalls } = runHandler(h, {
      name: 'Acme', contract_start: '2024-06-01'
    }, { id: '1' });
    expect(redirectCalls[0]).toBe('/vendors/1');
  });
});

describe('relational FK fields on update — ABSENT preserves, EMPTY clears (regression)', () => {
  // Every other optional field (dates, money, condition_rating) follows the
  // absent-vs-empty convention: an ABSENT field on a partial submission
  // preserves the stored value while an explicit empty string clears it. The
  // relational FK fields (assigned_to / owner_id / asset_id) used
  // `x ? safeId(x) : null`, so an ABSENT field silently wiped the stored
  // assignment/link to NULL — a partial PUT could drop an assignment by
  // omission. These tests pin the now-consistent behavior.

  it('assets update preserves the stored assignee when assigned_to is ABSENT', () => {
    const db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    stmt.run.mockClear();
    stmt.get.mockReturnValue({
      id: 1, asset_tag: 'AST-001', name: 'Laptop', category: 'laptop',
      status: 'in_use', condition_rating: 'good', purchase_price: 100,
      purchase_date: '2024-01-01', warranty_expiry: null, assigned_to: 5,
      manufacturer: null, model: null, serial_number: null, location: null, notes: null
    });
    const assetsRouter = require('../src/routes/assets');
    const h = lastHandlerFor(assetsRouter, 'put', '/:id');
    const { redirectCalls } = runHandler(h, {
      asset_tag: 'AST-001', name: 'Laptop', category: 'laptop', status: 'in_use'
    }, { id: '1' });
    expect(redirectCalls).toHaveLength(1);
    const params = lastRunParams();
    expect(params[11]).toBe(5); // assigned_to column preserved
  });

  it('assets update clears the stored assignee when assigned_to is submitted EMPTY', () => {
    const db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    stmt.run.mockClear();
    stmt.get.mockReturnValue({
      id: 1, asset_tag: 'AST-001', name: 'Laptop', category: 'laptop',
      status: 'in_use', condition_rating: 'good', purchase_price: 100,
      purchase_date: '2024-01-01', warranty_expiry: null, assigned_to: 5,
      manufacturer: null, model: null, serial_number: null, location: null, notes: null
    });
    const assetsRouter = require('../src/routes/assets');
    const h = lastHandlerFor(assetsRouter, 'put', '/:id');
    runHandler(h, {
      asset_tag: 'AST-001', name: 'Laptop', category: 'laptop', status: 'in_use', assigned_to: ''
    }, { id: '1' });
    const params = lastRunParams();
    expect(params[11]).toBeNull(); // "Unassigned" in the form clears the assignment
  });

  it('tickets update preserves the stored assignee and asset when ABSENT', () => {
    const db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    stmt.run.mockClear();
    stmt.get.mockReturnValue({
      id: 1, status: 'open', assigned_to: 5, asset_id: 9, due_date: '2026-06-01',
      requester_name: 'Bob', requester_email: 'bob@x.com',
      requester_department: 'IT', requester_phone: '555-123-4567'
    });
    const ticketsRouter = require('../src/routes/tickets');
    const h = lastHandlerFor(ticketsRouter, 'put', '/:id');
    const { redirectCalls } = runHandler(h, {
      title: 'Broken laptop', category: 'hardware', priority: 'medium', status: 'open',
      requester_name: 'Bob', requester_email: 'bob@x.com'
    }, { id: '1' });
    expect(redirectCalls).toHaveLength(1);
    const params = lastRunParams();
    expect(params[5]).toBe(5); // assigned_to column preserved
    expect(params[6]).toBe(9); // asset_id column preserved
  });

  it('tickets update clears the stored assignee and asset when submitted EMPTY', () => {
    const db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    stmt.run.mockClear();
    stmt.get.mockReturnValue({
      id: 1, status: 'open', assigned_to: 5, asset_id: 9, due_date: '2026-06-01',
      requester_name: 'Bob', requester_email: 'bob@x.com',
      requester_department: 'IT', requester_phone: '555-123-4567'
    });
    const ticketsRouter = require('../src/routes/tickets');
    const h = lastHandlerFor(ticketsRouter, 'put', '/:id');
    runHandler(h, {
      title: 'Broken laptop', category: 'hardware', priority: 'medium', status: 'open',
      requester_name: 'Bob', requester_email: 'bob@x.com', assigned_to: '', asset_id: ''
    }, { id: '1' });
    const params = lastRunParams();
    expect(params[5]).toBeNull();
    expect(params[6]).toBeNull();
  });

  it('changes update preserves the stored assignee when assigned_to is ABSENT', () => {
    const db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    stmt.run.mockClear();
    stmt.get.mockReturnValue({
      id: 1, title: 'Server upgrade', description: null, change_type: 'maintenance',
      status: 'scheduled', priority: 'medium', scheduled_start: null, scheduled_end: null,
      actual_start: null, actual_end: null, impact: null, assigned_to: 5
    });
    const changesRouter = require('../src/routes/changes');
    const h = lastHandlerFor(changesRouter, 'put', '/:id');
    const { redirectCalls } = runHandler(h, {
      title: 'Server upgrade', change_type: 'maintenance', status: 'scheduled', priority: 'medium'
    }, { id: '1' });
    expect(redirectCalls).toHaveLength(1);
    const params = lastRunParams();
    expect(params[10]).toBe(5); // assigned_to column preserved
  });

  it('changes update clears the stored assignee when assigned_to is submitted EMPTY', () => {
    const db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    stmt.run.mockClear();
    stmt.get.mockReturnValue({
      id: 1, title: 'Server upgrade', description: null, change_type: 'maintenance',
      status: 'scheduled', priority: 'medium', scheduled_start: null, scheduled_end: null,
      actual_start: null, actual_end: null, impact: null, assigned_to: 5
    });
    const changesRouter = require('../src/routes/changes');
    const h = lastHandlerFor(changesRouter, 'put', '/:id');
    runHandler(h, {
      title: 'Server upgrade', change_type: 'maintenance', status: 'scheduled', priority: 'medium', assigned_to: ''
    }, { id: '1' });
    const params = lastRunParams();
    expect(params[10]).toBeNull(); // "Unassigned" in the form clears the assignment
  });

  it('projects update preserves the stored owner when owner_id is ABSENT', () => {
    const db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    stmt.run.mockClear();
    stmt.get.mockReturnValue({
      budget: null, spent: null, status: 'in_progress', priority: 'medium',
      start_date: null, end_date: null, owner_id: 5
    });
    const projectsRouter = require('../src/routes/projects');
    const h = lastHandlerFor(projectsRouter, 'put', '/:id');
    const { redirectCalls } = runHandler(h, {
      name: 'Net migration', status: 'in_progress', priority: 'medium'
    }, { id: '1' });
    expect(redirectCalls).toHaveLength(1);
    // The project UPDATE run has 10 args; the recalc progress run has 2.
    const projectUpdate = stmt.run.mock.calls.find(c => c.length === 10);
    expect(projectUpdate[8]).toBe(5); // owner_id column preserved
  });

  it('projects update clears the stored owner when owner_id is submitted EMPTY', () => {
    const db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    stmt.run.mockClear();
    stmt.get.mockReturnValue({
      budget: null, spent: null, status: 'in_progress', priority: 'medium',
      start_date: null, end_date: null, owner_id: 5
    });
    const projectsRouter = require('../src/routes/projects');
    const h = lastHandlerFor(projectsRouter, 'put', '/:id');
    runHandler(h, {
      name: 'Net migration', status: 'in_progress', priority: 'medium', owner_id: ''
    }, { id: '1' });
    const projectUpdate = stmt.run.mock.calls.find(c => c.length === 10);
    expect(projectUpdate[8]).toBeNull(); // "No owner" in the form clears the owner
  });

  it('projects task full-update preserves the stored assignee when assigned_to is ABSENT', () => {
    const db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    stmt.run.mockClear();
    stmt.get.mockReturnValue({
      id: 2, project_id: 1, title: 'Old title', description: null,
      status: 'todo', priority: 'high', assigned_to: 5,
      due_date: '2026-05-05', completed_at: null, created_at: null, updated_at: null
    });
    const projectsRouter = require('../src/routes/projects');
    const h = lastHandlerFor(projectsRouter, 'put', '/:projectId/tasks/:taskId');
    const { redirectCalls } = runHandler(h, {
      title: 'Renamed', status: 'in_progress', priority: 'medium'
    }, { projectId: '1', taskId: '2' });
    expect(redirectCalls).toEqual(['/projects/1']);
    // The task full-update run has 9 args; the recalc progress run has 2.
    const taskUpdate = stmt.run.mock.calls.find(c => c.length === 9);
    expect(taskUpdate[4]).toBe(5); // assigned_to column preserved
  });

  it('projects task full-update clears the stored assignee when assigned_to is submitted EMPTY', () => {
    const db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    stmt.run.mockClear();
    stmt.get.mockReturnValue({
      id: 2, project_id: 1, title: 'Old title', description: null,
      status: 'todo', priority: 'high', assigned_to: 5,
      due_date: '2026-05-05', completed_at: null, created_at: null, updated_at: null
    });
    const projectsRouter = require('../src/routes/projects');
    const h = lastHandlerFor(projectsRouter, 'put', '/:projectId/tasks/:taskId');
    runHandler(h, {
      title: 'Renamed', status: 'in_progress', priority: 'medium', assigned_to: ''
    }, { projectId: '1', taskId: '2' });
    const taskUpdate = stmt.run.mock.calls.find(c => c.length === 9);
    expect(taskUpdate[4]).toBeNull(); // "Unassigned" in the form clears the assignee
  });
});

describe('PII redaction must not mutate the DB query result object in-place', () => {
  // Regression: the tickets edit route and assets show route previously deleted
  // properties directly from the better-sqlite3 result row. If the driver ever
  // returns cached/memoized objects, this would leak PII across requests. Both
  // routes now shallow-copy before redacting so the original row stays pristine.

  it('ticket edit route shallow-copies before redacting requester PII (does not mutate the row)', () => {
    const ticketsRouter = require('../src/routes/tickets');
    const db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    const originalRow = {
      id: 1, status: 'open', assigned_to: 1, due_date: '2026-06-01',
      requester_name: 'Bob', requester_email: 'bob@x.com',
      requester_department: 'IT', requester_phone: '555-123-4567'
    };
    stmt.get.mockReturnValue(originalRow);
    const h = lastHandlerFor(ticketsRouter, 'get', '/:id/edit');
    runHandler(h, {}, { id: '1' }, { id: 2, role: 'staff' });
    // The original row must remain unmutated — PII fields still present.
    expect(originalRow.requester_email).toBe('bob@x.com');
    expect(originalRow.requester_phone).toBe('555-123-4567');
    expect(originalRow.requester_department).toBe('IT');
  });

  it('asset show route shallow-copies before redacting assigned_email (does not mutate the row)', () => {
    const assetsRouter = require('../src/routes/assets');
    const db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    const originalRow = {
      id: 1, asset_tag: 'AST-001', name: 'Laptop', category: 'laptop',
      manufacturer: 'Apple', model: 'M3', serial_number: 'SN-001',
      status: 'in_use', condition_rating: 'good', purchase_date: '2024-01-01',
      purchase_price: 999, warranty_expiry: '2027-01-01', assigned_to: 1,
      location: 'HQ', notes: null, created_at: null, updated_at: null,
      assigned_name: 'Ada', assigned_email: 'ada@company.com'
    };
    stmt.get.mockReturnValue(originalRow);
    stmt.all.mockReturnValue([]);
    const h = lastHandlerFor(assetsRouter, 'get', '/:id');
    runHandler(h, {}, { id: '1' }, { id: 2, role: 'staff' });
    // The original row must remain unmutated — assigned_email still present.
    expect(originalRow.assigned_email).toBe('ada@company.com');
  });
});

describe('licenses show route — no dead isPrivileged guard needed (requireAdminOrManager covers it)', () => {
  it('renders the license key for admin viewers without an extra dead-code branch', () => {
    const licensesRouter = require('../src/routes/licenses');
    const db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    stmt.get.mockReturnValue({
      id: 1, software_name: 'MS365', vendor: 'MS', license_key: 'SECRET-KEY',
      license_type: 'subscription', total_seats: 10, used_seats: 5,
      purchase_date: '2024-01-01', expiry_date: '2099-01-01', cost: 1000, notes: null
    });
    const h = lastHandlerFor(licensesRouter, 'get', '/:id');
    const { renderArgs } = runHandler(h, {}, { id: '1' }, { id: 1, role: 'admin' });
    expect(renderArgs).not.toBeNull();
    expect(renderArgs.license.license_key).toBe('SECRET-KEY');
  });
});
