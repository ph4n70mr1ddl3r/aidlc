const { describe, it, expect } = require('@jest/globals');

// Regression tests for list-route read audits. Every paginated list endpoint
// must log a read audit so that viewing a collection leaves a trace consistent
// with individual show routes and the dashboard.

jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => next(),
  requireAdminOrManager: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next()
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

function findListRoute(router) {
  const layer = router.stack.find(l => l.route && l.route.methods.get && l.route.path === '/');
  if (!layer) {
    throw new Error('GET / route not found on router');
  }
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

describe('list route read audits', () => {
  it('assets list logs a read audit', () => {
    const assetsRouter = require('../src/routes/assets');
    const handler = findListRoute(assetsRouter);
    const audit = jest.fn();
    const req = { session: { user: { id: 1 } }, audit, query: {} };
    const res = { render: jest.fn() };
    handler(req, res, () => {});
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith('read', 'asset', null, 'Viewed assets list');
  });

  it('changes list logs a read audit', () => {
    const changesRouter = require('../src/routes/changes');
    const handler = findListRoute(changesRouter);
    const audit = jest.fn();
    const req = { session: { user: { id: 1 } }, audit, query: {} };
    const res = { render: jest.fn() };
    handler(req, res, () => {});
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith('read', 'change', null, 'Viewed change log list');
  });

  it('knowledge list logs a read audit', () => {
    const kbRouter = require('../src/routes/knowledge');
    const handler = findListRoute(kbRouter);
    const audit = jest.fn();
    const req = { session: { user: { id: 1 } }, audit, query: {} };
    const res = { render: jest.fn() };
    handler(req, res, () => {});
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith('read', 'knowledge_article', null, 'Viewed knowledge base list');
  });

  it('licenses list logs a read audit', () => {
    const licensesRouter = require('../src/routes/licenses');
    const handler = findListRoute(licensesRouter);
    const audit = jest.fn();
    const req = { session: { user: { id: 1 } }, audit, query: {} };
    const res = { render: jest.fn() };
    handler(req, res, () => {});
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith('read', 'license', null, 'Viewed licenses list');
  });

  it('projects list logs a read audit', () => {
    const projectsRouter = require('../src/routes/projects');
    const handler = findListRoute(projectsRouter);
    const audit = jest.fn();
    const req = { session: { user: { id: 1 } }, audit, query: {} };
    const res = { render: jest.fn() };
    handler(req, res, () => {});
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith('read', 'project', null, 'Viewed projects list');
  });

  it('staff list logs a read audit', () => {
    const staffRouter = require('../src/routes/staff');
    const handler = findListRoute(staffRouter);
    const audit = jest.fn();
    const req = { session: { user: { id: 1 } }, audit, query: {} };
    const res = { render: jest.fn() };
    handler(req, res, () => {});
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith('read', 'user', null, 'Viewed staff list');
  });

  it('tickets list logs a read audit', () => {
    const ticketsRouter = require('../src/routes/tickets');
    const handler = findListRoute(ticketsRouter);
    const audit = jest.fn();
    const req = { session: { user: { id: 1 } }, audit, query: {} };
    const res = { render: jest.fn() };
    handler(req, res, () => {});
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith('read', 'ticket', null, 'Viewed tickets list');
  });

  it('vendors list logs a read audit', () => {
    const vendorsRouter = require('../src/routes/vendors');
    const handler = findListRoute(vendorsRouter);
    const audit = jest.fn();
    const req = { session: { user: { id: 1 } }, audit, query: {} };
    const res = { render: jest.fn() };
    handler(req, res, () => {});
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith('read', 'vendor', null, 'Viewed vendors list');
  });
});
