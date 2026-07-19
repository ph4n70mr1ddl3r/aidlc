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

    it('rejects malformed purchase price on update instead of wiping stored price', () => {
      const h = lastHandlerFor(assetsRouter, 'put', '/:id');
      const { redirectedTo, flashCalls } = runHandler(h, {
        asset_tag: 'AST-001', name: 'Laptop', category: 'Laptop', purchase_price: '100abc'
      }, { id: '1' });
      expect(redirectedTo).not.toBeNull();
      expect(flashCalls.some(([t]) => t === 'error')).toBe(true);
    });

    it('rejects malformed purchase date on update instead of wiping stored date', () => {
      const h = lastHandlerFor(assetsRouter, 'put', '/:id');
      const { redirectedTo, flashCalls } = runHandler(h, {
        asset_tag: 'AST-001', name: 'Laptop', category: 'Laptop', purchase_date: '2026-13-45'
      }, { id: '1' });
      expect(redirectedTo).not.toBeNull();
      expect(flashCalls.some(([t]) => t === 'error')).toBe(true);
    });

    it('rejects malformed purchase price on create instead of silently storing NULL', () => {
      const h = lastHandlerFor(assetsRouter, 'post', '/');
      const { redirectedTo, flashCalls } = runHandler(h, {
        asset_tag: 'AST-001', name: 'Laptop', category: 'Laptop', purchase_price: '100abc'
      });
      expect(redirectedTo).not.toBeNull();
      expect(flashCalls.some(([t]) => t === 'error')).toBe(true);
    });

    it('rejects malformed purchase date on create instead of silently storing NULL', () => {
      const h = lastHandlerFor(assetsRouter, 'post', '/');
      const { redirectedTo, flashCalls } = runHandler(h, {
        asset_tag: 'AST-001', name: 'Laptop', category: 'Laptop', purchase_date: '2026-13-45'
      });
      expect(redirectedTo).not.toBeNull();
      expect(flashCalls.some(([t]) => t === 'error')).toBe(true);
    });

    it('rejects malformed warranty expiry on create instead of silently storing NULL', () => {
      const h = lastHandlerFor(assetsRouter, 'post', '/');
      const { redirectedTo, flashCalls } = runHandler(h, {
        asset_tag: 'AST-001', name: 'Laptop', category: 'Laptop', warranty_expiry: 'not-a-date'
      });
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

  describe('projects routes (task/member + project CRUD)', () => {
    const projectsRouter = require('../src/routes/projects');

    it('rejects array title on project create', () => {
      const h = lastHandlerFor(projectsRouter, 'post', '/');
      const { redirectedTo, flashCalls } = runHandler(h, { name: ['a', 'b'], status: 'active', priority: 'medium' });
      expect(redirectedTo).not.toBeNull();
      expect(flashCalls.some(([t]) => t === 'error')).toBe(true);
    });

    it('rejects array name on project update', () => {
      const h = lastHandlerFor(projectsRouter, 'put', '/:id');
      const { redirectedTo, flashCalls } = runHandler(h, { name: ['x', 'y'], status: 'active', priority: 'medium' }, { id: '1' });
      expect(redirectedTo).not.toBeNull();
      expect(flashCalls.some(([t]) => t === 'error')).toBe(true);
    });

    it('rejects malformed budget on project create instead of silently coercing to 0', () => {
      const h = lastHandlerFor(projectsRouter, 'post', '/');
      const { redirectedTo, flashCalls } = runHandler(h, { name: 'Rollout', status: 'active', priority: 'medium', budget: 'abc' });
      expect(redirectedTo).not.toBeNull();
      expect(flashCalls.some(([t]) => t === 'error')).toBe(true);
    });

    it('surfaces the specific flash (not a generic error) for malformed budget on project update', () => {
      const db = jest.requireMock('../src/models/database');
      const prev = db.prepare().get;
      db.prepare().get = jest.fn(() => ({ budget: 0, spent: 0 }));
      try {
        const h = lastHandlerFor(projectsRouter, 'put', '/:id');
        const { redirectedTo, flashCalls } = runHandler(h, { name: 'Rollout', status: 'in_progress', priority: 'medium', budget: 'abc' }, { id: '1' });
        expect(redirectedTo).toBe('/projects/1/edit');
        const errorFlash = flashCalls.find(([t]) => t === 'error');
        expect(errorFlash).toBeDefined();
        expect(errorFlash[1]).toBe('Invalid budget amount');
      } finally {
        db.prepare().get = prev;
      }
    });

    it('surfaces the specific flash (not a generic error) for malformed spent on project update', () => {
      const db = jest.requireMock('../src/models/database');
      const prev = db.prepare().get;
      db.prepare().get = jest.fn(() => ({ budget: 0, spent: 0 }));
      try {
        const h = lastHandlerFor(projectsRouter, 'put', '/:id');
        const { redirectedTo, flashCalls } = runHandler(h, { name: 'Rollout', status: 'in_progress', priority: 'medium', spent: 'xyz' }, { id: '1' });
        expect(redirectedTo).toBe('/projects/1/edit');
        const errorFlash = flashCalls.find(([t]) => t === 'error');
        expect(errorFlash).toBeDefined();
        expect(errorFlash[1]).toBe('Invalid amount spent');
      } finally {
        db.prepare().get = prev;
      }
    });

    it('rejects array title on task create', () => {
      const h = lastHandlerFor(projectsRouter, 'post', '/:id/tasks');
      const { redirectedTo, flashCalls } = runHandler(h, { title: ['a', 'b'], status: 'todo', priority: 'medium' }, { id: '1' });
      expect(redirectedTo).not.toBeNull();
      expect(flashCalls.some(([t]) => t === 'error')).toBe(true);
    });

    it('rejects array status on task update', () => {
      const h = lastHandlerFor(projectsRouter, 'put', '/:projectId/tasks/:taskId');
      const { redirectedTo, flashCalls } = runHandler(h, { status: ['done', 'todo'], priority: 'medium', _quick_status: '1' }, { projectId: '1', taskId: '1' });
      expect(redirectedTo).not.toBeNull();
      expect(flashCalls.some(([t]) => t === 'error')).toBe(true);
    });

    it('rejects array role on member add', () => {
      const h = lastHandlerFor(projectsRouter, 'post', '/:id/members');
      const { redirectedTo, flashCalls } = runHandler(h, { user_id: '2', role: ['lead', 'member'] }, { id: '1' });
      expect(redirectedTo).not.toBeNull();
      expect(flashCalls.some(([t]) => t === 'error')).toBe(true);
    });
  });

  describe('changes routes', () => {
    const changesRouter = require('../src/routes/changes');

    it('rejects array title on change create', () => {
      const h = lastHandlerFor(changesRouter, 'post', '/');
      const { redirectedTo, flashCalls } = runHandler(h, { title: ['a', 'b'], change_type: 'normal' });
      expect(redirectedTo).not.toBeNull();
      expect(flashCalls.some(([t]) => t === 'error')).toBe(true);
    });

    it('rejects array title on change update', () => {
      const h = lastHandlerFor(changesRouter, 'put', '/:id');
      const { redirectedTo, flashCalls } = runHandler(h, { title: ['x', 'y'], change_type: 'normal' }, { id: '1' });
      expect(redirectedTo).not.toBeNull();
      expect(flashCalls.some(([t]) => t === 'error')).toBe(true);
    });
  });

  describe('knowledge routes', () => {
    const knowledgeRouter = require('../src/routes/knowledge');

    it('rejects array title on article create', () => {
      const h = lastHandlerFor(knowledgeRouter, 'post', '/');
      const { redirectedTo, flashCalls } = runHandler(h, { title: ['a', 'b'], content: 'c', category: 'general' });
      expect(redirectedTo).not.toBeNull();
      expect(flashCalls.some(([t]) => t === 'error')).toBe(true);
    });

    it('rejects array content on article update', () => {
      const h = lastHandlerFor(knowledgeRouter, 'put', '/:id');
      const { redirectedTo, flashCalls } = runHandler(h, { title: 't', content: ['x', 'y'], category: 'general' }, { id: '1' });
      expect(redirectedTo).not.toBeNull();
      expect(flashCalls.some(([t]) => t === 'error')).toBe(true);
    });
  });

  describe('tickets routes', () => {
    const ticketsRouter = require('../src/routes/tickets');

    it('rejects array title on ticket create', () => {
      const h = lastHandlerFor(ticketsRouter, 'post', '/');
      const { redirectedTo, flashCalls } = runHandler(h, { title: ['a', 'b'], category: 'hardware', requester_name: 'Test', requester_email: 't@x.com' });
      expect(redirectedTo).not.toBeNull();
      expect(flashCalls.some(([t]) => t === 'error')).toBe(true);
    });

    it('rejects array title on ticket update', () => {
      const h = lastHandlerFor(ticketsRouter, 'put', '/:id');
      const { redirectedTo, flashCalls } = runHandler(h, { title: ['x', 'y'], category: 'hardware', status: 'open' }, { id: '1' });
      expect(redirectedTo).not.toBeNull();
      expect(flashCalls.some(([t]) => t === 'error')).toBe(true);
    });

    it('rejects array comment on ticket comment', () => {
      const h = lastHandlerFor(ticketsRouter, 'post', '/:id/comments');
      const { redirectedTo, flashCalls } = runHandler(h, { comment: ['a', 'b'] }, { id: '1' });
      expect(redirectedTo).not.toBeNull();
      expect(flashCalls.some(([t]) => t === 'error')).toBe(true);
    });

    it('rejects array satisfaction_rating (fail-closed)', () => {
      const h = lastHandlerFor(ticketsRouter, 'put', '/:id/satisfaction');
      const { redirectedTo, flashCalls } = runHandler(h, { satisfaction_rating: ['3', '5'] }, { id: '1' });
      expect(redirectedTo).not.toBeNull();
      expect(flashCalls.some(([t]) => t === 'error')).toBe(true);
    });

    it('rejects array status on quick status update (fail-closed)', () => {
      const h = lastHandlerFor(ticketsRouter, 'put', '/:id/status');
      const { redirectedTo, flashCalls } = runHandler(h, { status: ['resolved', 'open'] }, { id: '1' });
      expect(redirectedTo).not.toBeNull();
      expect(flashCalls.some(([t]) => t === 'error')).toBe(true);
    });
  });

  describe('licenses routes', () => {
    const licensesRouter = require('../src/routes/licenses');

    it('rejects array software_name on license create', () => {
      const h = lastHandlerFor(licensesRouter, 'post', '/');
      const { redirectedTo, flashCalls } = runHandler(h, { software_name: ['a', 'b'], license_type: 'subscription' });
      expect(redirectedTo).not.toBeNull();
      expect(flashCalls.some(([t]) => t === 'error')).toBe(true);
    });

    it('rejects array cost on license create (fail-closed)', () => {
      const h = lastHandlerFor(licensesRouter, 'post', '/');
      const { redirectedTo, flashCalls } = runHandler(h, {
        software_name: 'Adobe CC', license_type: 'subscription', cost: ['100', '200']
      });
      expect(redirectedTo).not.toBeNull();
      expect(flashCalls.some(([t]) => t === 'error')).toBe(true);
    });

    it('rejects array cost on license update (fail-closed)', () => {
      const h = lastHandlerFor(licensesRouter, 'put', '/:id');
      const { redirectedTo, flashCalls } = runHandler(h, {
        software_name: 'Adobe CC', license_type: 'subscription', cost: ['100', '200']
      }, { id: '1' });
      expect(redirectedTo).not.toBeNull();
      expect(flashCalls.some(([t]) => t === 'error')).toBe(true);
    });

    it('rejects malformed cost on license create instead of silently nulling it', () => {
      const h = lastHandlerFor(licensesRouter, 'post', '/');
      const { redirectedTo, flashCalls } = runHandler(h, {
        software_name: 'Adobe CC', license_type: 'subscription', cost: 'abc'
      });
      expect(redirectedTo).not.toBeNull();
      expect(flashCalls.some(([t]) => t === 'error')).toBe(true);
    });

    it('rejects malformed cost on license update instead of wiping stored cost', () => {
      const h = lastHandlerFor(licensesRouter, 'put', '/:id');
      const { redirectedTo, flashCalls } = runHandler(h, {
        software_name: 'Adobe CC', license_type: 'subscription', cost: '100abc'
      }, { id: '1' });
      expect(redirectedTo).not.toBeNull();
      expect(flashCalls.some(([t]) => t === 'error')).toBe(true);
    });
  });

  describe('vendors routes', () => {
    const vendorsRouter = require('../src/routes/vendors');

    it('rejects array name on vendor create', () => {
      const h = lastHandlerFor(vendorsRouter, 'post', '/');
      const { redirectedTo, flashCalls } = runHandler(h, { name: ['a', 'b'] });
      expect(redirectedTo).not.toBeNull();
      expect(flashCalls.some(([t]) => t === 'error')).toBe(true);
    });

    it('rejects array name on vendor update', () => {
      const h = lastHandlerFor(vendorsRouter, 'put', '/:id');
      const { redirectedTo, flashCalls } = runHandler(h, { name: ['x', 'y'] }, { id: '1' });
      expect(redirectedTo).not.toBeNull();
      expect(flashCalls.some(([t]) => t === 'error')).toBe(true);
    });

    it('rejects malformed contract_start on vendor create instead of silently storing NULL', () => {
      const h = lastHandlerFor(vendorsRouter, 'post', '/');
      const { redirectedTo, flashCalls } = runHandler(h, { name: 'Acme', contract_start: 'not-a-date' });
      expect(redirectedTo).not.toBeNull();
      expect(flashCalls.some(([t]) => t === 'error')).toBe(true);
    });

    it('rejects malformed contract_end on vendor create instead of silently storing NULL', () => {
      const h = lastHandlerFor(vendorsRouter, 'post', '/');
      const { redirectedTo, flashCalls } = runHandler(h, { name: 'Acme', contract_end: '2026-13-45' });
      expect(redirectedTo).not.toBeNull();
      expect(flashCalls.some(([t]) => t === 'error')).toBe(true);
    });

    it('rejects array contract_start on vendor create (fail-closed HPP)', () => {
      const h = lastHandlerFor(vendorsRouter, 'post', '/');
      const { redirectedTo, flashCalls } = runHandler(h, { name: 'Acme', contract_start: ['2025-01-01', '2025-02-01'] });
      expect(redirectedTo).not.toBeNull();
      expect(flashCalls.some(([t]) => t === 'error')).toBe(true);
    });

    it('rejects array contract_end on vendor update (fail-closed HPP)', () => {
      const h = lastHandlerFor(vendorsRouter, 'put', '/:id');
      const { redirectedTo, flashCalls } = runHandler(h, { name: 'Acme', contract_end: ['2025-01-01', '2025-02-01'] }, { id: '1' });
      expect(redirectedTo).not.toBeNull();
      expect(flashCalls.some(([t]) => t === 'error')).toBe(true);
    });
  });

  describe('staff reset-password route', () => {
    const staffRouter = require('../src/routes/staff');

    it('rejects array new_password on reset (fail-closed)', () => {
      const h = lastHandlerFor(staffRouter, 'put', '/:id/reset-password');
      const { redirectedTo, flashCalls } = runHandler(h, {
        new_password: ['weak1', 'weak2'], current_password: 'old'
      }, { id: '2' });
      expect(redirectedTo).not.toBeNull();
      expect(flashCalls.some(([t]) => t === 'error')).toBe(true);
    });

    it('rejects array current_password on reset (fail-closed)', () => {
      const h = lastHandlerFor(staffRouter, 'put', '/:id/reset-password');
      const { redirectedTo, flashCalls } = runHandler(h, {
        new_password: 'NewPassw0rd!Aa1', current_password: ['old1', 'old2']
      }, { id: '2' });
      expect(redirectedTo).not.toBeNull();
      expect(flashCalls.some(([t]) => t === 'error')).toBe(true);
    });
  });
});
