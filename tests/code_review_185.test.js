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

describe('code review 185 — staff/show.ejs role-gate consistency', () => {
  it('render: null user.role hides edit button and admin actions', () => {
    const locals = {
      ...baseLocals(),
      title: 'Staff',
      user: { id: 1, first_name: 'Ada', last_name: 'Lovelace', role: null, email: 'ada@company.com' },
      staffUser: { id: 2, first_name: 'Bob', last_name: 'Smith', role: 'staff', department: 'IT', phone: null, email: 'bob@co.com', is_active: 1, last_login: null },
      assignedTickets: [],
      assignedTasks: [],
      assignedAssets: [],
      projectMemberships: []
    };
    const html = render('staff/show.ejs', locals);
    // Edit button should be hidden when role is null (isPrivileged returns false)
    expect(html).not.toContain('Edit</a>');
    // Admin actions should be hidden when role is null
    expect(html).not.toContain('Admin Actions');
  });

  it('render: manager user.role can edit staff but not other managers', () => {
    const locals = {
      ...baseLocals(),
      title: 'Staff',
      user: { id: 1, first_name: 'Ada', last_name: 'Lovelace', role: 'manager', email: 'ada@company.com' },
      staffUser: { id: 2, first_name: 'Bob', last_name: 'Smith', role: 'staff', department: 'IT', phone: null, email: 'bob@co.com', is_active: 1, last_login: null },
      assignedTickets: [],
      assignedTasks: [],
      assignedAssets: [],
      projectMemberships: []
    };
    const html = render('staff/show.ejs', locals);
    // Manager editing a staff member should see edit button
    expect(html).toContain('Edit</a>');
    // But not admin actions
    expect(html).not.toContain('Admin Actions');
  });

  it('render: manager user.role cannot edit another manager', () => {
    const locals = {
      ...baseLocals(),
      title: 'Staff',
      user: { id: 1, first_name: 'Ada', last_name: 'Lovelace', role: 'manager', email: 'ada@company.com' },
      staffUser: { id: 2, first_name: 'Bob', last_name: 'Smith', role: 'manager', department: 'IT', phone: null, email: 'bob@co.com', is_active: 1, last_login: null },
      assignedTickets: [],
      assignedTasks: [],
      assignedAssets: [],
      projectMemberships: []
    };
    const html = render('staff/show.ejs', locals);
    // Manager editing another manager should NOT see edit button
    expect(html).not.toContain('Edit</a>');
  });

  it('source uses isPrivileged(user) for role-gate consistency', () => {
    const file = path.join(__dirname, '..', 'views', 'pages', 'staff', 'show.ejs');
    const src = fs.readFileSync(file, 'utf8');
    // Both role gates should use isPrivileged rather than direct role comparison
    expect(src).toContain("isPrivileged(user) && (user.role === 'admin' || staffUser.role === 'staff')");
    expect(src).toContain("isPrivileged(user) && user.role === 'admin' && Number(staffUser.id) !== Number(user.id)");
  });
});
