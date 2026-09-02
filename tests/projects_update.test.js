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

describe('Projects update — date range validated against resolved values (regression)', () => {
  const projectsRouter = require('../src/routes/projects');

  it('rejects a partial update that would persist end_date before start_date', () => {
    // Stored: start=2026-01-01, end=2026-06-01. The edit moves start_date
    // forward to 2026-12-01 and leaves end_date empty. The submitted-only
    // range check (sEnd is null) passes, but the RESOLVED end date is still the
    // stored 2026-06-01 → end < start must be rejected (mirrors the vendors /
    // changes resolved-value fix), not silently persisted.
    const db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    stmt.get.mockReturnValue({
      budget: 0, spent: 0, status: 'in_progress', priority: 'medium',
      start_date: '2026-01-01', end_date: '2026-06-01'
    });
    stmt.run.mockClear();
    const h = lastHandlerFor(projectsRouter, 'put', '/:id');
    const { redirectCalls, flashCalls } = runHandler(h, {
      name: 'Test Project', status: 'in_progress', priority: 'medium',
      start_date: '2026-12-01'
    }, { id: '1' });
    expect(redirectCalls).toEqual(['/projects/1/edit']);
    const errorFlash = flashCalls.find(([t]) => t === 'error');
    expect(errorFlash).toBeDefined();
    expect(errorFlash[1]).toBe('End date must be on or after start date');
    expect(stmt.run).not.toHaveBeenCalled();
  });
});

describe('Projects task full-update — preserves stored due_date on partial submission (regression)', () => {
  const projectsRouter = require('../src/routes/projects');

  it('does not wipe the stored task due_date when the field is absent', () => {
    const db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    stmt.get.mockReturnValue({
      id: 2, project_id: 1, title: 'Old title', description: null,
      status: 'todo', priority: 'high', assigned_to: 5,
      due_date: '2026-05-05', completed_at: null, created_at: null, updated_at: null
    });
    stmt.run.mockClear();
    const h = lastHandlerFor(projectsRouter, 'put', '/:projectId/tasks/:taskId');
    const { redirectCalls } = runHandler(h, {
      title: 'Renamed', status: 'in_progress', priority: 'medium'
    }, { projectId: '1', taskId: '2' });
    expect(redirectCalls).toEqual(['/projects/1']);
    // First run() call is the task full-update; run(...params) is called with
    // spread args, so the call's args array IS the params array:
    // [title, description, status, priority, assigned_to, due_date, done, taskId, projectId]
    const firstRunArgs = stmt.run.mock.calls[0];
    expect(firstRunArgs[5]).toBe('2026-05-05');
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
    expect(errorFlash[1]).toBe('Invalid Assignee');
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
    expect(errorFlash[1]).toBe('Invalid Assignee');
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
    expect(flashCalls.some(([t, m]) => t === 'error' && m === 'Invalid Assignee')).toBe(false);
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
    expect(flashCalls.some(([t, m]) => t === 'error' && m === 'Invalid Assignee')).toBe(false);
    expect(stmt.run).toHaveBeenCalled();
  });
});

describe('Projects task full-update — empty due_date clears (regression)', () => {
  const projectsRouter = require('../src/routes/projects');

  it('clears a stored task due_date when submitted empty (regression: empty preserved stale date)', () => {
    // Stored due_date = '2026-05-05'. Submitting due_date: '' must CLEAR it
    // (null), matching the absent-vs-empty convention used by tickets.js /
    // assets.js / vendors.js / licenses.js / changes.js (absent preserves,
    // empty clears). Previously the empty value was treated as "preserve",
    // which made it impossible to clear a task due date via the project page.
    const db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    stmt.run.mockClear();
    stmt.get.mockReturnValue({
      id: 2, project_id: 1, title: 'Old title', description: null,
      status: 'todo', priority: 'high', assigned_to: 5,
      due_date: '2026-05-05', completed_at: null, created_at: null, updated_at: null
    });
    const h = lastHandlerFor(projectsRouter, 'put', '/:projectId/tasks/:taskId');
    const { redirectCalls } = runHandler(h, {
      title: 'Renamed', status: 'in_progress', priority: 'medium', due_date: ''
    }, { projectId: '1', taskId: '2' });
    expect(redirectCalls).toEqual(['/projects/1']);
    // The task full-update run has 9 args; the recalc progress run has 2 — find
    // the task update (9-arg call) to read its due_date column (index 5).
    const taskUpdate = stmt.run.mock.calls.find(c => c.length === 9);
    expect(taskUpdate).toBeDefined();
    expect(taskUpdate[5]).toBeNull(); // due_date cleared
  });
});

