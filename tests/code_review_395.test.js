const { describe, it, expect } = require('@jest/globals');

// Regression for the knowledge index read-audit ordering: a request that is
// REFUSED (HTTP parameter pollution on the query params) is redirected back to
// the list and must NOT be recorded as a list view — "audit only what
// actually happened" is the app-wide convention every other read in the
// module follows (the show route audits AFTER its visibility guard). The read
// audit used to fire at the top of the handler, before the HPP rejection, so
// a refused request was audited as if the page had rendered.

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
jest.mock('../src/models/database', () => {
  const stmt = {
    get: jest.fn(() => null),
    all: jest.fn(() => []),
    run: jest.fn(() => ({ changes: 0, lastInsertRowid: 1 }))
  };
  return { prepare: jest.fn(() => stmt), exec: jest.fn(), pragma: jest.fn(), transaction: jest.fn((fn) => fn), close: jest.fn() };
});

function lastHandlerFor(router, method, path) {
  for (let i = router.stack.length - 1; i >= 0; i--) {
    const layer = router.stack[i];
    if (layer.route && layer.route.methods[method] && layer.route.path === path) {
      return layer.route.stack[layer.route.stack.length - 1].handle;
    }
  }
  throw new Error(`no ${method.toUpperCase()} ${path} on router`);
}

function runGetHandler(handler, query) {
  let redirectedTo = null;
  const flashCalls = [];
  const auditCalls = [];
  const req = {
    session: { user: { id: 1, role: 'admin' } },
    query,
    flash: (type, msg) => {
      flashCalls.push([type, msg]);
    },
    audit: (...args) => {
      auditCalls.push(args);
    }
  };
  const res = {
    redirect: (to) => {
      redirectedTo = to;
    },
    render: () => {}
  };
  handler(req, res, () => {});
  return { redirectedTo, flashCalls, auditCalls };
}

describe('knowledge index read-audit ordering', () => {
  it('does not audit the read when the query is HPP-rejected', () => {
    const kbRouter = require('../src/routes/knowledge');
    const handler = lastHandlerFor(kbRouter, 'get', '/');
    const { redirectedTo, flashCalls, auditCalls } = runGetHandler(handler, { status: ['published', 'draft'] });
    expect(redirectedTo).toBe('/knowledge');
    expect(flashCalls).toEqual([['error', 'Invalid request parameters']]);
    expect(auditCalls).toHaveLength(0);
  });

  it('still audits a clean read of the list', () => {
    const kbRouter = require('../src/routes/knowledge');
    const handler = lastHandlerFor(kbRouter, 'get', '/');
    const { redirectedTo, auditCalls } = runGetHandler(handler, {});
    // A clean request falls through to the render path — no redirect.
    expect(redirectedTo).toBeNull();
    expect(auditCalls).toEqual([['read', 'knowledge_article', null, 'Viewed knowledge base list']]);
  });
});
