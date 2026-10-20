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

function runDelete(handler, params = { id: '1' }, sessionUser = { id: 1, role: 'admin' }) {
  const redirectCalls = [];
  const flashCalls = [];
  const auditCalls = [];
  const req = {
    body: {}, params, method: 'DELETE', session: { user: sessionUser },
    flash: (type, msg) => flashCalls.push([type, msg]),
    audit: (...args) => auditCalls.push(args)
  };
  const res = {
    redirect: (to) => {
      redirectCalls.push(to);
    },
    render: () => {}, status: () => res, json: () => {}, end: () => {}
  };
  handler(req, res, () => {});
  return { redirectCalls, flashCalls, auditCalls };
}

describe('knowledge delete — no success audit without a deleted row (pass 365)', () => {
  const knowledgeRouter = require('../src/routes/knowledge');
  const ARTICLE = { id: 1, title: 'Hello', author_id: 1, status: 'published' };
  let db;

  beforeEach(() => {
    db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    stmt.get.mockReset();
    stmt.run.mockReset();
    stmt.get.mockReturnValue({ ...ARTICLE });
    stmt.run.mockReturnValue({ changes: 1 });
  });

  it('deletes and audits when the DELETE affects a row', () => {
    const h = lastHandlerFor(knowledgeRouter, 'delete', '/:id');
    const { redirectCalls, flashCalls, auditCalls } = runDelete(h);
    expect(redirectCalls).toEqual(['/knowledge']);
    expect(flashCalls.some(([t]) => t === 'success')).toBe(true);
    expect(auditCalls.some(([a]) => a === 'delete')).toBe(true);
  });

  it('reports not found and skips the success audit when changes === 0', () => {
    db.prepare().run.mockReturnValue({ changes: 0 });
    const h = lastHandlerFor(knowledgeRouter, 'delete', '/:id');
    const { redirectCalls, flashCalls, auditCalls } = runDelete(h);
    expect(redirectCalls).toEqual(['/knowledge']);
    expect(flashCalls).toContainEqual(['error', 'Article not found']);
    expect(auditCalls.some(([a]) => a === 'delete')).toBe(false);
  });

  it('reports not found and skips the audit when the article vanished before the transaction', () => {
    db.prepare().get.mockReturnValueOnce({ ...ARTICLE }).mockReturnValue(undefined);
    const h = lastHandlerFor(knowledgeRouter, 'delete', '/:id');
    const { flashCalls, auditCalls } = runDelete(h);
    expect(flashCalls).toContainEqual(['error', 'Article not found']);
    expect(auditCalls.some(([a]) => a === 'delete')).toBe(false);
  });
});
