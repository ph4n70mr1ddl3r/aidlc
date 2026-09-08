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
    CONSTANTS: constants
  };
}

function render(pageRel, locals) {
  const file = path.join(__dirname, '..', 'views', 'pages', pageRel);
  return ejs.render(fs.readFileSync(file, 'utf8'), locals, { filename: file });
}

describe('code review 181', () => {
  describe('knowledge/show.ejs — nullable author_name fallback', () => {
    it('renders dash when article.author_name is null', () => {
      const locals = {
        ...baseLocals(),
        title: 'Article',
        article: { id: 1, title: 'Test', category: 'how_to', status: 'published', views: 5, is_featured: 0, updated_at: '2024-01-01 10:00', author_name: null, tags: null, renderedContent: '<p>content</p>' }
      };
      const html = render('knowledge/show.ejs', locals);
      expect(html).toContain('>By <strong>-</strong></span>');
      expect(html).not.toContain('>By <strong></strong></span>');
    });
  });

  describe('vendors/show.ejs — contract date fallback uses dash', () => {
    it('renders dash for missing contract dates, not question mark', () => {
      const locals = {
        ...baseLocals(),
        title: 'Vendor',
        vendor: { id: 1, name: 'Acme', contact_person: null, email: null, phone: null, address: null, website: null, category: null, contract_start: null, contract_end: null, notes: null, rating: null, is_active: true, created_at: null, updated_at: null }
      };
      const html = render('vendors/show.ejs', locals);
      // Verify the rendered contract row uses '-' not '?'
      expect(html).toContain('>Contract</div><div class="detail-value">- — -</div>');
      // Confirm no '?' appears in the contract row context
      const contractMatch = html.match(/Contract.*?<\/div>/s);
      expect(contractMatch).toBeTruthy();
      expect(contractMatch[0]).not.toContain('?');
    });
  });

  describe('projects/index.ejs — project date fallback uses dash', () => {
    it('renders dash for missing project dates, not question mark', () => {
      const locals = {
        ...baseLocals(),
        title: 'Projects',
        projects: [{ id: 1, name: 'Test Project', description: 'Desc', status: 'planning', priority: 'medium', start_date: null, end_date: null, budget: 0, spent: 0, progress: 0, owner_id: 1, owner_name: 'Ada', created_at: null, updated_at: null, task_count: 0, done_count: 0 }],
        total: 1,
        filters: {},
        page: 1,
        limit: 25,
        totalPages: 1
      };
      const html = render('projects/index.ejs', locals);
      // Verify the rendered output uses '-' not '?' for missing dates
      expect(html).not.toMatch(/— \?/);
      // When both dates are null, the conditional block should not render at all
      // (the template uses `if (p.start_date || p.end_date)`)
      expect(html).not.toContain('calendar');
    });

    it('renders dash for partially missing project dates', () => {
      const locals = {
        ...baseLocals(),
        title: 'Projects',
        projects: [{ id: 1, name: 'Test Project', description: 'Desc', status: 'planning', priority: 'medium', start_date: '2024-01-01', end_date: null, budget: 0, spent: 0, progress: 0, owner_id: 1, owner_name: 'Ada', created_at: null, updated_at: null, task_count: 0, done_count: 0 }],
        total: 1,
        filters: {},
        page: 1,
        limit: 25,
        totalPages: 1
      };
      const html = render('projects/index.ejs', locals);
      // Should render the start date but use '-' for missing end date
      expect(html).toMatch(/2024.*?— .*?-/);
      // The '?' pattern should not appear in the date line
      const dateLineMatch = html.match(/calendar.*?—.*?<\/div>/s);
      expect(dateLineMatch).toBeTruthy();
      expect(dateLineMatch[0]).not.toContain('?');
    });
  });

  describe('reports.js — reportLimiter guards req.flash', () => {
    it('source contains req.flash guard on rate limit handler', async () => {
      jest.resetModules();
      jest.mock('../src/middleware/auth', () => ({
        requireAuth: (req, res, next) => next(),
        requireAdminOrManager: (req, res, next) => next()
      }));
      jest.mock('../src/middleware/audit', () => ({
        auditMiddleware: (req, res, next) => {
          req.audit = jest.fn(); next();
        }
      }));
      // Verify the source code contains the req.flash guard
      // (mirrors the dashboard limiter pattern at dashboard.js:22)
      const reportsSrc = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'routes', 'reports.js'),
        'utf8'
      );
      expect(reportsSrc).toContain("typeof req.flash === 'function'");
    });
  });
});
