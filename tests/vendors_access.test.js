const { describe, it, expect, beforeEach } = require('@jest/globals');
const { lastHandlerFor } = require('./helpers');

// Regression test: the vendor show route previously omitted the canAccessResource
// check that every other entity show route (assets, tickets, projects, changes)
// enforces. Any authenticated user could view any vendor's details including
// PII (contact person, email, phone, address). This test pins the fix so a
// future refactor cannot silently drop the guard again.
jest.mock('better-sqlite3');
jest.mock('../src/models/database', () => {
  const stmt = { get: jest.fn(() => null), all: jest.fn(() => []), run: jest.fn(() => ({ changes: 0 })) };
  return { prepare: jest.fn(() => stmt), exec: jest.fn(), pragma: jest.fn(), transaction: jest.fn((fn) => fn), close: jest.fn() };
});
jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => next(),
  requireAdminOrManager: (req, res, next) => next(),
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

function runHandler(handler, params = {}, sessionUser = { id: 1, role: 'staff' }) {
  const redirectCalls = [];
  const flashCalls = [];
  let renderArgs = null;
  const reqAuditCalls = [];
  const req = {
    params,
    method: 'GET',
    session: { user: sessionUser },
    flash: (type, msg) => flashCalls.push([type, msg]),
    audit: (...args) => reqAuditCalls.push(args)
  };
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
  return { redirectCalls, flashCalls, renderArgs, reqAuditCalls, req, res };
}

function errorFlash(flashCalls) {
  const found = flashCalls.find(([t]) => t === 'error');
  return found ? found[1] : undefined;
}

describe('vendor show route — canAccessResource guard (regression)', () => {
  const vendorsRouter = require('../src/routes/vendors');
  const auth = jest.requireMock('../src/middleware/auth');
  const audit = jest.requireMock('../src/middleware/audit');
  const db = jest.requireMock('../src/models/database');

  beforeEach(() => {
    auth.canAccessResource.mockClear();
    audit.audit.mockClear();
    db.prepare().get.mockClear();
  });

  it('returns 403-equivalent redirect when canAccessResource denies the user', () => {
    auth.canAccessResource.mockReturnValueOnce(false);
    db.prepare().get.mockReturnValueOnce({
      id: 1, name: 'Acme Corp', contact_person: 'Bob', email: 'bob@acme.com',
      phone: '555-0000', address: null, website: null, category: null,
      contract_start: null, contract_end: null, notes: null, rating: null,
      is_active: 1, created_at: '2024-01-01', updated_at: '2024-01-01'
    });
    const h = lastHandlerFor(vendorsRouter, 'get', '/:id');
    const { redirectCalls, flashCalls } = runHandler(h, { id: '1' });
    expect(redirectCalls).toEqual(['/vendors']);
    expect(errorFlash(flashCalls)).toBe('You do not have permission to view this vendor');
  });

  it('records an access_denied audit entry when access is denied', () => {
    auth.canAccessResource.mockReturnValueOnce(false);
    db.prepare().get.mockReturnValueOnce({
      id: 1, name: 'Acme Corp', contact_person: 'Bob', email: 'bob@acme.com',
      phone: '555-0000', address: null, website: null, category: null,
      contract_start: null, contract_end: null, notes: null, rating: null,
      is_active: 1, created_at: '2024-01-01', updated_at: '2024-01-01'
    });
    const h = lastHandlerFor(vendorsRouter, 'get', '/:id');
    const { reqAuditCalls } = runHandler(h, { id: '1' });
    // req.audit is called by the route handler (not the module-level audit mock),
    // so check the captured calls on req instead.
    const accessDeniedCalls = reqAuditCalls.filter(([action]) => action === 'access_denied');
    expect(accessDeniedCalls.length).toBeGreaterThan(0);
    expect(accessDeniedCalls[0][1]).toBe('vendor');
    expect(accessDeniedCalls[0][2]).toBe(1);
  });

  it('renders the vendor when canAccessResource allows access', () => {
    auth.canAccessResource.mockReturnValueOnce(true);
    db.prepare().get.mockReturnValueOnce({
      id: 1, name: 'Acme Corp', contact_person: 'Bob', email: 'bob@acme.com',
      phone: '555-0000', address: null, website: null, category: null,
      contract_start: null, contract_end: null, notes: null, rating: null,
      is_active: 1, created_at: '2024-01-01', updated_at: '2024-01-01'
    });
    const h = lastHandlerFor(vendorsRouter, 'get', '/:id');
    const { redirectCalls, renderArgs } = runHandler(h, { id: '1' });
    expect(redirectCalls).toHaveLength(0);
    expect(renderArgs).toBeTruthy();
    expect(renderArgs.title).toBe('Acme Corp');
  });
});
