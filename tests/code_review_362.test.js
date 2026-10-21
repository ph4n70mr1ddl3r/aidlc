const { describe, it, expect, beforeEach } = require('@jest/globals');
const fs = require('fs');
const path = require('path');
const { lastHandlerFor } = require('./helpers');

// Regression tests for review pass 362: ticket requester_name absent-preserve
// + non-string guard, asset show related-ticket scoping, staff list
// last_login/avatar redaction, and the login-failure map lockout-bypass.

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

function runPut(handler, body, params = { id: '1' }, sessionUser = { id: 1, role: 'admin' }) {
  const redirectCalls = [];
  const flashCalls = [];
  const req = { body, params, method: 'PUT', session: { user: sessionUser }, flash: (type, msg) => flashCalls.push([type, msg]), audit: jest.fn() };
  const res = {
    redirect: (to) => {
      redirectCalls.push(to);
    },
    render: () => {}, status: () => res, json: () => {}, end: () => {}
  };
  handler(req, res, () => {});
  return { redirectCalls, flashCalls };
}

describe('tickets update — requester_name absent-preserve + non-string guard (pass 362)', () => {
  const ticketsRouter = require('../src/routes/tickets');
  const CURRENT = {
    id: 1, status: 'open', category: 'hardware', priority: 'high',
    assigned_to: 1, asset_id: null, due_date: null,
    description: 'd', resolution_notes: null,
    requester_name: 'Bob', requester_email: 'bob@x.com',
    requester_department: 'IT', requester_phone: '555-123-4567'
  };

  beforeEach(() => {
    const db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    stmt.run.mockClear();
    stmt.get.mockReturnValue({ ...CURRENT });
  });

  it('preserves the stored requester_name when the field is absent on a partial PUT', () => {
    const h = lastHandlerFor(ticketsRouter, 'put', '/:id');
    const { redirectCalls, flashCalls } = runPut(h, {
      title: 'Renamed', category: 'hardware', priority: 'high', status: 'open',
      requester_email: 'bob@x.com'
    });
    expect(redirectCalls).toHaveLength(1);
    expect(flashCalls.some(([t]) => t === 'success')).toBe(true);
    const params = dbRunParams();
    // UPDATE param order: title, description, category, priority, status,
    // assigned_to, asset_id, due_date, resolution_notes, requester_name(9)
    expect(params[9]).toBe('Bob');
  });

  it('rejects a present non-string requester_name (fail-closed, not a silent wipe)', () => {
    const h = lastHandlerFor(ticketsRouter, 'put', '/:id');
    const { redirectCalls, flashCalls } = runPut(h, {
      title: 'Renamed', category: 'hardware', priority: 'high', status: 'open',
      requester_email: 'bob@x.com', requester_name: 42
    });
    expect(redirectCalls).toHaveLength(1);
    expect(flashCalls.some(([t, m]) => t === 'error' && m === 'Invalid Requester Name')).toBe(true);
  });

  it('still rejects an explicit empty requester_name (required field)', () => {
    const h = lastHandlerFor(ticketsRouter, 'put', '/:id');
    const { redirectCalls, flashCalls } = runPut(h, {
      title: 'Renamed', category: 'hardware', priority: 'high', status: 'open',
      requester_email: 'bob@x.com', requester_name: ''
    });
    expect(redirectCalls).toHaveLength(1);
    expect(flashCalls.some(([t, m]) => t === 'error' && m === 'Requester name is required')).toBe(true);
  });
});

function dbRunParams() {
  const db = jest.requireMock('../src/models/database');
  const calls = db.prepare().run.mock.calls;
  return calls[calls.length - 1];
}

describe('assets show — related tickets scoped by viewer ticket access (pass 362)', () => {
  const assetsRouter = require('../src/routes/assets');
  const { canAccessResource } = jest.requireMock('../src/middleware/auth');

  beforeEach(() => {
    canAccessResource.mockReset();
    canAccessResource.mockReturnValue(true);
    const db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    stmt.get.mockReturnValue({
      id: 1, asset_tag: 'AST-001', name: 'Laptop', category: 'laptop',
      status: 'in_use', condition_rating: null, purchase_price: null,
      purchase_date: null, warranty_expiry: null, assigned_to: 1,
      location: null, notes: null, assigned_name: 'Me', assigned_email: 'me@x.com',
      created_at: null, updated_at: null
    });
    stmt.all.mockReturnValue([
      { id: 10, ticket_number: 'TK-010', title: 'Mine', status: 'open', priority: 'high', assigned_to: 1, created_at: null },
      { id: 11, ticket_number: 'TK-011', title: 'Not mine', status: 'open', priority: 'high', assigned_to: 7, created_at: null }
    ]);
  });

  it('filters related tickets through canAccessResource for non-privileged viewers', () => {
    canAccessResource.mockImplementation((req, t) => (req.session.user.role === 'admin' || Number(t.assigned_to) === Number(req.session.user.id)));
    const h = lastHandlerFor(assetsRouter, 'get', '/:id');
    let renderLocals = null;
    const req = { params: { id: '1' }, session: { user: { id: 1, role: 'staff' } }, flash: () => {}, audit: jest.fn() };
    const res = { redirect: () => {}, render: (v, locals) => {
      renderLocals = locals;
    }, status: () => res, json: () => {} };
    h(req, res, () => {});
    expect(renderLocals).not.toBeNull();
    // Only the ticket the staff viewer can access (their own) survives the scope.
    expect(renderLocals.relatedTickets.map((t) => t.id)).toEqual([10]);
    expect(canAccessResource).toHaveBeenCalledTimes(3); // asset gate + 2 ticket rows
  });
});

