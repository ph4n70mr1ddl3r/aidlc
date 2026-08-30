const { describe, it, expect } = require('@jest/globals');
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');
const utils = require('../src/utils');
const constants = require('../src/constants');

// Regression tests for the 147th review pass. Three defects were fixed:
// (1) projects.js delete-task catch block retained "Please try again" diverging
//     from the convention established in pass 138 (delete ops use the shorter
//     "Error deleting X." form); (2) audit/index.ejs rendered raw audit details
//     in a title attribute — an XSS vector via crafted audit entries; (3)
//     vendors/index.ejs linked every row to the show route (requireAdminOrManager)
//     guaranteeing spurious access_denied audit noise on routine staff navigation.

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
    CONSTANTS: constants
  };
}

function render(pageRel, locals) {
  const file = path.join(__dirname, '..', 'views', 'pages', pageRel);
  return ejs.render(fs.readFileSync(file, 'utf8'), locals, { filename: file });
}

describe('code review 147: delete-task error message, audit XSS, vendors link gating', () => {
  describe('projects.js delete task error message (regression)', () => {
    it('delete-task catch omits "Please try again" to match the delete-convention', () => {
      // The convention established in pass 138: create/update catch blocks use
      // "Error Xing. Please try again." while delete catch blocks use
      // "Error deleting X." (shorter, no "Please try again"). The delete-task
      // path was the sole project-route outlier retaining the longer form.
      const fs_ = require('fs');
      const projectsSrc = fs_.readFileSync(
        path.join(__dirname, '..', 'src', 'routes', 'projects.js'),
        'utf8'
      );
      // Delete project and delete task must both match the short form.
      expect(projectsSrc).toContain("req.flash('error', 'Error deleting project.')");
      expect(projectsSrc).toContain("req.flash('error', 'Error deleting task.')");
      // Create and update must retain "Please try again."
      expect(projectsSrc).toContain("req.flash('error', 'Error creating project. Please try again.')");
      expect(projectsSrc).toContain("req.flash('error', 'Error updating project. Please try again.')");
    });
  });

  describe('audit/index.ejs XSS on details title attribute (regression)', () => {
    it('renders a malicious details value safely escaped in the title attribute', () => {
      // The details column's title attribute must escape HTML so a crafted
      // audit entry (e.g. details='<img src=x onerror=alert(1)>') cannot
      // inject into the rendered HTML. The fix wraps the value in escapeHtml().
      const html = render('audit/index.ejs', {
        ...baseLocals(),
        entries: [
          {
            created_at: '2026-08-30 10:00:00',
            user_name: 'Test User',
            action: 'update',
            entity_type: 'ticket',
            entity_id: 42,
            ip_address: '127.0.0.1',
            details: '<img src=x onerror=alert(1)>'
          }
        ],
        total: 1,
        filters: {},
        page: 1,
        limit: 20,
        totalPages: 1
      });
      // The escaped version must appear in the title attribute.
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
      // The raw unescaped version must NOT appear (would permit XSS).
      expect(html).not.toContain('<img src=x onerror=alert(1)>');
    });

    it('falls back to dash when details is missing', () => {
      const html = render('audit/index.ejs', {
        ...baseLocals(),
        entries: [
          {
            created_at: '2026-08-30 10:00:00',
            user_name: 'System',
            action: 'read',
            entity_type: 'audit_log',
            entity_id: null,
            ip_address: '127.0.0.1',
            details: null
          }
        ],
        total: 1,
        filters: {},
        page: 1,
        limit: 20,
        totalPages: 1
      });
      expect(html).toContain('>-</td>');
    });
  });

  describe('vendors/index.ejs access-gated links (regression)', () => {
    it('renders view links only for privileged users (admin/manager)', () => {
      // The vendors list route is requireAdminOrManager, but the template should
      // still gate its links defensively so non-privileged staff who somehow
      // reach the page (or if the route gate is relaxed in the future) do not
      // generate guaranteed access_denied audit noise on every click.
      const adminLocals = {
        ...baseLocals(),
        user: { id: 1, first_name: 'Admin', last_name: 'User', role: 'admin', email: 'admin@company.com' }
      };
      const staffLocals = {
        ...baseLocals(),
        user: { id: 2, first_name: 'Staff', last_name: 'User', role: 'staff', email: 'staff@company.com' }
      };

      const adminHtml = render('vendors/index.ejs', {
        ...adminLocals,
        vendors: [{ id: 1, name: 'Acme Corp', contact_person: 'John', email: 'john@acme.com', category: 'hardware', contract_end: null, rating: 3, is_active: true }],
        total: 1,
        filters: {},
        page: 1,
        limit: 20,
        totalPages: 1
      });
      // Admin sees clickable links.
      expect(adminHtml).toContain('<a href="/vendors/1"');
      expect(adminHtml).toContain('aria-label="View vendor"');

      const staffHtml = render('vendors/index.ejs', {
        ...staffLocals,
        vendors: [{ id: 1, name: 'Acme Corp', contact_person: 'John', email: 'john@acme.com', category: 'hardware', contract_end: null, rating: 3, is_active: true }],
        total: 1,
        filters: {},
        page: 1,
        limit: 20,
        totalPages: 1
      });
      // Staff sees plain text (no link) — the row remains visible but cannot
      // trigger a guaranteed-denial navigation.
      expect(staffHtml).not.toContain('<a href="/vendors/1"');
      expect(staffHtml).toContain('<span style="font-weight:600;">Acme Corp</span>');
      // The action cell shows a placeholder, not a broken link.
      expect(staffHtml).toContain('title="Admin/manager only"');
    });
  });
});
