const { describe, it, expect } = require('@jest/globals');
const { baseLocals, render } = require('./template_helpers');

// Regression tests for the 169th review pass. Defects closed:
// (1) views/pages/staff/index.ejs badgeClass(s.role, ROLE_BADGE) missing
//     || 'staff' fallback — nullable role could produce invalid CSS class;
// (2) views/pages/reports/staff.ejs same badgeClass gap on p.role;
// (3) src/routes/auth.js GET /profile read audit missing (all other show
//     routes audit reads; this left no trail for profile views).

describe('code review 169: badgeClass fallbacks + profile read audit', () => {
  describe('staff/index ejs — role badgeClass has fallback', () => {
    it('renders a valid badge class when role is null', () => {
      const locals = { ...baseLocals(), title: 'Staff', staff: [{ id: 2, first_name: 'Test', last_name: 'User', role: null, department: 'IT', is_active: true, open_tickets: 0, open_tasks: 0 }], filters: {}, page: 1, limit: 25, totalPages: 1, total: 1, baseUrl: '/staff' };
      const html = render('staff/index.ejs', locals);
      // With the fallback, null role → 'staff' → badge-medium (not badge-null).
      expect(html).toContain('badge-medium');
      expect(html).not.toContain('badge-null');
      // titleCase also gets the fallback so the display text is readable.
      expect(html).toContain('Staff');
    });

    it('renders correctly when role is a valid enum value', () => {
      const locals = { ...baseLocals(), title: 'Staff', staff: [{ id: 2, first_name: 'Admin', last_name: 'User', role: 'admin', department: 'IT', is_active: true, open_tickets: 0, open_tasks: 0 }], filters: {}, page: 1, limit: 25, totalPages: 1, total: 1, baseUrl: '/staff' };
      const html = render('staff/index.ejs', locals);
      expect(html).toContain('badge-critical');
      expect(html).toContain('Admin');
    });
  });

  describe('reports/staff ejs — role badgeClass has fallback', () => {
    it('renders a valid badge class when role is null', () => {
      const locals = { ...baseLocals(), title: 'Staff Performance', performance: [{ id: 2, name: 'Test User', role: null, open_tickets: 3, resolved_tickets: 10, avg_resolution_days: 2.5, completed_tasks: 5 }], period: 30 };
      const html = render('reports/staff.ejs', locals);
      expect(html).toContain('badge-medium');
      expect(html).not.toContain('badge-null');
      expect(html).toContain('Staff');
    });

    it('renders correctly when role is a valid enum value', () => {
      const locals = { ...baseLocals(), title: 'Staff Performance', performance: [{ id: 2, name: 'Admin User', role: 'manager', open_tickets: 3, resolved_tickets: 10, avg_resolution_days: 2.5, completed_tasks: 5 }], period: 30 };
      const html = render('reports/staff.ejs', locals);
      expect(html).toContain('badge-high');
      expect(html).toContain('Manager');
    });
  });

  describe('auth.js GET /profile audits the read action', () => {
    it('calls req.audit with action=read on successful profile view', async () => {
      // Re-mock audit middleware so req.audit is wired up for the handler.
      jest.doMock('../src/middleware/audit', () => ({
        audit: jest.fn(),
        auditMiddleware: (req, res, next) => {
          req.audit = jest.fn();
          next();
        }
      }));

      // Re-mock database so profile SELECT returns a user
      const dbMock = jest.requireMock('../src/models/database');
      const originalPrepare = dbMock.prepare;
      dbMock.prepare = jest.fn((sql) => {
        if (sql.includes('SELECT id, username') && sql.includes('WHERE id = ?')) {
          return { get: jest.fn(() => ({ id: 1, username: 'admin' })) };
        }
        return originalPrepare.call(dbMock, sql);
      });

      try {
        // Clear require cache so the fresh mocks are picked up
        delete require.cache[require.resolve('../src/routes/auth')];
        const authRouter = require('../src/routes/auth');
        const { lastHandlerFor } = require('./helpers');

        const h = lastHandlerFor(authRouter, 'get', '/profile');
        const renderedPage = {};
        const auditCalls = [];
        const req = {
          session: { user: { id: 1, role: 'admin' } },
          flash: () => {},
          query: {},
          audit: (...args) => {
            auditCalls.push(args);
          }
        };
        const res = {
          render: (template, data) => {
            Object.assign(renderedPage, data);
          },
          redirect: () => {},
          status: () => res,
          json: () => {}
        };
        await h(req, res, () => {});

        expect(auditCalls.length).toBeGreaterThan(0);
        const readCall = auditCalls.find((c) => c[0] === 'read' && c[1] === 'user');
        expect(readCall).toBeDefined();
        expect(readCall[2]).toBe(1);
        expect(readCall[3]).toBe('Viewed own profile');
      } finally {
        dbMock.prepare = originalPrepare;
        jest.dontMock('../src/middleware/audit');
      }
    });
  });
});
