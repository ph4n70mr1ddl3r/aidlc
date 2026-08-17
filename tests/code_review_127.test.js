const { describe, it, expect, beforeEach } = require('@jest/globals');
const { lastHandlerFor } = require('./helpers');

// Mock dependencies so the knowledge router loads in isolation.
jest.mock('marked', () => ({
  parse: jest.fn((content) => content.replace(/^# (.+)$/gm, '<h1>$1</h1>'))
}));
jest.mock('sanitize-html', () => {
  const mod = (html) => html;
  mod.defaults = { allowedTags: [], allowedAttributes: {} };
  mod.simpleTransform = () => () => ({});
  return mod;
});
jest.mock('../src/models/database', () => {
  const mockGet = jest.fn(() => null);
  const stmt = { get: mockGet, all: jest.fn(() => []), run: jest.fn(() => ({ changes: 0 })) };
  return {
    prepare: jest.fn(() => stmt),
    exec: jest.fn(),
    pragma: jest.fn(),
    transaction: jest.fn((fn) => fn()),
    close: jest.fn()
  };
});
jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => next(),
  requireAdminOrManager: (req, res, next) => next()
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

const db = require('../src/models/database');
const knowledgeRouter = require('../src/routes/knowledge');

/**
 * Regression: the knowledge show route previously mutated the DB query
 * result object in-place by adding `renderedContent`. If better-sqlite3
 * ever caches result objects, that mutation would leak across requests.
 * The fix shallow-copies the article before adding the derived property,
 * matching the safeAsset / safeTicket patterns used everywhere else in
 * the codebase.
 */
describe('knowledge show route — DB result immutability (regression)', () => {
  beforeEach(() => {
    db.prepare.mockClear();
  });

  it('does not mutate the original DB result object when adding renderedContent', () => {
    const articleRow = {
      id: 1,
      title: 'Test Article',
      content: '# Hello',
      category: 'how_to',
      tags: null,
      author_id: 1,
      status: 'published',
      views: 0,
      is_featured: 0,
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
      author_name: 'Test Author'
    };
    // The _showArticleStmt.get() call returns the row; subsequent calls
    // (e.g. _viewCountStmt.get) also return the same row object so we can
    // verify the original is never mutated.
    const mockStmt = db.prepare();
    mockStmt.get.mockReturnValue(articleRow);
    mockStmt.all.mockReturnValue([]);

    const handler = lastHandlerFor(knowledgeRouter, 'get', '/:id');
    let renderedLocals = null;
    const req = {
      params: { id: '1' },
      session: { user: { id: 2, role: 'staff' }, kb_viewed: [] },
      flash: jest.fn(),
      query: {},
      audit: jest.fn()
    };
    const res = {
      render: (template, locals) => {
        renderedLocals = locals;
      },
      status: () => res,
      json: () => res,
      set: () => res,
      redirect: () => {},
      send: () => {}
    };

    handler(req, res, () => {});

    // The original row must NOT have renderedContent added to it.
    expect(Object.hasOwn(articleRow, 'renderedContent')).toBe(false);
    // The template must receive an article that HAS renderedContent.
    expect(renderedLocals).not.toBeNull();
    expect(Object.hasOwn(renderedLocals.article, 'renderedContent')).toBe(true);
  });

  it('still renders the article when the DB returns a valid row', () => {
    const articleRow = {
      id: 1,
      title: 'Test Article',
      content: '# Hello',
      category: 'how_to',
      tags: null,
      author_id: 1,
      status: 'published',
      views: 0,
      is_featured: 0,
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
      author_name: 'Test Author'
    };
    const mockStmt = db.prepare();
    mockStmt.get.mockReturnValue(articleRow);
    mockStmt.all.mockReturnValue([]);

    const handler = lastHandlerFor(knowledgeRouter, 'get', '/:id');
    let renderedTemplate = null;
    let renderedArticleTitle = null;
    const req = {
      params: { id: '1' },
      session: { user: { id: 2, role: 'staff' }, kb_viewed: [] },
      flash: jest.fn(),
      query: {},
      audit: jest.fn()
    };
    const res = {
      render: (template, locals) => {
        renderedTemplate = template;
        renderedArticleTitle = locals.article?.title;
      },
      status: () => res,
      json: () => res,
      set: () => res,
      redirect: () => {},
      send: () => {}
    };

    handler(req, res, () => {});

    expect(renderedTemplate).toBe('pages/knowledge/show');
    expect(renderedArticleTitle).toBe('Test Article');
  });

  it('redirects to /knowledge when the article is not found', () => {
    const mockStmt = db.prepare();
    mockStmt.get.mockReturnValue(null);
    mockStmt.all.mockReturnValue([]);

    const handler = lastHandlerFor(knowledgeRouter, 'get', '/:id');
    let redirectedTo = null;
    const req = {
      params: { id: '1' },
      session: { user: { id: 2, role: 'staff' }, kb_viewed: [] },
      flash: jest.fn(),
      query: {},
      audit: jest.fn()
    };
    const res = {
      render: () => {},
      status: () => res,
      json: () => res,
      set: () => res,
      redirect: (to) => {
        redirectedTo = to;
      },
      send: () => {}
    };

    handler(req, res, () => {});

    expect(redirectedTo).toBe('/knowledge');
  });
});