describe('Projects update — empty date clears, absent preserves (regression)', () => {
  const projectsRouter = require('../src/routes/projects');

  // The project UPDATE run has 10 args; the recalc progress run has 2 — find
  // the project update (10-arg call) to read its date columns.
  // [name(0), description(1), status(2), priority(3), start_date(4), end_date(5),
  //  budget(6), spent(7), owner_id(8), id(9)]
  function projectUpdateParams() {
    const db = jest.requireMock('../src/models/database');
    return db.prepare().run.mock.calls.find(c => c.length === 10);
  }

  it('clears a stored start_date when the field is submitted empty', () => {
    // Stored start_date = '2026-01-15'. Submitting start_date: '' must CLEAR it
    // (null), matching vendors.js / licenses.js / changes.js (absent preserves,
    // empty clears). Previously the empty value was treated as "preserve",
    // which made it impossible to unset a project start/end date via the form.
    const db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    stmt.run.mockClear();
    stmt.get.mockReturnValue({
      budget: 0, spent: 0, status: 'in_progress', priority: 'medium',
      start_date: '2026-01-15', end_date: '2026-06-01', owner_id: null
    });
    const h = lastHandlerFor(projectsRouter, 'put', '/:id');
    const { redirectCalls } = runHandler(h, {
      name: 'Test Project', status: 'in_progress', priority: 'medium', start_date: ''
    }, { id: '1' });
    expect(redirectCalls).toEqual(['/projects/1']);
    const params = projectUpdateParams();
    expect(params).toBeDefined();
    expect(params[4]).toBeNull(); // start_date cleared
    expect(params[5]).toBe('2026-06-01'); // end_date preserved (field was absent)
  });

  it('preserves a stored start_date when the field is ABSENT (partial API submission)', () => {
    const db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    stmt.run.mockClear();
    stmt.get.mockReturnValue({
      budget: 0, spent: 0, status: 'in_progress', priority: 'medium',
      start_date: '2026-01-15', end_date: '2026-06-01', owner_id: null
    });
    const h = lastHandlerFor(projectsRouter, 'put', '/:id');
    runHandler(h, {
      name: 'Test Project', status: 'in_progress', priority: 'medium'
    }, { id: '1' });
    const params = projectUpdateParams();
    expect(params).toBeDefined();
    expect(params[4]).toBe('2026-01-15'); // preserved — field was absent, not cleared
  });
});

describe('Projects update — absent description preserves, empty clears (regression)', () => {
  const projectsRouter = require('../src/routes/projects');

  // The project UPDATE run has 10 args; the recalc progress run has 2 — find
  // the project update (10-arg call) to read its description column (index 1).
  // [name(0), description(1), status(2), priority(3), start_date(4), end_date(5),
  //  budget(6), spent(7), owner_id(8), id(9)]
  function projectUpdateParams() {
    const db = jest.requireMock('../src/models/database');
    return db.prepare().run.mock.calls.find(c => c.length === 10);
  }

  it('preserves a stored description when the field is ABSENT (partial API submission)', () => {
    // Regression: previously the update used (description || '').substring(...)
    // || null, so an absent description wiped the stored value to NULL on a
    // partial submission — inconsistent with the route's own absent-vs-empty
    // convention for dates/budget/spent/owner (absent preserves, empty clears).
    const db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    stmt.run.mockClear();
    stmt.get.mockReturnValue({
      budget: 0, spent: 0, status: 'in_progress', priority: 'medium',
      start_date: null, end_date: null, owner_id: null, description: 'Stored description'
    });
    const h = lastHandlerFor(projectsRouter, 'put', '/:id');
    runHandler(h, {
      name: 'Test Project', status: 'in_progress', priority: 'medium'
    }, { id: '1' });
    const params = projectUpdateParams();
    expect(params).toBeDefined();
    expect(params[1]).toBe('Stored description'); // preserved — not wiped to NULL
  });

  it('clears a stored description when the field is submitted empty', () => {
    const db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    stmt.run.mockClear();
    stmt.get.mockReturnValue({
      budget: 0, spent: 0, status: 'in_progress', priority: 'medium',
      start_date: null, end_date: null, owner_id: null, description: 'Stored description'
    });
    const h = lastHandlerFor(projectsRouter, 'put', '/:id');
    runHandler(h, {
      name: 'Test Project', status: 'in_progress', priority: 'medium', description: ''
    }, { id: '1' });
    const params = projectUpdateParams();
    expect(params).toBeDefined();
    expect(params[1]).toBeNull(); // empty submitted value clears the field
  });

  it('updates the description when a new value is submitted', () => {
    const db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    stmt.run.mockClear();
    stmt.get.mockReturnValue({
      budget: 0, spent: 0, status: 'in_progress', priority: 'medium',
      start_date: null, end_date: null, owner_id: null, description: 'Stored description'
    });
    const h = lastHandlerFor(projectsRouter, 'put', '/:id');
    runHandler(h, {
      name: 'Test Project', status: 'in_progress', priority: 'medium', description: 'New description'
    }, { id: '1' });
    const params = projectUpdateParams();
    expect(params).toBeDefined();
    expect(params[1]).toBe('New description');
  });
});

describe('Projects task full-update — rejects non-string description (regression)', () => {
  const projectsRouter = require('../src/routes/projects');

  it('rejects a present-but-non-string description instead of silently clearing it', () => {
    // Regression: previously a JSON number or object in the description field
    // silently wiped the stored value to NULL. Using resolveOptionalField now
    // returns { error: true } for present non-string raw values, matching the
    // fail-closed convention used by vendors.js, licenses.js, and changes.js.
    const db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    stmt.run.mockClear();
    stmt.get.mockReturnValue({
      id: 2, project_id: 1, title: 'Old title', description: 'Stored desc',
      status: 'todo', priority: 'high', assigned_to: 5,
      due_date: null, completed_at: null, created_at: null, updated_at: null
    });
    const h = lastHandlerFor(projectsRouter, 'put', '/:projectId/tasks/:taskId');
    const { redirectCalls, flashCalls } = runHandler(h, {
      title: 'Renamed', status: 'in_progress', priority: 'medium', description: 123
    }, { projectId: '1', taskId: '2' });
    expect(redirectCalls).toEqual(['/projects/1']);
    const errorFlash = flashCalls.find(([t]) => t === 'error');
    expect(errorFlash).toBeDefined();
    expect(errorFlash[1]).toBe('Invalid Description');
    expect(stmt.run).not.toHaveBeenCalled();
  });
});
