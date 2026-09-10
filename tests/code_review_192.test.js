const { describe, it, expect } = require('@jest/globals');
const { lastHandlerFor } = require('./helpers');

// Regression tests for review cycle 192: two consistency gaps closed on the
// 191st-pass-unified codebase — (1) the asset-report GET route was the sole
// reports sub-route missing the explicit rejectHppArrays guard on its period
// query param, and (2) GET /profile called the raw audit() helper instead of
// req.audit() used by every other read surface. Both are pinned so future
// drift cannot reintroduce them.
describe('code review 192 — reports HPP + profile audit consistency', () => {
  describe('reports/assets rejects HPP array on period query param', () => {
    it('redirects to /reports with an error flash when ?period[]=30&period[]=90', () => {
      jest.isolateModules(() => {
        const router = require('../src/routes/reports');
        const handler = lastHandlerFor(router, 'get', '/assets');
        const flashCalls = [];
        const redirectCalls = [];
        const req = {
          query: { period: ['30', '90'] },
          body: {},
          method: 'GET',
          session: { user: { id: 1, role: 'admin' } },
          flash: (type, msg) => flashCalls.push([type, msg]),
          audit: jest.fn()
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
        expect(redirectCalls).toEqual(['/reports']);
        expect(flashCalls.some(([t, m]) => t === 'error' && m === 'Invalid request parameters')).toBe(true);
      });
    });

    it('succeeds when period is a normal scalar string', () => {
      jest.isolateModules(() => {
        const router = require('../src/routes/reports');
        const handler = lastHandlerFor(router, 'get', '/assets');
        const flashCalls = [];
        const renderCalls = [];
        const req = {
          query: { period: '30' },
          body: {},
          method: 'GET',
          session: { user: { id: 1, role: 'admin' } },
          flash: (type, msg) => flashCalls.push([type, msg]),
          audit: jest.fn()
        };
        const res = {
          redirect: () => {},
          render: (...args) => {
            renderCalls.push(args);
          },
          status: () => res,
          json: () => {}
        };
        handler(req, res, () => {});
        // Normal scalar should not flash an error and should call render (not redirect).
        expect(flashCalls.some(([t]) => t === 'error')).toBe(false);
        expect(renderCalls.length).toBeGreaterThan(0);
      });
    });
  });

  describe('GET /profile uses req.audit() (consistency with all other read surfaces)', () => {
    it('calls req.audit with read/user on profile GET', () => {
      const auditMock = jest.fn();
      jest.doMock('../src/middleware/audit', () => ({
        audit: auditMock,
        auditMiddleware: (req, res, next) => {
          req.audit = jest.fn(); next();
        }
      }));

      jest.doMock('../src/models/database', () => {
        const stmt = { get: jest.fn(() => ({ id: 42, username: 'test', password: 'x', email: 't@c.com', first_name: 'T', last_name: 'C', role: 'admin', department: 'IT', phone: null, avatar: null, is_active: 1, last_login: null, password_changed_at: null, created_at: null, updated_at: null })), run: jest.fn(), all: jest.fn() };
        return { prepare: jest.fn(() => stmt), exec: jest.fn(), pragma: jest.fn(), close: jest.fn() };
      });

      try {
        delete require.cache[require.resolve('../src/routes/auth')];
        const router = require('../src/routes/auth');
        const handler = lastHandlerFor(router, 'get', '/profile');
        const auditCalls = [];
        const req = {
          query: {},
          body: {},
          method: 'GET',
          session: { user: { id: 42, role: 'admin' } },
          flash: () => {},
          audit: (...args) => {
            auditCalls.push(args);
          }
        };
        const res = {
          redirect: () => {},
          render: () => {},
          set: () => res,
          status: () => res,
          json: () => {}
        };
        handler(req, res, () => {});
        expect(auditCalls.length).toBeGreaterThan(0);
        const readCall = auditCalls.find((c) => c[0] === 'read' && c[1] === 'user');
        expect(readCall).toBeDefined();
        expect(readCall[2]).toBe(42);
        expect(readCall[3]).toBe('Viewed own profile');
      } finally {
        jest.dontMock('../src/middleware/audit');
        jest.dontMock('../src/models/database');
      }
    });
  });

  describe('source-code pin for reports/assets HPP guard', () => {
    it('reports.js source contains rejectHppArrays on the /assets route', () => {
      const fs = require('fs');
      const path = require('path');
      const src = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'routes', 'reports.js'),
        'utf8'
      );
      // The asset route must contain the same rejectHppArrays guard pattern as
      // the tickets and staff sub-routes.
      expect(src).toContain("rejectHppArrays(req, ['period'])");
    });
  });
});
