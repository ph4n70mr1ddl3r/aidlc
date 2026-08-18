const { describe, it, expect } = require('@jest/globals');
const { lastHandlerFor } = require('./helpers');

// Regression tests for review cycle 136: error-message consistency and
// session-redirect reason parameter across projects.js and tickets.js.

jest.mock('better-sqlite3');
jest.mock('../src/models/database', () => {
  const stmt = {
    get: jest.fn(() => ({ budget: 0, spent: 0, status: 'in_progress', priority: 'medium', start_date: null, end_date: null })),
    all: jest.fn(() => []),
    run: jest.fn(() => ({ changes: 1, lastInsertRowid: 1 }))
  };
  return { prepare: jest.fn(() => stmt), exec: jest.fn(), pragma: jest.fn(), transaction: jest.fn((fn) => fn()), close: jest.fn() };
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

describe('projects.js error-message consistency (regression)', () => {
  const projectsRouter = require('../src/routes/projects');

  function runHandler(handler, body, params = {}) {
    const flashCalls = [];
    const redirectCalls = [];
    const req = {
      body, params, method: 'PUT',
      session: { user: { id: 1, role: 'admin' } },
      flash: (type, msg) => flashCalls.push([type, msg])
    };
    const res = {
      redirect: (to) => {
        redirectCalls.push(to);
      },
      render: () => {},
      status: () => res,
      json: () => {}
    };
    handler(req, res, () => {});
    return { redirectCalls, flashCalls };
  }

  it('task update rejects invalid task ID with entity-specific message', () => {
    const handler = lastHandlerFor(projectsRouter, 'put', '/:projectId/tasks/:taskId');
    const { flashCalls } = runHandler(handler, { title: 'Fix bug' }, { projectId: 'abc', taskId: '1' });
    const errorMsg = flashCalls.find(([type, msg]) => type === 'error' && msg.includes('Invalid'));
    expect(errorMsg).toBeDefined();
    expect(errorMsg[1]).toBe('Invalid task ID');
  });

  it('task delete rejects invalid task ID with entity-specific message', () => {
    const handler = lastHandlerFor(projectsRouter, 'delete', '/:projectId/tasks/:taskId');
    const { flashCalls } = runHandler(handler, {}, { projectId: 'abc', taskId: '1' });
    const errorMsg = flashCalls.find(([type, msg]) => type === 'error' && msg.includes('Invalid'));
    expect(errorMsg).toBeDefined();
    expect(errorMsg[1]).toBe('Invalid task ID');
  });

  it('member remove rejects invalid member ID with entity-specific message', () => {
    const handler = lastHandlerFor(projectsRouter, 'delete', '/:id/members/:memberId');
    const { flashCalls } = runHandler(handler, {}, { id: '1', memberId: 'abc' });
    const errorMsg = flashCalls.find(([type, msg]) => type === 'error' && msg.includes('Invalid'));
    expect(errorMsg).toBeDefined();
    expect(errorMsg[1]).toBe('Invalid member ID');
  });

  it('task quick-status catch falls through to consistent error message with project-update convention', () => {
    // The quick-status handler re-throws a non-NOT_FOUND error into its catch
    // block. The catch message must match the full-update convention
    // ('Error updating task. Please try again.') so operators see the same
    // phrasing regardless of which code path triggered the failure.
    const db = jest.requireMock('../src/models/database');
    // Make the transaction throw a generic error so the catch block fires
    db.transaction.mockImplementation(() => {
      throw new Error('some db error');
    });
    // Re-set the transaction mock on the real database module
    const projectsRouter2 = require('../src/routes/projects');
    const handler = lastHandlerFor(projectsRouter2, 'put', '/:projectId/tasks/:taskId');
    const { flashCalls } = runHandler(handler, { status: 'done', _quick_status: '1' }, { projectId: '1', taskId: '1' });
    const errorMsg = flashCalls.find(([type, msg]) => type === 'error' && msg.includes('Error updating task'));
    expect(errorMsg).toBeDefined();
    expect(errorMsg[1]).toBe('Error updating task. Please try again.');
  });

  it('task delete catch includes trailing period consistent with update convention', () => {
    const db = jest.requireMock('../src/models/database');
    db.transaction.mockImplementation(() => {
      throw new Error('db fail');
    });
    const projectsRouter2 = require('../src/routes/projects');
    const handler = lastHandlerFor(projectsRouter2, 'delete', '/:projectId/tasks/:taskId');
    const { flashCalls } = runHandler(handler, {}, { projectId: '1', taskId: '1' });
    const errorMsg = flashCalls.find(([type, msg]) => type === 'error' && msg.includes('Error deleting task'));
    expect(errorMsg).toBeDefined();
    expect(errorMsg[1]).toBe('Error deleting task. Please try again.');
  });

  it('member add catch includes trailing period consistent with update convention', () => {
    const db = jest.requireMock('../src/models/database');
    db.transaction.mockImplementation(() => {
      throw new Error('db fail');
    });
    const projectsRouter2 = require('../src/routes/projects');
    const handler = lastHandlerFor(projectsRouter2, 'post', '/:id/members');
    const { flashCalls } = runHandler(handler, { user_id: '1', role: 'member' }, { id: '1' });
    const errorMsg = flashCalls.find(([type, msg]) => type === 'error' && msg.includes('Error adding member'));
    expect(errorMsg).toBeDefined();
    expect(errorMsg[1]).toBe('Error adding member. Please try again.');
  });

  it('member remove catch includes trailing period consistent with update convention', () => {
    const db = jest.requireMock('../src/models/database');
    db.transaction.mockImplementation(() => {
      throw new Error('db fail');
    });
    const projectsRouter2 = require('../src/routes/projects');
    const handler = lastHandlerFor(projectsRouter2, 'delete', '/:id/members/:memberId');
    const { flashCalls } = runHandler(handler, {}, { id: '1', memberId: '1' });
    const errorMsg = flashCalls.find(([type, msg]) => type === 'error' && msg.includes('Error removing member'));
    expect(errorMsg).toBeDefined();
    expect(errorMsg[1]).toBe('Error removing member. Please try again.');
  });
});

describe('tickets.js error-message consistency and session-redirect reason (regression)', () => {
  const ticketsRouter = require('../src/routes/tickets');

  function runHandler(handler, body, params = {}) {
    const flashCalls = [];
    const redirectCalls = [];
    const req = {
      body, params, method: 'POST',
      session: { user: { id: 1, role: 'staff' } },
      flash: (type, msg) => flashCalls.push([type, msg])
    };
    const res = {
      redirect: (to) => {
        redirectCalls.push(to);
      },
      render: () => {},
      status: () => res,
      json: () => {}
    };
    handler(req, res, () => {});
    return { redirectCalls, flashCalls };
  }

  it('comment add catch includes trailing period consistent with update convention', () => {
    const db = jest.requireMock('../src/models/database');
    db.transaction.mockImplementation(() => {
      throw new Error('db fail');
    });
    const handler = lastHandlerFor(ticketsRouter, 'post', '/:id/comments');
    const { flashCalls } = runHandler(handler, { comment: 'test' }, { id: '1' });
    const errorMsg = flashCalls.find(([type, msg]) => type === 'error' && msg.includes('Error adding comment'));
    expect(errorMsg).toBeDefined();
    expect(errorMsg[1]).toBe('Error adding comment. Please try again.');
  });

  it('status update catch includes trailing period consistent with update convention', () => {
    const db = jest.requireMock('../src/models/database');
    db.transaction.mockImplementation(() => {
      throw new Error('db fail');
    });
    const handler = lastHandlerFor(ticketsRouter, 'put', '/:id/status');
    const { flashCalls } = runHandler(handler, { status: 'in_progress' }, { id: '1' });
    const errorMsg = flashCalls.find(([type, msg]) => type === 'error' && msg.includes('Error updating status'));
    expect(errorMsg).toBeDefined();
    expect(errorMsg[1]).toBe('Error updating status. Please try again.');
  });

  it('USER_INACTIVE comment-path redirect carries session_expired reason', () => {
    // When a comment handler detects the user's account is no longer active,
    // the redirect to /login must carry a ?reason= query parameter so the
    // login page can explain why the user was sent there (matching the
    // pattern used by requireAuth / destroySessionAndRedirect throughout
    // the middleware and all other routes).
    const db = jest.requireMock('../src/models/database');
    db.transaction.mockImplementation(() => {
      throw new Error('USER_INACTIVE');
    });
    const handler = lastHandlerFor(ticketsRouter, 'post', '/:id/comments');
    const { redirectCalls, flashCalls } = runHandler(handler, { comment: 'test' }, { id: '1' });
    const reasonRedirect = redirectCalls.find((r) => r && r.startsWith('/login'));
    expect(reasonRedirect).toBeDefined();
    expect(reasonRedirect).toBe('/login?reason=session_expired');
    // The flash should still inform the user about the account status.
    const infoMsg = flashCalls.find(([type, msg]) => type === 'error' && msg.includes('account is no longer active'));
    expect(infoMsg).toBeDefined();
  });
});
