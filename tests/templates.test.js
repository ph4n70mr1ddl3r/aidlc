const { describe, it, expect } = require('@jest/globals');
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');
const utils = require('../src/utils');
const constants = require('../src/constants');

// Regression test for a class of bug that has bitten this codebase before:
// helpers used inside EJS templates must be wired into res.locals in app.js,
// otherwise the template throws a ReferenceError at render time.
//
// Previously daysUntil / usagePercent / isExpiringSoon were called from
// templates but never exposed, which crashed /licenses, /assets/:id, and
// /projects/:id for any row with a populated date.

/**
 * Reproduce the exact res.locals surface that app.js injects into every
 * rendered template. If a helper is added to a template, it must be added
 * here (and to app.js) — otherwise this suite will fail.
 */
function baseLocals() {
  const user = { id: 1, first_name: 'Ada', last_name: 'Lovelace', role: 'admin', email: 'ada@company.com', department: 'IT' };
  return {
    user,
    flash: { success: [], error: [], info: [] },
    currentPage: '/x',
    csrfToken: 'test-csrf-token',
    localDate: utils.localDate,
    formatDate: utils.formatDate,
    formatDateTime: utils.formatDateTime,
    daysUntil: utils.daysUntil,
    usagePercent: utils.usagePercent,
    isExpiringSoon: utils.isExpiringSoon,
    titleCase: utils.titleCase,
    isPrivileged: utils.isPrivileged,
    badgeClass: utils.badgeClass,
    CONDITION_BADGE: utils.CONDITION_BADGE,
    CHANGE_TYPE_BADGE: utils.CHANGE_TYPE_BADGE,
    ROLE_BADGE: utils.ROLE_BADGE,
    CONSTANTS: constants
  };
}

function render(pageRel, locals) {
  const file = path.join(__dirname, '..', 'views', 'pages', pageRel);
  return ejs.render(fs.readFileSync(file, 'utf8'), locals, { filename: file });
}

describe('res.locals wiring guards', () => {
  it('app.js exposes every template helper used by views into res.locals', () => {
    // Static guarantee: the helpers consumed by templates are present on the
    // utils module AND assigned to res.locals in app.js.
    const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
    for (const name of ['daysUntil', 'usagePercent', 'isExpiringSoon']) {
      expect(typeof utils[name]).toBe('function');
      expect(appSrc).toContain(`res.locals.${name} = utilsModule.${name}`);
    }
  });
});

