const { describe, it, expect } = require('@jest/globals');
const { lastHandlerFor } = require('./helpers');

jest.mock('better-sqlite3');
jest.mock('../src/models/database', () => {
  const stmt = { get: jest.fn(() => ({ budget: 0, spent: 0, status: 'in_progress', priority: 'medium', start_date: null, end_date: null })), all: jest.fn(() => []), run: jest.fn(() => ({ changes: 1, lastInsertRowid: 1 })) };
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

function runHandler(handler, body, params = {}) {
  const redirectCalls = [];
  const flashCalls = [];
  const req = { body, params, method: 'PUT', session: { user: { id: 1, role: 'admin' } }, flash: (type, msg) => flashCalls.push([type, msg]), audit: jest.fn() };
  const res = {
    redirect: (to) => {
      redirectCalls.push(to);
    },
    render: () => {},
    status: () => res,
    json: () => {}
  };
  handler(req, res, () => {});
  return { redirectCalls, flashCalls, req, res };
}

describe('Projects update handler — no double-redirect regression', () => {
  const projectsRouter = require('../src/routes/projects');

  it('does not double-redirect on NOT_FOUND error from update run()', () => {
    const db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    stmt.run.mockReturnValue({ changes: 0, lastInsertRowid: 1 });
    try {
      const h = lastHandlerFor(projectsRouter, 'put', '/:id');
      const { redirectCalls, flashCalls } = runHandler(h, {
        name: 'Test Project', status: 'in_progress', priority: 'medium'
      }, { id: '1' });
      expect(redirectCalls).toHaveLength(1);
      expect(redirectCalls[0]).toBe('/projects');
      const errorFlash = flashCalls.find(([t]) => t === 'error');
      expect(errorFlash).toBeDefined();
      expect(errorFlash[1]).toBe('Project not found');
    } finally {
      stmt.run.mockReturnValue({ changes: 1, lastInsertRowid: 1 });
    }
  });

  it('does not double-redirect on generic error — redirected to /edit once', () => {
    const origError = console.error;
    console.error = jest.fn();
    try {
      const db = jest.requireMock('../src/models/database');
      const stmt = db.prepare();
      stmt.run.mockImplementation(() => {
        throw new Error('DB_CONNECTION_LOST');
      });
      try {
        const h = lastHandlerFor(projectsRouter, 'put', '/:id');
        const { redirectCalls } = runHandler(h, {
          name: 'Test Project', status: 'in_progress', priority: 'medium'
        }, { id: '1' });
        expect(redirectCalls).toHaveLength(1);
        expect(redirectCalls[0]).toBe('/projects/1/edit');
      } finally {
        stmt.run.mockReturnValue({ changes: 1, lastInsertRowid: 1 });
      }
    } finally {
      console.error = origError;
    }
  });
});

describe('Projects task assignee — fail closed on malformed id (regression)', () => {
  const projectsRouter = require('../src/routes/projects');

  it('rejects a malformed assigned_to on task full-update instead of silently wiping it', () => {
    const db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    stmt.run.mockClear();
    const h = lastHandlerFor(projectsRouter, 'put', '/:projectId/tasks/:taskId');
    const { redirectCalls, flashCalls } = runHandler(h, {
      title: 'Fix bug', status: 'in_progress', priority: 'medium', assigned_to: 'abc'
    }, { projectId: '1', taskId: '2' });
    expect(redirectCalls).toEqual(['/projects/1']);
    const errorFlash = flashCalls.find(([t]) => t === 'error');
    expect(errorFlash).toBeDefined();
    expect(errorFlash[1]).toBe('Invalid assignee');
    expect(stmt.run).not.toHaveBeenCalled();
  });

  it('rejects a malformed assigned_to on task add instead of creating the task unassigned', () => {
    const db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    stmt.run.mockClear();
    const h = lastHandlerFor(projectsRouter, 'post', '/:id/tasks');
    const { redirectCalls, flashCalls } = runHandler(h, {
      title: 'Fix bug', status: 'todo', priority: 'medium', assigned_to: '3.5'
    }, { id: '1' });
    expect(redirectCalls).toEqual(['/projects/1']);
    const errorFlash = flashCalls.find(([t]) => t === 'error');
    expect(errorFlash).toBeDefined();
    expect(errorFlash[1]).toBe('Invalid assignee');
    expect(stmt.run).not.toHaveBeenCalled();
  });

  it('still allows an empty assigned_to to mean "unassign" on task full-update', () => {
    const db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    stmt.run.mockClear();
    const h = lastHandlerFor(projectsRouter, 'put', '/:projectId/tasks/:taskId');
    const { redirectCalls, flashCalls } = runHandler(h, {
      title: 'Fix bug', status: 'in_progress', priority: 'medium', assigned_to: ''
    }, { projectId: '1', taskId: '2' });
    expect(redirectCalls).toEqual(['/projects/1']);
    expect(flashCalls.some(([t, m]) => t === 'error' && m === 'Invalid assignee')).toBe(false);
    expect(stmt.run).toHaveBeenCalled();
  });

  it('still allows an empty assigned_to to mean "unassigned" on task add', () => {
    const db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    stmt.run.mockClear();
    const h = lastHandlerFor(projectsRouter, 'post', '/:id/tasks');
    const { redirectCalls, flashCalls } = runHandler(h, {
      title: 'Fix bug', status: 'todo', priority: 'medium', assigned_to: ''
    }, { id: '1' });
    expect(redirectCalls).toEqual(['/projects/1']);
    expect(flashCalls.some(([t, m]) => t === 'error' && m === 'Invalid assignee')).toBe(false);
    expect(stmt.run).toHaveBeenCalled();
  });
});
