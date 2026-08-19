const { describe, it, expect, beforeEach } = require('@jest/globals');
const fs = require('fs');
const path = require('path');

// Regression test: the vendor routes previously used canAccessResource() on the
// show route — a helper that can only pass for non-privileged users when the
// resource carries an ownership field (assigned_to/owner_id/user_id/author_id).
// Vendors have none of those fields, so for staff the check was structurally
// always-false: it merely acted as an accidental role gate while GET / stayed
// open to every authenticated user and rendered the same contact PII (contact
// person, email) in its list columns. Pass 140 replaced the dead check with an
// explicit requireAdminOrManager gate on BOTH the list and show routes — the
// same coherent policy licenses.js uses. This test pins that policy so a
// future refactor cannot silently reopen vendor PII to all staff.
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
  const req = {
    params,
    method: 'GET',
    session: { user: sessionUser },
    flash: (type, msg) => flashCalls.push([type, msg]),
    audit: () => {}
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
  return { redirectCalls, flashCalls, renderArgs, req, res };
}

// True when the route's middleware chain contains the requireAdminOrManager
// gate (the mock preserves the function name, so the stack introspection works
// against the mocked module exactly as it would against the real one).
function routeHasAdminGate(router, method, routePath) {
  const layer = router.stack.find((l) => {
    const m = l.route && l.route.methods[method];
    return m && l.route.path === routePath;
  });
  if (!layer || !layer.route || !layer.route.stack) {
    return false;
  }
  return layer.route.stack.some((s) => s.handle && s.handle.name === 'requireAdminOrManager');
}

describe('vendor routes — requireAdminOrManager policy (regression)', () => {
  const vendorsRouter = require('../src/routes/vendors');
  const db = jest.requireMock('../src/models/database');

  beforeEach(() => {
    db.prepare().get.mockClear();
  });

  it('gates the vendor list route (GET /) with requireAdminOrManager', () => {
    expect(routeHasAdminGate(vendorsRouter, 'get', '/')).toBe(true);
  });

  it('gates the vendor show route (GET /:id) with requireAdminOrManager', () => {
    expect(routeHasAdminGate(vendorsRouter, 'get', '/:id')).toBe(true);
  });

  it('no longer routes vendor authorization through canAccessResource', () => {
    // The ownership-field helper can never pass for staff on vendor rows;
    // keeping it would resurrect the structurally-dead check this pass removed.
    // Assert on the middleware import and call sites (not raw substrings) so
    // explanatory comments cannot mask a reintroduction.
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'vendors.js'), 'utf8');
    const importMatch = source.match(/const \{[^}]*\} = require\('[^']*middleware\/auth'\);/);
    expect(importMatch).toBeTruthy();
    expect(importMatch[0]).not.toContain('canAccessResource');
    expect(source).not.toMatch(/[^-\w]canAccessResource\s*\(/);
  });

  it('still renders the vendor show page when the row exists (gate is upstream)', () => {
    db.prepare().get.mockReturnValueOnce({
      id: 1, name: 'Acme Corp', contact_person: 'Bob', email: 'bob@acme.com',
      phone: '555-0000', address: null, website: null, category: null,
      contract_start: null, contract_end: null, notes: null, rating: null,
      is_active: 1, created_at: '2024-01-01', updated_at: '2024-01-01'
    });
    const layer = vendorsRouter.stack.find((l) => l.route && l.route.methods.get && l.route.path === '/:id');
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    const { redirectCalls, renderArgs } = runHandler(handler, { id: '1' });
    expect(redirectCalls).toHaveLength(0);
    expect(renderArgs).toBeTruthy();
    expect(renderArgs.title).toBe('Acme Corp');
  });
});
