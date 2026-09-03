const { describe, it, expect } = require('@jest/globals');
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');
const utils = require('../src/utils');
const constants = require('../src/constants');

// Regression tests for the 163rd review pass. Defects closed:
// (1) staff.js _staffUserStmt omitted department/phone, so a partial PUT omitting
//     them resolved against undefined and wiped the stored values (HIGH);
// (2) assets.js create silently defaulted a present non-string status/
//     condition_rating to 'in_storage'/'good' with success (MEDIUM);
// (3) changes.js update silently preserved on a present non-string status while
//     priority already failed closed (MEDIUM);
// (4) knowledge.js update wiped stored tags on a partial PUT omitting tags (MEDIUM);
// (5) tickets.js USER_INACTIVE comment-path wrote no access_denied audit entry (LOW);
// (6) flash trailing-period gaps in middleware/auth, auth login/password, and
//     staff password-reset routes (LOW);
// (7) audit/index.ejs title double-escaped via <%= escapeHtml() %> (LOW);
// (8) staff/show.ejs Active-Tasks project links ungated (LOW);
// (9) licenses/show.ejs icon-only reveal button missing aria-label (LOW);
// (10) staff/form.ejs fail-open viewerRole default (LOW).

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
  return fs.readFileSync(path.join(__dirname, '..', 'src', rel), 'utf8');
}

describe('code review 163: consistency/completeness/correctness', () => {
  describe('staff.js _staffUserStmt includes department/phone (partial-update preserve)', () => {
    it('selects department and phone for transaction-consistent resolution', () => {
      const src = readSrc('routes/staff.js');
      expect(src).toContain('SELECT id, role, username, is_active, department, phone FROM users WHERE id = ?');
    });
  });

  describe('assets.js create fail-closed non-string guards', () => {
    it('guards status and condition_rating alongside text fields', () => {
      const src = readSrc('routes/assets.js');
      expect(src).toContain("'manufacturer', 'model', 'serial_number', 'location', 'notes', 'status', 'condition_rating'");
    });
  });

  describe('changes.js update fail-closed status guard', () => {
    it('rejects present non-string status as well as priority', () => {
      const src = readSrc('routes/changes.js');
      expect(src).toContain("for (const field of ['priority', 'status'])");
    });
  });

  describe('knowledge.js update tags absent-preserve', () => {
    it('preserves stored tags when the field is absent', () => {
      const src = readSrc('routes/knowledge.js');
      expect(src).toContain('rawTagsAbsent');
      expect(src).toContain('existing.tags');
    });
  });

  describe('tickets.js USER_INACTIVE audit (defensive)', () => {
    it('audits the inactive-account comment attempt without crashing when audit is absent', () => {
      const src = readSrc('routes/tickets.js');
      expect(src).toContain('Unauthorized comment attempt on ticket (inactive account)');
      expect(src).toContain('typeof req.audit');
    });
  });

  describe('flash trailing-period consistency', () => {
    it('middleware auth denials end with periods', () => {
      const src = readSrc('middleware/auth.js');
      expect(src).toContain("req.flash('error', 'Please log in to access this page.')");
      expect(src).toContain("req.flash('error', 'You do not have permission to access this page.')");
    });

    it('auth login/password messages end with periods', () => {
      const src = readSrc('routes/auth.js');
      expect(src).toContain("req.flash('error', 'Please enter username and password.')");
      expect(src).toContain("req.flash('error', 'New password must be different from current password.')");
    });

    it('staff password-reset required message ends with a period', () => {
      const src = readSrc('routes/staff.js');
      // Note: the source escapes the apostrophe (user\'s), so assert on the
      // unescaped prefix plus the trailing-period close.
      expect(src).toContain('Your current password is required to reset another user');
      expect(src).toContain("password.');");
    });
  });

  describe('audit/index.ejs title single-escape', () => {
    it('uses <%- with escapeHtml (no double-escape) and renders safely', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'views', 'pages', 'audit', 'index.ejs'), 'utf8');
      expect(src).toContain("title=\"<%- escapeHtml(e.details || '') %>\"");
      const html = render('audit/index.ejs', {
        ...baseLocals(),
        entries: [{
          created_at: '2026-08-30 10:00:00',
          user_name: 'Test User',
          action: 'update',
          entity_type: 'ticket',
          entity_id: 42,
          ip_address: '127.0.0.1',
          details: '<img src=x onerror=alert(1)>'
        }],
        total: 1,
        filters: {},
        page: 1,
        limit: 20,
        totalPages: 1
      });
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
      expect(html).not.toContain('<img src=x onerror=alert(1)>');
      // No double-escape: the title must not contain &amp;lt;
      expect(html).not.toContain('&amp;lt;img');
    });
  });

  describe('staff/show.ejs Active-Tasks project link gating', () => {
    const tasks = [{ id: 7, title: 'Gated task', due_date: null, project_name: 'Secret Project', project_id: 9, owner_id: 99 }];

    it('privileged viewers see the project link', () => {
      const html = render('staff/show.ejs', {
        ...baseLocals(),
        user: { id: 1, first_name: 'Admin', last_name: 'User', role: 'admin', email: 'a@b.c' },
        staffUser: { id: 2, first_name: 'Staff', last_name: 'User', role: 'staff', email: 's@b.c', phone: null, department: 'IT', is_active: 1, last_login: null },
        assignedTickets: [],
        assignedTasks: tasks,
        assignedAssets: [],
        projectMemberships: []
      });
      expect(html).toContain('<a href="/projects/9"');
    });

    it('non-privileged viewers without ownership see plain text', () => {
      const html = render('staff/show.ejs', {
        ...baseLocals(),
        user: { id: 2, first_name: 'Staff', last_name: 'User', role: 'staff', email: 's@b.c' },
        staffUser: { id: 2, first_name: 'Staff', last_name: 'User', role: 'staff', email: 's@b.c', phone: null, department: 'IT', is_active: 1, last_login: null },
        assignedTickets: [],
        assignedTasks: tasks,
        assignedAssets: [],
        projectMemberships: []
      });
      expect(html).not.toContain('<a href="/projects/9"');
      expect(html).toContain('Secret Project');
    });

    it('owner sees the project link', () => {
      const html = render('staff/show.ejs', {
        ...baseLocals(),
        user: { id: 99, first_name: 'Owner', last_name: 'User', role: 'staff', email: 'o@b.c' },
        staffUser: { id: 99, first_name: 'Owner', last_name: 'User', role: 'staff', email: 'o@b.c', phone: null, department: 'IT', is_active: 1, last_login: null },
        assignedTickets: [],
        assignedTasks: tasks,
        assignedAssets: [],
        projectMemberships: []
      });
      expect(html).toContain('<a href="/projects/9"');
    });
  });

  describe('licenses/show.ejs reveal button accessibility', () => {
    it('labels the icon-only reveal button', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'views', 'pages', 'licenses', 'show.ejs'), 'utf8');
      expect(src).toContain('aria-label="Reveal license key"');
    });
  });

  describe('staff/form.ejs fail-closed viewerRole default', () => {
    it('defaults a missing viewerRole to staff-only options', () => {
      const file = path.join(__dirname, '..', 'views', 'pages', 'staff', 'form.ejs');
      const html = ejs.render(fs.readFileSync(file, 'utf8'), {
        ...baseLocals(),
        title: 'New Staff Member',
        staffMember: {},
        isEdit: false
        // viewerRole intentionally omitted — must not throw and must not offer admin/manager
      }, { filename: file });
      expect(html).not.toContain('value="admin"');
      expect(html).toContain('value="staff"');
    });
  });
});
