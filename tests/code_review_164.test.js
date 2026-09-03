const { describe, it, expect } = require('@jest/globals');
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');
const utils = require('../src/utils');
const constants = require('../src/constants');

// Regression tests for the 164th review pass. Defects closed:
// (1) reports/assets.ejs warranty null-guard (daysUntil null rendered critical + "null days");
// (2) reports/assets.ejs condition severity collapsed fair/medium + poor/broken/critical to orange;
// (3) staff/show.ejs member-role badge missing || 'member' fallback (badge-null);
// (4) vendors/show.ejs missing empty-star loop (scale ambiguity vs index);
// (5) projects/show.ejs add-task/add-member inputs + add-member button missing a11y names;
// (6) auth/profile.ejs disabled inputs missing label association;
// (7) vendors/form.ejs invalid <label>Status</label> on static badge;
// (8) decorative icons missing aria-hidden (licenses/show, projects/show, tickets/show, nav, pagination);
// (9) knowledge.js resolveSafeFeatured null cleared featured instead of preserving;
// (10) projects.js update "Invalid Amount Spent" vs create "Invalid Spent Amount";
// (11) projects.js task status/priority + member role missing trim consistency;
// (12) staff.js three privileged-escalation outer guards wrote no access_denied audit;
// (13) dashboard.test.js assetStats missing reserved; templates.test.js missing
//      uncapped counts + owner_id gating columns.

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

