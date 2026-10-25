const { describe, it, expect, beforeEach } = require('@jest/globals');
const fs = require('fs');
const path = require('path');
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

const KB_PATH = path.join(__dirname, '..', 'src', 'routes', 'knowledge.js');

function sourceContains(fragment) {
  return fs.readFileSync(KB_PATH, 'utf8').includes(fragment);
}

function runHandler(handler, { params = { id: '1' }, body = {}, sessionUser = { id: 99, role: 'staff' } } = {}) {
  const redirectCalls = [];
  const flashCalls = [];
  const req = {
    body, params, method: 'PUT', session: { user: sessionUser },
    flash: (type, msg) => flashCalls.push([type, msg]),
    audit: jest.fn()
  };
  const res = {
    redirect: (to) => {
      redirectCalls.push(to);
    },
    render: () => {},
    status: () => res,
    json: () => {},
    end: () => {}
  };
  handler(req, res, () => {});
  return { redirectCalls, flashCalls };
}

describe('knowledge is_featured type-error wording (pass 389)', () => {
  const knowledgeRouter = require('../src/routes/knowledge');

  beforeEach(() => {
    const db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    stmt.get.mockReset();
    stmt.get.mockReturnValue({
      id: 1, title: 't', content: 'c', category: 'faq', tags: null,
      author_id: 99, status: 'published', views: 0, is_featured: 0,
      created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00'
    });
  });

  const ADMIN_SESSION = { id: 99, role: 'admin' };

  it('the update route rejects a wrong-typed is_featured with the app-wide wording', () => {
    const h = lastHandlerFor(knowledgeRouter, 'put', '/:id');
    for (const bad of [{ n: 1 }, 42, true]) {
      const { flashCalls } = runHandler(h, { body: { is_featured: bad }, sessionUser: ADMIN_SESSION });
      expect(flashCalls).toContainEqual(['error', 'Invalid request parameters']);
    }
  });

  it('the create route rejects a wrong-typed is_featured with the app-wide wording', () => {
    const h = lastHandlerFor(knowledgeRouter, 'post', '/');
    for (const bad of [{ n: 1 }, 42, false]) {
      const { flashCalls } = runHandler(h, {
        body: { title: 't', content: 'c', category: 'faq', is_featured: bad },
        sessionUser: ADMIN_SESSION
      });
      expect(flashCalls).toContainEqual(['error', 'Invalid request parameters']);
    }
  });

  it('a non-string nested in the canonical form-pairing array is rejected on update', () => {
    const h = lastHandlerFor(knowledgeRouter, 'put', '/:id');
    const { flashCalls } = runHandler(h, { body: { is_featured: ['0', { x: 1 }] }, sessionUser: ADMIN_SESSION });
    expect(flashCalls).toContainEqual(['error', 'Invalid request parameters']);
  });

  it('the canonical form-pairing shape and absent/empty submissions still pass the type check', () => {
    const h = lastHandlerFor(knowledgeRouter, 'put', '/:id');
    for (const ok of [['0', '1'], '1', '', undefined, null]) {
      const { flashCalls } = runHandler(h, {
        body: ok === undefined ? {} : { is_featured: ok },
        sessionUser: ADMIN_SESSION
      });
      expect(flashCalls).not.toContainEqual(['error', 'Invalid request parameters']);
    }
  });

  it('a non-canonical string value is still rejected on both verbs', () => {
    const update = lastHandlerFor(knowledgeRouter, 'put', '/:id');
    const create = lastHandlerFor(knowledgeRouter, 'post', '/');
    const u = runHandler(update, { body: { is_featured: 'yes' }, sessionUser: ADMIN_SESSION });
    expect(u.flashCalls).toContainEqual(['error', 'Invalid request parameters']);
    const c = runHandler(create, {
      body: { title: 't', content: 'c', category: 'faq', is_featured: 'yes' },
      sessionUser: ADMIN_SESSION
    });
    expect(c.flashCalls).toContainEqual(['error', 'Invalid request parameters']);
  });

  it('a form-pairing array whose last element is JSON null is the absent equivalent', () => {
    const h = lastHandlerFor(knowledgeRouter, 'put', '/:id');
    const { flashCalls } = runHandler(h, {
      body: { is_featured: ['0', null] },
      sessionUser: ADMIN_SESSION
    });
    expect(flashCalls).not.toContainEqual(['error', 'Invalid request parameters']);
  });

  it('pins the source-level type-error wording contract in knowledge.js', () => {
    expect(sourceContains('if (!isCanonicalFeaturedSubmission(isFeaturedLast)) {')).toBe(true);
    expect(sourceContains("req.flash('error', 'Invalid request parameters');")).toBe(true);
    expect(sourceContains('Invalid Featured Flag')).toBe(false);
  });
});