describe('templates render without ReferenceError', () => {
  it('licenses/index renders and computes seat usage via usagePercent', () => {
    const html = render('licenses/index.ejs', {
      ...baseLocals(),
      title: 'Licenses',
      licenses: [{
        id: 1, software_name: 'Microsoft 365', vendor: 'Microsoft',
        license_type: 'subscription', total_seats: 10, used_seats: 9,
        expiry_date: '2099-01-01', license_key: 'secret-key'
      }],
      filters: {}, page: 1, limit: 25, totalPages: 1, total: 1, baseUrl: '/licenses'
    });
    expect(html).toContain('Microsoft 365');
    // usagePercent(9, 10) === 90 — proves the helper ran inside the template
    expect(html).toContain('90%');
  });

  it('assets/show renders for an asset with a warranty date (daysUntil)', () => {
    const html = render('assets/show.ejs', {
      ...baseLocals(),
      title: 'Asset',
      asset: {
        id: 1, name: 'MacBook Pro', asset_tag: 'AST-001',
        status: 'in_use', condition_rating: 'good', category: 'laptop',
        warranty_expiry: '2099-01-01', purchase_date: '2020-01-01',
        purchase_price: 1999, assigned_name: 'Ada', assigned_email: 'ada@company.com'
      },
      relatedTickets: []
    });
    expect(html).toContain('AST-001');
  });

  it('projects/show renders when a task has a due date (daysUntil)', () => {
    const html = render('projects/show.ejs', {
      ...baseLocals(),
      title: 'Project',
      project: {
        id: 1, name: 'Migration', status: 'in_progress', priority: 'high',
        progress: 10, owner_name: 'Ada', budget: 1000, spent: 100,
        start_date: null, end_date: null, description: ''
      },
      tasks: [{
        id: 1, title: 'Migrate the database', status: 'todo', priority: 'high',
        due_date: '2099-01-01', assigned_name: 'Ada'
      }],
      members: [], staff: []
    });
    expect(html).toContain('Migrate the database');
  });

  it('changes/form renders stored datetimes into datetime-local inputs with a T separator (regression: space format blanked the field on edit)', () => {
    // safeDateTimeLocal() stores values in space format ("YYYY-MM-DD HH:MM") so
    // they compare lexically against SQLite datetime('now'). But a datetime-local
    // input requires a 'T' separator; a space makes the value non-conforming and
    // browsers drop it (field renders blank → re-submit clears the saved time).
    const html = render('changes/form.ejs', {
      ...baseLocals(),
      title: 'Edit Change',
      isEdit: true,
      change: {
        id: 1, title: 'Server patch', change_type: 'maintenance',
        status: 'scheduled', priority: 'medium', impact: '', description: '',
        // Stored in space format, exactly as produced by safeDateTimeLocal():
        scheduled_start: '2024-01-15 10:00:00',
        scheduled_end: '2024-01-15 12:00:00',
        actual_start: '2024-01-15 10:05:00',
        actual_end: '2024-01-15 11:58:00'
      },
      staff: []
    });
    // Each datetime-local value must use 'T', not a space, and not be blank.
    const values = [...html.matchAll(/type="datetime-local"[^>]*value="([^"]*)"/g)].map(m => m[1]);
    expect(values.length).toBe(4);
    for (const v of values) {
      expect(v).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
      expect(v).not.toContain(' ');
    }
  });

  // Regression test for a real bug that shipped undetected: a stray `<% } %>`
  // after the "My Active Tickets" block prematurely closed the template's
  // render scope, so four of the five dynamic dashboard sections
  // (Team Workload, Upcoming Changes, Recent Tickets, Tickets by Category)
  // silently rendered only their static skeleton with none of their data.
  // The dashboard was the only major page not covered by this suite, which
  // is why the bug escaped. Render the template the same way the route does
  // and assert each section emits its dynamic content.
  it('dashboard renders all five dynamic list sections (not just My Tickets)', () => {
    const html = render('dashboard.ejs', {
      ...baseLocals(),
      title: 'Dashboard',
      ticketStats: { open: 1, in_progress: 1, waiting: 0, resolved: 0, closed: 0, critical_open: 0, total: 2 },
      assetStats: { total: 4, in_use: 2, in_storage: 1, in_repair: 1 },
      projectStats: { total: 1, in_progress: 1, planning: 0, completed: 0, on_hold: 0 },
      staffCount: { total: 3 },
      expiringWarranties: [],
      licenseAlerts: [],
      myTickets: [{ id: 1, ticket_number: 'TK-DASH-MY', title: 'My active ticket', priority: 'high', status: 'open', created_at: '2024-01-01 09:00' }],
      staffWorkload: [{ id: 2, name: 'Alice Workload', role: 'staff', open_tickets: 2 }],
      upcomingChanges: [{ id: 1, title: 'Upcoming change alpha', scheduled_start: '2099-01-01 10:00' }],
      recentTickets: [{ id: 3, ticket_number: 'TK-DASH-RECENT', title: 'Recent ticket', category: 'network', priority: 'low', status: 'open', assigned_name: 'Bob', created_at: '2024-01-02 09:00' }],
      ticketsByCategory: [{ category: 'network', count: 3 }]
    });
    // My Active Tickets
    expect(html).toContain('TK-DASH-MY');
    // Team Workload
    expect(html).toContain('Alice Workload');
    // Upcoming Changes
    expect(html).toContain('Upcoming change alpha');
    // Recent Tickets
    expect(html).toContain('TK-DASH-RECENT');
    // Active Tickets by Category — titleCase('network') === 'Network'
    expect(html).toContain('Network');
  });
});
