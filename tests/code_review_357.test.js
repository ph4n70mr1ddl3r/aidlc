const { describe, it, expect } = require('@jest/globals');
const { lastHandlerFor } = require('./helpers');

// Regression tests for review pass 357 — two structurally dead access/consistency
// paths in tickets.js that earlier source corrections introduced:
//
// (1) PUT /:id/status no-op guard (added cycle 215) read `ticket.status` from
//     _ticketAssigneeStmt, which selected ONLY assigned_to — so the guard always
//     compared undefined and every same-status submission was re-written,
//     audited as "Status changed to X", and cache-invalidated as a change.
//     Fix: _ticketAssigneeStmt now selects `assigned_to, status`.
//
// (2) POST /:id/comments in-transaction access check passed the row fetched by
//     _commentExistsStmt to canAccessResource(). Cycle 194 trimmed that
//     statement to `SELECT id` on the (wrong) premise that assigned_to was a
//     dead column — but canAccessResource()'s staff branch consumes
//     `assigned_to`, so EVERY staff user got ACCESS_DENIED on every ticket
//     since then. Fix: the statement selects `id, assigned_to` again, and the
//     accompanying staff comment-access pin in code_review_194.test.js was
//     corrected to assert the right invariant.

// Stateful db mock: prepare() dispatches on SQL fragment, so each lazily- or
// module-level-prepared statement gets its own jest.fn-backed handle.
const state = {};
const mocks = {};

jest.mock('../src/models/database', () => {
  const mkStmt = (key) => ({
    get: (...args) => state[key] ? state[key].get(...args) : (mocks[key].get ? mocks[key].get(...args) : null),
    all: (...args) => (mocks[key].all ? mocks[key].all(...args) : []),
    run: (...args) => (mocks[key].run ? mocks[key].run(...args) : { changes: 0 })
  });
  return {
    prepare: jest.fn((sql) => {
      if (sql.includes('SELECT id, assigned_to FROM tickets')) {
        return mkStmt('commentTicket');
      }
      if (sql.includes('SELECT assigned_to, status FROM tickets')) {
        return mkStmt('statusTicket');
      }
      if (sql.includes('SELECT 1 FROM users')) {
        return mkStmt('activeUser');
      }
      if (sql.includes('INSERT INTO ticket_comments')) {
        return mkStmt('commentInsert');
      }
      if (sql.includes('UPDATE tickets SET updated_at')) {
        return mkStmt('commentTouch');
      }
      if (sql.includes('UPDATE tickets SET status')) {
        return mkStmt('statusUpdate');
      }
      return { get: jest.fn(() => null), all: jest.fn(() => []), run: jest.fn(() => ({ changes: 0 })) };
    }),
    exec: jest.fn(),
    pragma: jest.fn(),
    transaction: jest.fn((fn) => fn),
    close: jest.fn()
  };
});

// Real auth middleware stays real (requireAuth is bypassed per-test below), so
// the comment route exercises the genuine canAccessResource() staff branch.
jest.mock('../src/middleware/auth', () => ({
  ...jest.requireActual('../src/middleware/auth'),
  requireAuth: (req, _res, next) => next()
}));

jest.mock('../src/middleware/audit', () => ({
  audit: jest.fn(),
  auditMiddleware: (req, _res, next) => next()
}));

jest.mock('../src/routes/dashboard', () => {
  const Router = require('express').Router;
  const router = Router();
  router.invalidateDashboardCache = jest.fn();
  return router;
});

const { invalidateDashboardCache } = require('../src/routes/dashboard');
const tickets = require('../src/routes/tickets');

const makeRes = () => ({ redirect: jest.fn() });
const makeReq = (overrides) => Object.assign({
  params: {},
  body: {},
  query: {},
  ip: '203.0.113.5',
  session: { user: { id: 42, role: 'staff', username: 'staff' } },
  flash: jest.fn(),
  audit: jest.fn(),
  hostname: 'localhost'
}, overrides);

