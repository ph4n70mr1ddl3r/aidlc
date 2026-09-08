const { describe, it, expect } = require('@jest/globals');
const utils = require('../src/utils');

// Regression tests for review cycle 183: explicit rejectHppArrays guards on
// all list GET routes. Previously only GET /audit rejected array-valued query
// params on list routes; the other eight (assets, tickets, projects, staff,
// vendors, knowledge, changes, licenses) silently collapsed arrays to their
// first element via safeQueryValue. Each route now fails closed.
describe('code review 183 — list-route HPP guards', () => {
  describe('rejectHppArrays on list routes', () => {
    const routeModules = {
      assets: '../src/routes/assets',
      tickets: '../src/routes/tickets',
      projects: '../src/routes/projects',
      staff: '../src/routes/staff',
      vendors: '../src/routes/vendors',
      knowledge: '../src/routes/knowledge',
      changes: '../src/routes/changes',
      licenses: '../src/routes/licenses',
      audit: '../src/routes/audit'
    };

    for (const [name, modPath] of Object.entries(routeModules)) {
      it(`${name} GET / rejects array query params`, () => {
        jest.isolateModules(() => {
          const router = require(modPath);
          const layer = router.stack.find(l => l.route && l.route.methods.get && l.route.path === '/');
          expect(layer).toBeDefined();
          const handler = layer.route.stack[layer.route.stack.length - 1].handle;
          const flashCalls = [];
          const req = {
            query: { search: ['a', 'b'], sort: ['name', 'date'] },
            body: {},
            session: { user: { id: 1, role: 'admin' } },
            flash: (type, msg) => flashCalls.push([type, msg]),
            audit: jest.fn()
          };
          const res = { redirect: jest.fn(), render: jest.fn() };
          handler(req, res, () => {});
          expect(res.redirect).toHaveBeenCalledWith(expect.stringMatching(/^\//));
          expect(flashCalls.find(([t]) => t === 'error')).toEqual(['error', 'Invalid request parameters']);
        });
      });
    }
  });

  describe('badgeClass fallback for unmapped values', () => {
    it('returns "medium" when value is not in the mapping', () => {
      expect(utils.badgeClass('unknown_value', { active: 'success' })).toBe('medium');
    });

    it('returns "medium" when mapping is null', () => {
      expect(utils.badgeClass('anything', null)).toBe('medium');
    });

    it('returns "medium" when mapping is undefined', () => {
      expect(utils.badgeClass('anything', undefined)).toBe('medium');
    });

    it('returns mapped value when present', () => {
      expect(utils.badgeClass('active', { active: 'success' })).toBe('success');
    });
  });

  describe('tickets/new prefill guards against missing session user', () => {
    it('renders without throwing when req.session.user is missing', () => {
      jest.isolateModules(() => {
        jest.mock('../src/models/database', () => {
          const stmt = { get: jest.fn(() => null), all: jest.fn(() => []), run: jest.fn(() => ({ changes: 1, lastInsertRowid: 1 })) };
          return { prepare: jest.fn(() => stmt), exec: jest.fn(), pragma: jest.fn(), transaction: jest.fn((fn) => fn()), close: jest.fn() };
        });
        const router = require('../src/routes/tickets');
        const layer = router.stack.find(l => l.route && l.route.methods.get && l.route.path === '/new');
        expect(layer).toBeDefined();
        const handler = layer.route.stack[layer.route.stack.length - 1].handle;
        const req = { session: {} };
        const res = { render: jest.fn() };
        // Should not throw — the route guards against missing session.user
        expect(() => handler(req, res, () => {})).not.toThrow();
        expect(res.render).toHaveBeenCalled();
      });
    });
  });
});
