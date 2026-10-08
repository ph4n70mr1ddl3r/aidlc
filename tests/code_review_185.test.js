const { describe, it, expect } = require('@jest/globals');
const fs = require('fs');
const path = require('path');
const { baseLocals, render } = require('./template_helpers');

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
