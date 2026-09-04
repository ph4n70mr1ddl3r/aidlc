const { describe, it, expect } = require('@jest/globals');
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');
const utils = require('../src/utils');
const constants = require('../src/constants');

// Regression tests for the 169th review pass. Defects closed:
// (1) views/pages/staff/index.ejs badgeClass(s.role, ROLE_BADGE) missing
//     || 'staff' fallback — nullable role could produce invalid CSS class;
// (2) views/pages/reports/staff.ejs same badgeClass gap on p.role;
// (3) src/routes/auth.js GET /profile read audit missing (all other show
//     routes audit reads; this left no trail for profile views).

function baseLocals() {
  return {
    user: { id: 1, first_name: 'Ada', last_name: 'Lovelace', role: 'admin', email: 'ada@company.com' },
    flash: { success: [], error: [], info: [] },
    currentPage: '/x',
    csrfToken: 'test-csrf-token',
    localDate: utils.localDate,
    formatDate: utils.formatDate,
    formatDateTime: utils.formatDateTime,
    daysUntil: utils.daysUntil,
    usagePercent: utils.usagePercent,
    isExpiringSoon: utils.isExpiringSoon,
    escapeHtml: utils.escapeHtml,
    isValidEmail: utils.isValidEmail,
    titleCase: utils.titleCase,
    isPrivileged: utils.isPrivileged,
    badgeClass: utils.badgeClass,
    CONDITION_BADGE: constants.CONDITION_BADGE,
    CHANGE_TYPE_BADGE: constants.CHANGE_TYPE_BADGE,
    ROLE_BADGE: constants.ROLE_BADGE,
    MEMBER_ROLE_BADGE: constants.MEMBER_ROLE_BADGE,
    KB_CATEGORY_BADGE: constants.KB_CATEGORY_BADGE,
    LICENSE_TYPE_BADGE: constants.LICENSE_TYPE_BADGE,
    CONSTANTS: constants
  };
}

function render(pageRel, locals) {
  const file = path.join(__dirname, '..', 'views', 'pages', pageRel);
  return ejs.render(fs.readFileSync(file, 'utf8'), locals, { filename: file });
}

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
    it('calls audit with action=read on successful profile view', async () => {
      // Re-mock audit to capture calls
      const auditMock = jest.fn();
      jest.doMock('../src/middleware/audit', () => ({
        audit: auditMock,
        auditMiddleware: (req, res, next) => next()
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
        const req = {
          session: { user: { id: 1, role: 'admin' } },
          flash: () => {},
          query: {}
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

        expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({
          action: 'read',
          entity: 'user',
          entityId: 1,
          details: expect.stringMatching(/profile/i)
        }));
      } finally {
        dbMock.prepare = originalPrepare;
        jest.dontMock('../src/middleware/audit');
      }
    });
  });
});
