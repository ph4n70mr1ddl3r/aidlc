const { describe, it, expect } = require('@jest/globals');
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');
const utils = require('../src/utils');
const constants = require('../src/constants');

// Regression tests for Number() coercion on template-level ownership checks.
// The codebase convention (established in staff.js, knowledge.js routes, and
// auth.js canAccessResource) is to use Number(...) === Number(...) when comparing
// a resource id against the session user id, because safeId() returns a number
// but template locals could theoretically receive string ids from a future caller
// or a mock. These tests pin the convention so a future refactor cannot silently
// drop the coercion in templates.

function baseLocals(user) {
  return {
    user: user || { id: 1, first_name: 'Ada', last_name: 'Lovelace', role: 'admin', email: 'ada@company.com', department: 'IT' },
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

describe('tickets/show — Number() coercion on assigned_to / user.id comparison', () => {
  const ticket = {
    id: 1, ticket_number: 'TK-2026-0001', title: 'Test ticket', category: 'hardware',
    priority: 'high', status: 'open', requester_name: 'Bob', requester_email: 'bob@x.com',
    requester_department: 'IT', requester_phone: '555-0101', assigned_to: '2',
    assigned_name: 'Maya Patel', due_date: null, asset_name: null, asset_tag: null,
    created_at: '2026-01-01 09:00', updated_at: '2026-01-01 09:00', resolved_at: null,
    satisfaction_rating: 0, resolution_notes: null
  };
  const comments = [];

  it('shows edit and status-change buttons when assigned_to is a string matching the user id', () => {
    // assigned_to is a string '2' and user.id is the number 2 — Number()
    // coercion must unify them so the non-privileged assignee sees their controls.
    const html = render('tickets/show.ejs', {
      ...baseLocals({ id: 2, first_name: 'Maya', last_name: 'Patel', role: 'staff', email: 'm@x.com', department: 'IT' }),
      title: ticket.ticket_number, ticket, comments
    });
    expect(html).toContain('href="/tickets/1/edit"');
    expect(html).toContain('Quick Status:');
  });

  it('hides edit and status-change buttons when assigned_to differs from user id (even after coercion)', () => {
    const html = render('tickets/show.ejs', {
      ...baseLocals({ id: 99, first_name: 'Other', last_name: 'User', role: 'staff', email: 'o@x.com', department: 'IT' }),
      title: ticket.ticket_number, ticket, comments
    });
    expect(html).not.toContain('href="/tickets/1/edit"');
    expect(html).not.toContain('Quick Status:');
  });
});

describe('knowledge/show — Number() coercion on author_id / user.id comparison', () => {
  const article = {
    id: 1, title: 'VPN Guide', status: 'published', category: 'how_to',
    tags: 'vpn', author_id: '3', author_name: 'Tom User', views: 5,
    updated_at: '2026-01-01 10:00', renderedContent: '<p>Content</p>'
  };

  it('shows edit and delete buttons when author_id is a string matching the user id', () => {
    // author_id is a string '3' and user.id is the number 3 — Number()
    // coercion must unify them so the article author sees their controls.
    const html = render('knowledge/show.ejs', {
      ...baseLocals({ id: 3, first_name: 'Tom', last_name: 'User', role: 'staff', email: 't@x.com', department: 'IT' }),
      title: article.title, article, markedFallback: false
    });
    expect(html).toContain('href="/knowledge/1/edit"');
    expect(html).toContain('Delete');
  });

  it('hides edit and delete buttons when author_id differs from user id (even after coercion)', () => {
    const html = render('knowledge/show.ejs', {
      ...baseLocals({ id: 99, first_name: 'Other', last_name: 'User', role: 'staff', email: 'o@x.com', department: 'IT' }),
      title: article.title, article, markedFallback: false
    });
    expect(html).not.toContain('href="/knowledge/1/edit"');
    expect(html).not.toContain('Delete');
  });

  it('shows edit and delete buttons for privileged users regardless of authorship', () => {
    const html = render('knowledge/show.ejs', {
      ...baseLocals({ id: 1, first_name: 'Admin', last_name: 'User', role: 'admin', email: 'a@x.com', department: 'IT' }),
      title: article.title, article, markedFallback: false
    });
    expect(html).toContain('href="/knowledge/1/edit"');
    expect(html).toContain('Delete');
  });
});
