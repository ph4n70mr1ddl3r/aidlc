const { describe, it, expect } = require('@jest/globals');
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');
const utils = require('../src/utils');
const constants = require('../src/constants');

// Regression tests for the 165th review pass. Defects closed:
// (1) projects.js add-task silently defaulted a present non-string status/
//     priority to 'todo'/'medium' with success (fail-open);
// (2) changes.js INVALID_DATE_FIELDS update wording omitted "Date" while create
//     uses "Invalid Scheduled Start Date" (create/update mismatch);
// (3) tickets.js quick-status rejected padded status while full update trims;
// (4) licenses.js "Invalid license key" casing outlier vs Title-Case convention;
// (5) assets.js asset-tag format message trailing-period outlier;
// (6) staff.js reactivate NOT_FOUND redirected to non-existent detail page;
// (7) projects/show.ejs quick-status select missing accessible name;
// (8) vendors/index.ejs rating stars missing role/img + aria-hidden;
// (9) tickets/show.ejs satisfaction stars missing aria-hidden + role/img;
// (10) templates.test.js recentTickets fixture omitted assigned_to gating column.

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

function readSrc(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

describe('code review 165: consistency/completeness/correctness', () => {
  describe('projects.js add-task fail-closed non-string guard', () => {
    it('guards status and priority alongside description', () => {
      const src = readSrc('src/routes/projects.js');
      expect(src).toContain("for (const field of ['description', 'status', 'priority'])");
    });
  });

  describe('changes.js INVALID_DATE_FIELDS Date suffix', () => {
    it('uses Date-suffixed labels matching the create route', () => {
      const src = readSrc('src/routes/changes.js');
      expect(src).toContain("'Scheduled Start Date'");
      expect(src).toContain("'Scheduled End Date'");
      expect(src).toContain("'Actual Start Date'");
      expect(src).toContain("'Actual End Date'");
    });
  });

  describe('tickets.js quick-status trims before enum check', () => {
    it('trims the submitted status like the full update route', () => {
      const src = readSrc('src/routes/tickets.js');
      expect(src).toContain('const status = trim(safeQueryValue(req.body.status));');
    });
  });

  describe('licenses.js Invalid License Key casing', () => {
    it('uses Title-Case like every other Invalid X message', () => {
      const src = readSrc('src/routes/licenses.js');
      expect(src).toContain("req.flash('error', 'Invalid License Key')");
      expect(src).not.toContain("req.flash('error', 'Invalid license key')");
    });
  });

  describe('assets.js asset-tag format message period', () => {
    it('omits the trailing period like sibling validation labels', () => {
      const src = readSrc('src/routes/assets.js');
      expect(src).toContain('Asset tag must match format AST-XXX (e.g. AST-001)');
      expect(src).not.toContain('AST-001).');
    });
  });

  describe('staff.js reactivate NOT_FOUND redirects to list', () => {
    it('redirects a missing reactivate target to /staff, not the detail page', () => {
      const src = readSrc('src/routes/staff.js');
      // The notFound branch of the reactivate route must go to the list;
      // the alreadyActive branch still goes to the detail page (it exists).
      const reactivateIdx = src.indexOf("router.put('/:id/reactivate'");
      expect(reactivateIdx).toBeGreaterThan(-1);
      const block = src.slice(reactivateIdx, reactivateIdx + 1200);
      expect(block).toContain("return res.redirect('/staff');");
    });
  });

  describe('projects/show.ejs quick-status select accessible name', () => {
    it('carries an aria-label', () => {
      const src = readSrc('views/pages/projects/show.ejs');
      expect(src).toContain('aria-label="Task status for');
    });

    it('renders without error', () => {
      const html = render('projects/show.ejs', {
        ...baseLocals(),
        project: { id: 1, name: 'P', description: '', status: 'in_progress', priority: 'high', start_date: null, end_date: null, budget: 0, spent: 0, progress: 50, owner_id: 1, created_at: '2026-01-01', updated_at: '2026-01-02' },
        tasks: [{ id: 1, title: 'T1', status: 'todo', priority: 'high', due_date: null, assigned_name: 'Ada' }],
        members: [],
        staff: []
      });
      expect(html).toContain('aria-label="Task status for T1"');
    });
  });

  describe('vendors/index.ejs rating a11y', () => {
    it('wraps stars with role=img and hides icons from AT', () => {
      const src = readSrc('views/pages/vendors/index.ejs');
      expect(src).toContain('role="img"');
      expect(src).toContain('out of 5 stars');
      expect(src).toContain('aria-hidden="true"');
    });
  });

  describe('tickets/show.ejs satisfaction stars a11y', () => {
    it('hides star icons from AT behind a labelled wrapper', () => {
      const src = readSrc('views/pages/tickets/show.ejs');
      expect(src).toContain('aria-label="<%= ticket.satisfaction_rating %> out of 5 stars"');
      expect(src).toContain('aria-hidden="true"');
    });
  });

  describe('dashboard recentTickets fixture gating column', () => {
    it('templates.test.js fixture includes assigned_to', () => {
      const src = readSrc('tests/templates.test.js');
      expect(src).toContain('TK-DASH-RECENT');
      expect(src).toMatch(/TK-DASH-RECENT[\s\S]*?assigned_to/);
    });
  });
});
