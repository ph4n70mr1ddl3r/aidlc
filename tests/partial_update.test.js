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
