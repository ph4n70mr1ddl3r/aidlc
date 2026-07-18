const { describe, it, expect } = require('@jest/globals');


// Load the REAL route handlers with heavyweight deps mocked, so we exercise the
// actual HPP array-rejection logic (fail-closed) without spinning up an HTTP
// server. Each handler reads req.body fields, calls req.flash on failure, and
// res.redirect on reject — we assert the redirect fires for array payloads.
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

// Express routers store layer handlers; we capture the mounted handler by
// walking the router's layer stack and grabbing the last handler for the route.
function lastHandlerFor(router, method, pathPattern) {
  const layer = router.stack.find((l) => {
    const m = l.route && l.route.methods[method];
    return m && l.route.path === pathPattern;
  });
  // Last handler in the route's stack is our target (after middleware).
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function runHandler(handler, body, params = {}) {
  let redirectedTo = null;
  const flashCalls = [];
  const req = { body, params, method: 'POST', session: { user: { id: 1, role: 'admin' } }, flash: (type, msg) => flashCalls.push([type, msg]) };
  const res = { redirect: (to) => {
 redirectedTo = to;
}, render: () => {}, status: () => res, json: () => {} };
  handler(req, res, () => {});
  return { redirectedTo, flashCalls, req, res };
}

describe('HPP array rejection (regression — fail closed)', () => {
  describe('assets routes', () => {
    const assetsRouter = require('../src/routes/assets');

    it('rejects array name on create', () => {
      const h = lastHandlerFor(assetsRouter, 'post', '/');
      const { redirectedTo, flashCalls } = runHandler(h, { name: ['a', 'b'], category: 'Laptop' });
      expect(redirectedTo).not.toBeNull();
      expect(flashCalls.some(([t]) => t === 'error')).toBe(true);
    });

    it('rejects array name on update', () => {
      const h = lastHandlerFor(assetsRouter, 'put', '/:id');
      const { redirectedTo, flashCalls } = runHandler(h, { asset_tag: 'AST-001', name: ['x', 'y'], category: 'Laptop' }, { id: '1' });
      expect(redirectedTo).not.toBeNull();
      expect(flashCalls.some(([t]) => t === 'error')).toBe(true);
    });
  });

  describe('staff routes', () => {
    const staffRouter = require('../src/routes/staff');

    it('rejects array role on create', () => {
      const h = lastHandlerFor(staffRouter, 'post', '/');
      const { redirectedTo, flashCalls } = runHandler(h, {
        username: 'newuser', password: 'Passw0rd!Aa1', email: 'n@example.com',
        first_name: 'New', last_name: 'User', role: ['admin', 'staff']
      });
      expect(redirectedTo).not.toBeNull();
      expect(flashCalls.some(([t]) => t === 'error')).toBe(true);
    });

    it('rejects array email on update', () => {
      const h = lastHandlerFor(staffRouter, 'put', '/:id');
      const { redirectedTo, flashCalls } = runHandler(h, {
        email: ['a@x.com', 'b@x.com'], first_name: 'F', last_name: 'L', role: 'staff'
      }, { id: '1' });
      expect(redirectedTo).not.toBeNull();
      expect(flashCalls.some(([t]) => t === 'error')).toBe(true);
    });
  });

  describe('auth routes (self-service account writes)', () => {
    const authRouter = require('../src/routes/auth');

    it('rejects array email on profile update', () => {
      const h = lastHandlerFor(authRouter, 'put', '/profile');
      const { redirectedTo, flashCalls } = runHandler(h, {
        first_name: 'F', last_name: 'L', email: ['a@x.com', 'b@y.com'], phone: '5551234567'
      });
      expect(redirectedTo).not.toBeNull();
      expect(flashCalls.some(([t]) => t === 'error')).toBe(true);
    });

    it('rejects array phone on profile update', () => {
      const h = lastHandlerFor(authRouter, 'put', '/profile');
      const { redirectedTo, flashCalls } = runHandler(h, {
        first_name: 'F', last_name: 'L', email: 'a@x.com', phone: ['5551234567', '5550000000']
      });
      expect(redirectedTo).not.toBeNull();
      expect(flashCalls.some(([t]) => t === 'error')).toBe(true);
    });

    it('rejects array new_password on password change', () => {
      const h = lastHandlerFor(authRouter, 'put', '/profile/password');
      const { redirectedTo, flashCalls } = runHandler(h, {
        current_password: 'old', new_password: ['weak1', 'weak2'], confirm_password: 'weak1'
      });
      expect(redirectedTo).not.toBeNull();
      expect(flashCalls.some(([t]) => t === 'error')).toBe(true);
    });
  });
});
