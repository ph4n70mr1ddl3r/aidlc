const { describe, it, expect } = require('@jest/globals');
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');
const utils = require('../src/utils');
const constants = require('../src/constants');

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
    TICKET_STATUS_BADGE: constants.TICKET_STATUS_BADGE,
    TICKET_PRIORITY_BADGE: constants.TICKET_PRIORITY_BADGE,
    ASSET_STATUS_BADGE: constants.ASSET_STATUS_BADGE,
    PROJECT_STATUS_BADGE: constants.PROJECT_STATUS_BADGE,
    PROJECT_PRIORITY_BADGE: constants.PROJECT_PRIORITY_BADGE,
    TASK_PRIORITY_BADGE: constants.TASK_PRIORITY_BADGE,
    CHANGE_STATUS_BADGE: constants.CHANGE_STATUS_BADGE,
    CHANGE_PRIORITY_BADGE: constants.CHANGE_PRIORITY_BADGE,
    KB_STATUS_BADGE: constants.KB_STATUS_BADGE,
    VENDOR_CATEGORY_BADGE: constants.VENDOR_CATEGORY_BADGE,
    CONSTANTS: constants
  };
}

function render(pageRel, locals) {
  const file = path.join(__dirname, '..', 'views', 'pages', pageRel);
  return ejs.render(fs.readFileSync(file, 'utf8'), locals, { filename: file });
}

describe('code review 182', () => {
  describe('reports/tickets.ejs — aria-label fallbacks for nullable enum fields', () => {
    it('category aria-label includes || \'other\' fallback so null renders a valid label', () => {
      const locals = {
        ...baseLocals(),
        title: 'Ticket Analytics',
        period: 30,
        ticketsByDay: [],
        byCategory: [{ category: null, count: 3 }],
        byPriority: [],
        avgResolution: { avg_days: null },
        slaStats: { total_resolved: 0, within_1d: 0, within_3d: 0, within_7d: 0 },
        topResolvers: []
      };
      const html = render('reports/tickets.ejs', locals);
      // The aria-label must use the fallback so it reads "Other: 3 tickets" not "null: 3 tickets"
      expect(html).toContain('aria-label="Other: 3 tickets"');
      expect(html).not.toContain('aria-label="null:');
    });

    it('priority aria-label includes || \'medium\' fallback so null renders a valid label', () => {
      const locals = {
        ...baseLocals(),
        title: 'Ticket Analytics',
        period: 30,
        ticketsByDay: [],
        byCategory: [],
        byPriority: [{ priority: null, count: 5 }],
        avgResolution: { avg_days: null },
        slaStats: { total_resolved: 0, within_1d: 0, within_3d: 0, within_7d: 0 },
        topResolvers: []
      };
      const html = render('reports/tickets.ejs', locals);
      expect(html).toContain('aria-label="Medium: 5 tickets"');
      expect(html).not.toContain('aria-label="null:');
    });
  });

  describe('reports/assets.ejs — aria-label fallbacks for nullable enum fields', () => {
    it('category aria-label includes || \'other\' fallback so null renders a valid label', () => {
      const locals = {
        ...baseLocals(),
        title: 'Asset Report',
        byCategory: [{ category: null, count: 2 }],
        byStatus: [],
        byCondition: [],
        totalValue: { total: 0 },
        warrantyCount: 0,
        warrantyExpiring: [],
        ageDistribution: []
      };
      const html = render('reports/assets.ejs', locals);
      expect(html).toContain('aria-label="Other: 2 assets"');
      expect(html).not.toContain('aria-label="null:');
    });

    it('status aria-label includes || \'in_storage\' fallback so null renders a valid label', () => {
      const locals = {
        ...baseLocals(),
        title: 'Asset Report',
        byCategory: [],
        byStatus: [{ status: null, count: 4 }],
        byCondition: [],
        totalValue: { total: 0 },
        warrantyCount: 0,
        warrantyExpiring: [],
        ageDistribution: []
      };
      const html = render('reports/assets.ejs', locals);
      expect(html).toContain('aria-label="In Storage: 4 assets"');
      expect(html).not.toContain('aria-label="null:');
    });
  });

  describe('nav.ejs — titleCase(user.role) nullable fallback', () => {
    it('renders staff role display when user.role is null', () => {
      const locals = {
        ...baseLocals(),
        title: 'Dashboard',
        user: { id: 1, first_name: 'Ada', last_name: 'Lovelace', role: null, email: 'ada@company.com' },
        flash: { success: [], error: [], info: [] },
        currentPage: '/dashboard',
        csrfToken: 'test-csrf-token',
        isPrivileged: utils.isPrivileged
      };
      const navFile = path.join(__dirname, '..', 'views', 'partials', 'nav.ejs');
      const html = ejs.render(fs.readFileSync(navFile, 'utf8'), locals, { filename: navFile });
      expect(html).toContain('>Staff</div>');
      expect(html).not.toContain('>null</div>');
    });
  });

  describe('source-code assertions for fallback consistency', () => {
    it('reports/tickets.ejs source contains || \'other\' in category aria-label', () => {
      const file = path.join(__dirname, '..', 'views', 'pages', 'reports', 'tickets.ejs');
      const src = fs.readFileSync(file, 'utf8');
      expect(src).toContain("titleCase(c.category || 'other')");
    });

    it('reports/tickets.ejs source contains || \'medium\' in priority aria-label', () => {
      const file = path.join(__dirname, '..', 'views', 'pages', 'reports', 'tickets.ejs');
      const src = fs.readFileSync(file, 'utf8');
      expect(src).toContain("titleCase(p.priority || 'medium')");
    });

    it('reports/assets.ejs source contains || \'other\' in category aria-label', () => {
      const file = path.join(__dirname, '..', 'views', 'pages', 'reports', 'assets.ejs');
      const src = fs.readFileSync(file, 'utf8');
      expect(src).toContain("titleCase(c.category || 'other')");
    });

    it('reports/assets.ejs source contains || \'in_storage\' in status aria-label', () => {
      const file = path.join(__dirname, '..', 'views', 'pages', 'reports', 'assets.ejs');
      const src = fs.readFileSync(file, 'utf8');
      expect(src).toContain("titleCase(s.status || 'in_storage')");
    });

    it('nav.ejs source contains || \'staff\' in titleCase(user.role)', () => {
      const file = path.join(__dirname, '..', 'views', 'partials', 'nav.ejs');
      const src = fs.readFileSync(file, 'utf8');
      expect(src).toContain("titleCase(user.role || 'staff')");
    });
  });
});
