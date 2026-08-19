const fs = require('fs');
const path = require('path');
const { describe, it, expect } = require('@jest/globals');
const { lastHandlerFor } = require('./helpers');

// Regression tests for review cycle 139: (1) reports.js catch-block error
// messages must carry the trailing period that every other generic error
// message uses (pass 138 standardized this convention but missed the three
// reports routes); (2) a garbled duplicated-word comment in licenses.js and a
// misaligned block comment in vendors.js were cleaned up for readability.

jest.mock('better-sqlite3');
jest.mock('../src/models/database', () => {
  // Every report query runs through a prepared statement whose `.all()` / `.get()`
  // throws, so each report route's catch block fires deterministically.
  const throwingStmt = {
    get: jest.fn(() => {
      throw new Error('db fail');
    }),
    all: jest.fn(() => {
      throw new Error('db fail');
    }),
    run: jest.fn(() => ({ changes: 1, lastInsertRowid: 1 }))
  };
  return {
    prepare: jest.fn(() => throwingStmt),
    exec: jest.fn(),
    pragma: jest.fn(),
    transaction: jest.fn((fn) => fn()),
    close: jest.fn()
  };
});
jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => next(),
  requireAdminOrManager: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
  canAccessResource: jest.fn(() => true)
}));
jest.mock('../src/middleware/audit', () => ({
  audit: jest.fn(),
  auditMiddleware: (req, res, next) => next()
}));
jest.mock('../src/routes/dashboard', () => {
  const Router = require('express').Router;
  const router = Router();
  router.invalidateDashboardCache = jest.fn();
  return router;
});

/**
 * Build a minimal req/res pair that captures flash calls and redirects.
 */
function buildReqRes(query, sessionUser = { id: 1, role: 'admin' }) {
  const flashCalls = [];
  const redirectCalls = [];
  const req = {
    query,
    method: 'GET',
    session: { user: sessionUser },
    flash: (type, msg) => flashCalls.push([type, msg]),
    ip: '127.0.0.1'
  };
  const res = {
    redirect: (to) => {
      redirectCalls.push(to);
    },
    render: () => {},
    status: () => res,
    json: () => {},
    headersSent: false
  };
  return { req, res, flashCalls, redirectCalls };
}

function getFlash(flashCalls, matcher) {
  return flashCalls.find(([type, msg]) => type === 'error' && msg && matcher(msg));
}

describe('reports.js catch-block error punctuation (regression)', () => {
  it('ticket report catch uses trailing period', () => {
    jest.isolateModules(() => {
      const router = require('../src/routes/reports');
      const { req, res, flashCalls } = buildReqRes({});
      lastHandlerFor(router, 'get', '/tickets')(req, res, () => {});
      const msg = getFlash(flashCalls, (m) => m.includes('Error generating ticket report'));
      expect(msg).toBeDefined();
      expect(msg[1]).toMatch(/\.$/);
    });
  });

  it('asset report catch uses trailing period', () => {
    jest.isolateModules(() => {
      const router = require('../src/routes/reports');
      const { req, res, flashCalls } = buildReqRes({});
      lastHandlerFor(router, 'get', '/assets')(req, res, () => {});
      const msg = getFlash(flashCalls, (m) => m.includes('Error generating asset report'));
      expect(msg).toBeDefined();
      expect(msg[1]).toMatch(/\.$/);
    });
  });

  it('staff report catch uses trailing period', () => {
    jest.isolateModules(() => {
      const router = require('../src/routes/reports');
      const { req, res, flashCalls } = buildReqRes({});
      lastHandlerFor(router, 'get', '/staff')(req, res, () => {});
      const msg = getFlash(flashCalls, (m) => m.includes('Error generating staff report'));
      expect(msg).toBeDefined();
      expect(msg[1]).toMatch(/\.$/);
    });
  });
});

describe('comment readability fixes (regression)', () => {
  const srcDir = path.join(__dirname, '..', 'src', 'routes');

  it('licenses.js comment has no duplicated "mirrors" phrasing', () => {
    const source = fs.readFileSync(path.join(srcDir, 'licenses.js'), 'utf8');
    // Lines 320-321 previously read "Mirrors the raw-vs-processed split mirrors
    // the pattern in vendors.js". The duplicated word is a readability defect.
    expect(source).not.toMatch(/split\s+mirrors/);
    const line = source.split('\n').find((l) => l.includes('raw-vs-processed split'));
    expect(line).toBeDefined();
    expect(line).toContain('split in vendors.js');
  });

  it('vendors.js comment block is consistently aligned', () => {
    const source = fs.readFileSync(path.join(srcDir, 'vendors.js'), 'utf8');
    const lines = source.split('\n');
    // The JSDoc continuation lines previously carried an extra leading space
    // (two spaces before "*"), misaligning the block. Every `*` line in the
    // _resolveClearableDate doc block must now have exactly one leading space.
    for (const l of lines) {
      if (l.includes('is not silently wiped') || l.includes('projects.js, and licenses.js')) {
        expect(l.startsWith(' * ')).toBe(true);
      }
    }
  });
});