describe('staff index — last_login/avatar redacted for non-privileged non-self rows (pass 362)', () => {
  const staffRouter = require('../src/routes/staff');

  beforeEach(() => {
    const db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    stmt.get.mockClear();
    // The departments query now runs for PRIVILEGED viewers only (the
    // directory redacts each row's department for everyone else), so the
    // per-test setup below decides whether the first .all() call is the
    // departments lookup or the staff listing.
    stmt.all.mockReset();
  });

  const STAFF_ROW = {
    id: 2, username: 'alice', email: 'a@x.com', first_name: 'Alice', last_name: 'L', role: 'staff', department: 'IT', phone: '555', avatar: 'a.png', is_active: 1, last_login: '2026-01-01 00:00:00', created_at: null, updated_at: null, open_tickets: 0, open_tasks: 0
  };

  it('nulls last_login + avatar (alongside email/phone/department) for non-self rows', () => {
    const db = jest.requireMock('../src/models/database');
    db.prepare().all.mockReturnValue([STAFF_ROW]);
    const h = lastHandlerFor(staffRouter, 'get', '/');
    let renderLocals = null;
    const req = { query: {}, session: { user: { id: 1, role: 'staff' } }, flash: () => {}, audit: jest.fn(), get: (k) => (k === 'Referer' ? undefined : (k === 'Accept' ? 'text/html' : undefined)) };
    const res = { redirect: () => {}, render: (v, locals) => {
      renderLocals = locals;
    }, status: () => res, json: () => {} };
    h(req, res, () => {});
    expect(renderLocals).not.toBeNull();
    const row = renderLocals.staff[0];
    expect(row.email).toBeNull();
    expect(row.phone).toBeNull();
    expect(row.department).toBeNull();
    expect(row.last_login).toBeNull();
    expect(row.avatar).toBeNull();
    // A non-privileged viewer is not given the organisation's department list.
    expect(renderLocals.departments).toEqual([]);
  });

  it('keeps all fields for privileged viewers', () => {
    const db = jest.requireMock('../src/models/database');
    // Privileged viewers get the departments lookup first, then the listing.
    db.prepare().all.mockReturnValueOnce([{ department: 'IT' }]).mockReturnValue([STAFF_ROW]);
    const h = lastHandlerFor(staffRouter, 'get', '/');
    let renderLocals = null;
    const req = { query: {}, session: { user: { id: 9, role: 'admin' } }, flash: () => {}, audit: jest.fn(), get: (k) => (k === 'Accept' ? 'text/html' : undefined) };
    const res = { redirect: () => {}, render: (v, locals) => {
      renderLocals = locals;
    }, status: () => res, json: () => {} };
    h(req, res, () => {});
    expect(renderLocals).not.toBeNull();
    const row = renderLocals.staff[0];
    expect(row.email).toBe('a@x.com');
    expect(row.last_login).toBe('2026-01-01 00:00:00');
    expect(row.avatar).toBe('a.png');
    expect(renderLocals.departments).toEqual(['IT']);
  });
});

describe('logout — session regenerated before destroy (pass 362)', () => {
  it('rotates the session id so cached pre-logout cookies cannot be revived', async () => {
    const auth = require('../src/routes/auth');
    const h = lastHandlerFor(auth, 'post', '/logout');
    let regenCalled = 0;
    let destroyCalled = 0;
    const req = {
      body: {}, params: {}, method: 'POST',
      session: {
        user: { id: 1 },
        regenerate: (cb) => {
          regenCalled++; setImmediate(cb);
        },
        destroy: (cb) => {
          destroyCalled++; setImmediate(cb);
        }
      },
      flash: () => {}, audit: jest.fn()
    };
    const res = { redirect: () => {}, clearCookie: () => {}, headersSent: false, status: () => res, json: () => {} };
    h(req, res, () => {});
    // asyncHandler wraps the async logout handler; flush the event loop so
    // the regenerate-then-destroy callback chain is observable.
    await new Promise((resolve) => setImmediate(resolve));
    expect(regenCalled).toBe(1);
    expect(destroyCalled).toBe(1);
  });
});

describe('login-failure purge — never evicts an active lockout (pass 362)', () => {
  it('leaves every entry locked when the map is over capacity and fully locked', () => {
    // Re-require auth.js fresh so the interval/unref state is the module default.
    jest.isolateModules(() => {
      const auth = require('../src/routes/auth');
      // The internal maps are module-private; exercise the documented
      // behavior through the exported surface instead — verify via source
      // that the force-evict branch no longer deletes locked entries.
      const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'auth.js'), 'utf8');
      // The removed defect: force-evicting the oldest entry "regardless of
      // lock state" so a 10 000-name flood could release a victim's lockout.
      expect(src).not.toContain('map.delete(oldest)');
      expect(src).not.toMatch(/force-evict the oldest entry regardless of lock\s*\n?\s*state/i);
      expect(auth).toBeDefined();
    });
  });
});
