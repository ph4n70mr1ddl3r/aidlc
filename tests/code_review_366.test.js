const { describe, it, expect, beforeEach } = require('@jest/globals');
const { lastHandlerFor } = require('./helpers');

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

const ARTICLE = {
  id: 1,
  title: 'Original title',
  content: 'Original content',
  category: 'how_to',
  tags: 'stale,outside',
  author_id: 1,
  status: 'published',
  is_featured: 0
};

function runUpdate(body) {
  const redirectCalls = [];
  const flashCalls = [];
  const req = {
    body,
    params: { id: '1' },
    method: 'PUT',
    session: { user: { id: 1, role: 'staff' } },
    flash: (type, msg) => flashCalls.push([type, msg]),
    audit: jest.fn()
  };
  const res = {
    redirect: (to) => {
      redirectCalls.push(to);
    },
    render: () => {}, status: () => res, json: () => {}, end: () => {}
  };
  const handler = lastHandlerFor(require('../src/routes/knowledge'), 'put', '/:id');
  handler(req, res, () => {});
  return { redirectCalls, flashCalls };
}

describe('knowledge update — tags resolved from the transaction-consistent row (pass 366)', () => {
  let db;
  let stmt;

  beforeEach(() => {
    db = jest.requireMock('../src/models/database');
    stmt = db.prepare();
    stmt.get.mockReset();
    stmt.run.mockReset();
    stmt.run.mockReturnValue({ changes: 1 });
  });

  it('preserves the tags re-read inside the transaction when tags are absent', () => {
    stmt.get
      .mockReturnValueOnce({ ...ARTICLE })
      .mockReturnValueOnce({ ...ARTICLE, tags: 'fresh,concurrent' });
    const { redirectCalls, flashCalls } = runUpdate({ title: 'Updated title', content: 'Updated content', category: 'how_to' });

    expect(flashCalls.some(([t]) => t === 'success')).toBe(true);
    expect(redirectCalls).toEqual(['/knowledge/1']);
    expect(stmt.run).toHaveBeenCalledTimes(1);
    expect(stmt.run.mock.calls[0][3]).toBe('fresh,concurrent');
  });

  it('still clears tags when the field is explicitly submitted empty', () => {
    stmt.get
      .mockReturnValueOnce({ ...ARTICLE })
      .mockReturnValueOnce({ ...ARTICLE, tags: 'fresh,concurrent' });
    const { flashCalls } = runUpdate({ title: 'Updated title', content: 'Updated content', category: 'how_to', tags: '' });

    expect(flashCalls.some(([t]) => t === 'success')).toBe(true);
    expect(stmt.run.mock.calls[0][3]).toBeNull();
  });
});