describe('code review 357 — quick-status no-op guard is reachable (status column restored)', () => {
  it('source pins _ticketAssigneeStmt to select assigned_to AND status', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'routes', 'tickets.js'), 'utf8');
    const match = src.match(/const _ticketAssigneeStmt = db\.prepare\('([^']+)'\)/);
    expect(match).toBeDefined();
    expect(match[1]).toMatch(/SELECT\s+assigned_to,\s*status\s+FROM\s+tickets/);
  });

  it('submitting the current status flashes info and performs no UPDATE/audit/invalidation', () => {
    const handler = lastHandlerFor(tickets, 'put', '/:id/status');
    mocks.statusTicket = { get: jest.fn(() => ({ assigned_to: 42, status: 'open' })) };
    mocks.statusUpdate = { run: jest.fn(() => ({ changes: 1 })) };
    const req = makeReq({ params: { id: '5' }, body: { status: 'open' } });
    const res = makeRes();

    handler(req, res);

    expect(mocks.statusTicket.get).toHaveBeenCalledWith(5);
    expect(mocks.statusUpdate.run).not.toHaveBeenCalled();
    expect(req.flash).toHaveBeenCalledWith('info', 'Status unchanged.');
    expect(req.audit).not.toHaveBeenCalled();
    expect(invalidateDashboardCache).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith('/tickets/5');
  });

  it('submitting a different status still runs the update and reports success', () => {
    const handler = lastHandlerFor(tickets, 'put', '/:id/status');
    mocks.statusTicket = { get: jest.fn(() => ({ assigned_to: 42, status: 'open' })) };
    mocks.statusUpdate = { run: jest.fn(() => ({ changes: 1 })) };
    const req = makeReq({ params: { id: '5' }, body: { status: 'closed' } });
    const res = makeRes();

    handler(req, res);

    expect(mocks.statusUpdate.run).toHaveBeenCalledWith('closed', 5);
    expect(req.flash).toHaveBeenCalledWith('success', 'Ticket status updated to closed.');
    expect(req.audit).toHaveBeenCalledWith('update', 'ticket', 5, 'Status changed to closed');
    expect(invalidateDashboardCache).toHaveBeenCalled();
  });
});

describe('code review 357 — staff can comment on tickets assigned to them (assigned_to restored)', () => {
  it('source pins _commentExistsStmt to select id AND assigned_to', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'routes', 'tickets.js'), 'utf8');
    const match = src.match(/const _commentExistsStmt = db\.prepare\('([^']+)'\)/);
    expect(match).toBeDefined();
    expect(match[1]).toMatch(/SELECT\s+id,\s*assigned_to\s+FROM\s+tickets/);
  });

  it('staff assigned to the ticket comments successfully', () => {
    const handler = lastHandlerFor(tickets, 'post', '/:id/comments');
    mocks.commentTicket = { get: jest.fn(() => ({ id: 5, assigned_to: 42 })) };
    mocks.activeUser = { get: jest.fn(() => ({ 1: 1 })) };
    mocks.commentInsert = { run: jest.fn(() => ({ changes: 1 })) };
    mocks.commentTouch = { run: jest.fn(() => ({ changes: 1 })) };
    const req = makeReq({ params: { id: '5' }, body: { comment: 'hello' } });
    const res = makeRes();

    handler(req, res);

    expect(mocks.commentInsert.run).toHaveBeenCalledWith(5, 42, 'hello', 0);
    expect(req.flash).toHaveBeenCalledWith('success', 'Comment added.');
    expect(req.audit).toHaveBeenCalledWith('comment', 'ticket', 5, 'Added comment');
    expect(res.redirect).toHaveBeenCalledWith('/tickets/5');
  });

  it('staff NOT assigned to the ticket (and not privileged) is denied', () => {
    const handler = lastHandlerFor(tickets, 'post', '/:id/comments');
    mocks.commentTicket = { get: jest.fn(() => ({ id: 7, assigned_to: 99 })) };
    mocks.activeUser = { get: jest.fn(() => ({ 1: 1 })) };
    mocks.commentInsert = { run: jest.fn(() => ({ changes: 1 })) };
    const req = makeReq({ params: { id: '7' }, body: { comment: 'sneaky' } });
    const res = makeRes();

    handler(req, res);

    expect(mocks.commentInsert.run).not.toHaveBeenCalled();
    expect(req.audit).toHaveBeenCalledWith('access_denied', 'ticket', 7, 'Unauthorized comment attempt on ticket');
    expect(req.flash).toHaveBeenCalledWith('error', 'Ticket not found');
    expect(res.redirect).toHaveBeenCalledWith('/tickets');
  });

  it('admin can comment on any ticket', () => {
    const handler = lastHandlerFor(tickets, 'post', '/:id/comments');
    mocks.commentTicket = { get: jest.fn(() => ({ id: 9, assigned_to: null })) };
    mocks.activeUser = { get: jest.fn(() => ({ 1: 1 })) };
    mocks.commentInsert = { run: jest.fn(() => ({ changes: 1 })) };
    mocks.commentTouch = { run: jest.fn(() => ({ changes: 1 })) };
    const req = makeReq({
      params: { id: '9' },
      body: { comment: 'first look', is_internal: 'on' },
      session: { user: { id: 1, role: 'admin', username: 'admin' } }
    });
    const res = makeRes();

    handler(req, res);

    expect(mocks.commentInsert.run).toHaveBeenCalledWith(9, 1, 'first look', 1);
    expect(req.flash).toHaveBeenCalledWith('success', 'Comment added.');
  });
});