describe('code review 164: consistency/completeness/correctness', () => {
  describe('reports/assets.ejs warranty null-guard', () => {
    it('renders "-" for unparseable warranty_expiry instead of "null days"', () => {
      const html = render('reports/assets.ejs', {
        ...baseLocals(),
        byCategory: [],
        byStatus: [],
        byCondition: [],
        totalValue: { total: 0 },
        warrantyCount: 1,
        warrantyExpiring: [{ asset_tag: 'AST-999', name: 'Bad Date Box', warranty_expiry: 'not-a-date' }],
        ageDistribution: []
      });
      expect(html).not.toContain('null days');
      expect(html).not.toContain('badge-critical">Expired');
    });

    it('guards daysUntil null in source', () => {
      const src = readSrc('views/pages/reports/assets.ejs');
      expect(src).toContain('days === null');
    });
  });

  describe('reports/assets.ejs condition severity colors', () => {
    it('maps low->green, medium->orange, critical->red', () => {
      const src = readSrc('views/pages/reports/assets.ejs');
      expect(src).toContain("=== 'medium' ? 'orange' : 'red'");
    });

    it('renders red for poor/broken conditions', () => {
      const html = render('reports/assets.ejs', {
        ...baseLocals(),
        byCategory: [],
        byStatus: [],
        byCondition: [{ condition_rating: 'poor', count: 2 }],
        totalValue: { total: 0 },
        warrantyCount: 0,
        warrantyExpiring: [],
        ageDistribution: []
      });
      expect(html).toContain('progress-fill red');
    });
  });

  describe('staff/show.ejs member-role badge fallback', () => {
    it('falls back to member for null role (no badge-null)', () => {
      const src = readSrc('views/pages/staff/show.ejs');
      expect(src).toContain("badgeClass(pm.project_role || 'member'");
      const html = render('staff/show.ejs', {
        ...baseLocals(),
        staffUser: { id: 2, first_name: 'Maya', last_name: 'Patel', role: 'staff', email: 'm@b.c', phone: null, department: 'IT', is_active: 1, last_login: null },
        assignedTickets: [],
        assignedTasks: [],
        assignedAssets: [],
        projectMemberships: [{ project_id: 1, project_name: 'Cloud', project_status: 'in_progress', project_role: null, owner_id: 1 }]
      });
      expect(html).not.toContain('badge-null');
      expect(html).toContain('badge-medium');
    });
  });

  describe('vendors/show.ejs empty-star loop', () => {
    it('renders empty stars to complete the 5-scale', () => {
      const html = render('vendors/show.ejs', {
        ...baseLocals(),
        vendor: { id: 1, name: 'Dell', contact_person: null, email: null, phone: null, address: null, website: null, category: null, contract_start: null, contract_end: null, rating: 3, is_active: 1, notes: null }
      });
      const filled = (html.match(/fas fa-star/g) || []).length;
      const empty = (html.match(/far fa-star/g) || []).length;
      expect(filled).toBe(3);
      expect(empty).toBe(2);
    });
  });

  describe('projects/show.ejs form accessibility', () => {
    it('labels add-task inputs and add-member controls', () => {
      const src = readSrc('views/pages/projects/show.ejs');
      expect(src).toContain('aria-label="New task title"');
      expect(src).toContain('aria-label="Task priority"');
      expect(src).toContain('aria-label="Task assignee"');
      expect(src).toContain('aria-label="Member user"');
      expect(src).toContain('aria-label="Member role"');
      expect(src).toContain('aria-label="Add member"');
    });
  });

  describe('auth/profile.ejs label association', () => {
    it('associates username/role labels with inputs', () => {
      const src = readSrc('views/pages/auth/profile.ejs');
      expect(src).toContain('for="username_display"');
      expect(src).toContain('id="username_display"');
      expect(src).toContain('for="role_display"');
      expect(src).toContain('id="role_display"');
    });
  });

  describe('vendors/form.ejs status badge markup', () => {
    it('does not use <label> for static status text', () => {
      const src = readSrc('views/pages/vendors/form.ejs');
      expect(src).not.toContain('<label>Status</label>');
    });
  });

  describe('decorative icons hidden from assistive tech', () => {
    it('hides icons inside labelled controls', () => {
      expect(readSrc('views/pages/licenses/show.ejs')).toContain('fa-eye" aria-hidden="true"');
      expect(readSrc('views/pages/tickets/show.ejs')).toContain('fa-star" aria-hidden="true"');
      expect(readSrc('views/partials/nav.ejs')).toContain('fa-bars" aria-hidden="true"');
      expect(readSrc('views/partials/nav.ejs')).toContain('fa-bell" aria-hidden="true"');
      expect(readSrc('views/partials/nav.ejs')).toContain('fa-sign-out-alt" aria-hidden="true"');
      expect(readSrc('views/partials/pagination.ejs')).toContain('fa-chevron-left" aria-hidden="true"');
      expect(readSrc('views/partials/pagination.ejs')).toContain('fa-chevron-right" aria-hidden="true"');
    });
  });

  describe('knowledge.js resolveSafeFeatured null preserve', () => {
    it('treats null as absent (preserves stored value)', () => {
      const { resolveSafeFeatured } = require('../src/routes/knowledge');
      const admin = { id: 1, role: 'admin' };
      expect(resolveSafeFeatured(admin, null, 1)).toBe(1);
      expect(resolveSafeFeatured(admin, undefined, 1)).toBe(1);
      expect(resolveSafeFeatured(admin, '', 1)).toBe(1);
      expect(resolveSafeFeatured(admin, '0', 1)).toBe(0);
    });
  });

  describe('projects.js spent flash wording', () => {
    it('uses "Invalid Spent Amount" on update like create', () => {
      const src = readSrc('src/routes/projects.js');
      expect(src).toContain("flash: 'Invalid Spent Amount'");
      expect(src).not.toContain('Invalid Amount Spent');
    });
  });

  describe('projects.js trim consistency on task/member enums', () => {
    it('trims task status/priority and member role before validation', () => {
      const src = readSrc('src/routes/projects.js');
      expect(src).toContain('const status = trim(safeQueryValue(req.body.status));');
      expect(src).toContain('const priority = trim(safeQueryValue(req.body.priority));');
      expect(src).toContain('const role = trim(safeQueryValue(req.body.role));');
    });
  });

  describe('staff.js privileged-escalation audit completeness', () => {
    it('audits outer privileged-account guards', () => {
      const src = readSrc('src/routes/staff.js');
      expect(src).toContain('Unauthorized privileged account creation attempt');
      expect(src).toContain('Unauthorized privileged role assignment attempt');
      expect(src).toContain("req.audit('access_denied', 'user', id, 'Unauthorized administrator or manager account modification attempt');");
    });
  });
});
