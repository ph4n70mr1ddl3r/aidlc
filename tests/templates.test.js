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
    escapeHtml: utils.escapeHtml,
    isValidEmail: utils.isValidEmail,
    titleCase: utils.titleCase,
    isPrivileged: utils.isPrivileged,
    badgeClass: utils.badgeClass,
    CONDITION_BADGE: constants.CONDITION_BADGE,
    CHANGE_TYPE_BADGE: constants.CHANGE_TYPE_BADGE,
    ROLE_BADGE: constants.ROLE_BADGE,
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
    const fnHelpers = [
      'localDate', 'formatDate', 'formatDateTime',
      'daysUntil', 'usagePercent', 'isExpiringSoon',
      'escapeHtml', 'isValidEmail', 'titleCase',
      'isPrivileged', 'badgeClass'
    ];
    for (const name of fnHelpers) {
      expect(typeof utils[name]).toBe('function');
      // Verify the helper is assigned via res.locals.<name> = pattern (not just a substring match)
      expect(appSrc).toMatch(new RegExp(`res\\.locals\\.${name}\\s*=`));
    }
    // Badge constants are objects (maps), not functions
    const objHelpers = ['CONDITION_BADGE', 'CHANGE_TYPE_BADGE', 'ROLE_BADGE'];
    for (const name of objHelpers) {
      expect(typeof utils[name]).toBe('object');
      expect(appSrc).toMatch(new RegExp(`res\\.locals\\.${name}\\s*=`));
    }
    // CONSTANTS is hoisted from constants module
    expect(appSrc).toMatch(/res\.locals\.CONSTANTS\s*=/);
  });

  it('every CONSTANTS.* key referenced by templates is exported by constants.js and wired into app.js TEMPLATE_CONSTANTS', () => {
    // Regression guard: MIN_PASSWORD was referenced by three password forms but
    // omitted from TEMPLATE_CONSTANTS, so minlength="" and a broken pattern
    // regex silently disabled client-side password validation. Collect every
    // `CONSTANTS.<KEY>` referenced across views and cross-check both the
    // constants module exports and the TEMPLATE_CONSTANTS object in app.js.
    const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
    const constantsBlock = appSrc.slice(appSrc.indexOf('TEMPLATE_CONSTANTS'), appSrc.indexOf('});', appSrc.indexOf('TEMPLATE_CONSTANTS')));
    const wiredKeys = new Set([...constantsBlock.matchAll(/([A-Z_]+):\s*constantsModule\.[A-Z_]+/g)].map((m) => m[1]));

    const viewsDir = path.join(__dirname, '..', 'views');
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? walk(p) : (e.name.endsWith('.ejs') ? [p] : []);
    });

    const referencedKeys = new Set();
    for (const file of walk(viewsDir)) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/CONSTANTS\.([A-Z_]+)/g)) {
        referencedKeys.add(m[1]);
      }
    }
    expect(referencedKeys.size).toBeGreaterThan(0);
    for (const key of referencedKeys) {
      expect(constants[key]).toBeDefined();
      expect(wiredKeys.has(key)).toBe(true);
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
  it('audit/index renders entries with special characters in details (regression: double-escape / missing escapeHtml in locals)', () => {
    const html = render('audit/index.ejs', {
      ...baseLocals(),
      title: 'Audit Log',
      entries: [
        { id: 1, created_at: '2024-01-01 09:00', user_name: 'Admin', action: 'update', entity_type: 'ticket', entity_id: '42', ip_address: '127.0.0.1', details: 'foo & bar <script>' }
      ],
      filters: {}, page: 1, limit: 25, totalPages: 1, total: 1, baseUrl: '/audit'
    });
    expect(html).toContain('foo');
    expect(html).toContain('bar');
  });

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

// ---------------------------------------------------------------------------
// Full-template render regression: every view must render without throwing.
// This guards the exact bug class that has bitten this codebase before — a
// template referencing a helper that is not wired into res.locals, or a stray
// `<% } %>` silently dropping a dynamic section (both previously shipped and
// escaped because the affected page was not covered by a render test). Each
// fixture supplies the minimal-but-realistic locals the route passes.
// ---------------------------------------------------------------------------
describe('every template renders without error (regression)', () => {
  const ticket = {
    id: 1, ticket_number: 'TK-2026-0001', title: 'Printer jam <script>alert(1)</script>',
    description: 'Paper jam', category: 'hardware', priority: 'high', status: 'in_progress',
    requester_name: 'Lisa Park', requester_email: 'l.park@company.com', requester_department: 'Marketing',
    requester_phone: '555-0101', assigned_to: 3, assigned_name: 'Maya Patel', due_date: '2099-01-01',
    asset_name: 'HP LaserJet', asset_tag: 'AST-007', created_at: '2026-01-01 09:00',
    updated_at: '2026-01-02 10:00', resolved_at: null, satisfaction_rating: 0, resolution_notes: null
  };
  const comment = {
    id: 1, author_name: 'Maya Patel', author_role: 'staff', is_internal: 1,
    comment: 'Investigating <script>alert(2)</script>', created_at: '2026-01-01 10:00'
  };
  const staffViewer = { id: 1, first_name: 'Sarah', last_name: 'Chen', role: 'admin', email: 'admin@company.com', department: 'IT' };
  const staffUser = {
    id: 2, username: 'mpatel', first_name: 'Maya', last_name: 'Patel', email: 'm.patel@company.com',
    phone: '555-0103', role: 'staff', department: 'IT', is_active: 1, last_login: '2026-01-02 09:00',
    created_at: '2025-01-01', updated_at: '2025-01-01'
  };

  // Each fixture maps a page to the exact locals the route passes. The factory
  // form avoids cross-test mutation of the shared objects above.
  const fixtures = [
    { name: 'auth/login (no reason)', file: 'auth/login.ejs', locals: () => ({ ...baseLocals(), title: 'Login', reason: '' }) },
    { name: 'auth/login (deactivated)', file: 'auth/login.ejs', locals: () => ({ ...baseLocals(), title: 'Login', reason: 'deactivated' }) },
    { name: 'auth/login (password_changed)', file: 'auth/login.ejs', locals: () => ({ ...baseLocals(), title: 'Login', reason: 'password_changed' }) },
    { name: 'auth/login (injected reason is ignored)', file: 'auth/login.ejs', locals: () => ({ ...baseLocals(), title: 'Login', reason: '"><script>alert(1)</script>' }) },
    { name: 'auth/profile', file: 'auth/profile.ejs', locals: () => ({ ...baseLocals(), title: 'My Profile', profileUser: { ...staffViewer, username: 'schen' } }) },
    { name: 'tickets/show (privileged)', file: 'tickets/show.ejs', locals: () => ({ ...baseLocals(), title: ticket.ticket_number, ticket, comments: [comment] }) },
    { name: 'tickets/show (staff viewer)', file: 'tickets/show.ejs', locals: () => ({ ...baseLocals(), user: { ...staffViewer, role: 'staff' }, title: ticket.ticket_number, ticket: { ...ticket, assigned_to: 2 }, comments: [] }) },
    { name: 'tickets/show (resolved, satisfaction)', file: 'tickets/show.ejs', locals: () => ({ ...baseLocals(), title: ticket.ticket_number, ticket: { ...ticket, status: 'resolved', resolved_at: '2026-01-03 09:00', satisfaction_rating: 4, resolution_notes: 'Replaced drum' }, comments: [] }) },
    { name: 'tickets/index', file: 'tickets/index.ejs', locals: () => ({ ...baseLocals(), title: 'Tickets', tickets: [ticket], filters: {}, page: 1, limit: 25, totalPages: 1, total: 1, baseUrl: '/tickets' }) },
    { name: 'tickets/form (new)', file: 'tickets/form.ejs', locals: () => ({ ...baseLocals(), title: 'New Ticket', ticket: {}, isEdit: false, staff: [staffUser] }) },
    { name: 'tickets/form (edit)', file: 'tickets/form.ejs', locals: () => ({ ...baseLocals(), title: 'Edit Ticket', ticket, isEdit: true, staff: [staffUser] }) },
    { name: 'staff/show (admin)', file: 'staff/show.ejs', locals: () => ({
      ...baseLocals(), title: 'Staff', staffUser,
      assignedTickets: [ticket], assignedTasks: [{ id: 1, title: 'Migrate DB', project_id: 1, project_name: 'Cloud', due_date: '2099-01-01' }],
      projectMemberships: [{ project_id: 1, project_name: 'Cloud', project_status: 'in_progress', project_role: 'lead' }],
      assignedAssets: [{ id: 1, asset_tag: 'AST-007', name: 'HP LaserJet', status: 'in_use' }]
    }) },
    { name: 'staff/show (staff viewing self)', file: 'staff/show.ejs', locals: () => ({
      ...baseLocals(), user: { ...staffViewer, role: 'staff', id: 2 }, title: 'Staff', staffUser,
      assignedTickets: [], assignedTasks: [], projectMemberships: [], assignedAssets: []
    }) },
    { name: 'staff/index', file: 'staff/index.ejs', locals: () => ({ ...baseLocals(), title: 'Staff', staff: [staffUser], filters: {}, page: 1, limit: 25, totalPages: 1, total: 1, baseUrl: '/staff' }) },
    { name: 'staff/form (new)', file: 'staff/form.ejs', locals: () => ({ ...baseLocals(), title: 'New Staff Member', staffMember: {}, isEdit: false, viewerRole: 'admin' }) },
    { name: 'staff/form (edit)', file: 'staff/form.ejs', locals: () => ({ ...baseLocals(), title: 'Edit Staff Member', staffMember: staffUser, isEdit: true, viewerRole: 'admin' }) },
    { name: 'vendors/show (active)', file: 'vendors/show.ejs', locals: () => ({ ...baseLocals(), title: 'Vendor', vendor: { id: 1, name: 'Dell', contact_person: 'Mike', email: 'm@dell.com', phone: '555', address: 'Addr', website: 'https://dell.com', category: 'hardware', contract_start: '2024-01-01', contract_end: '2026-01-01', rating: 4, is_active: 1, notes: null } }) },
    { name: 'vendors/show (inactive, no data)', file: 'vendors/show.ejs', locals: () => ({ ...baseLocals(), title: 'Vendor', vendor: { id: 2, name: 'X', contact_person: null, email: null, phone: null, address: null, website: 'not-a-url', category: null, contract_start: null, contract_end: null, rating: 0, is_active: 0, notes: 'n' } }) },
    { name: 'vendors/index', file: 'vendors/index.ejs', locals: () => ({ ...baseLocals(), title: 'Vendors', vendors: [], filters: {}, page: 1, limit: 25, totalPages: 1, total: 0, baseUrl: '/vendors' }) },
    { name: 'vendors/form (new)', file: 'vendors/form.ejs', locals: () => ({ ...baseLocals(), title: 'New Vendor', vendor: {}, isEdit: false }) },
    { name: 'licenses/show (privileged)', file: 'licenses/show.ejs', locals: () => ({ ...baseLocals(), title: 'License', license: { id: 1, software_name: 'MS365', vendor: 'MS', license_key: 'SECRET-KEY-1234', license_type: 'subscription', total_seats: 10, used_seats: 9, purchase_date: '2024-01-01', expiry_date: '2099-01-01', cost: 1000, notes: null } }) },
    { name: 'licenses/show (zero seats, no key, perpetual)', file: 'licenses/show.ejs', locals: () => ({ ...baseLocals(), title: 'License', license: { id: 2, software_name: 'Win Server', vendor: 'MS', license_key: null, license_type: 'perpetual', total_seats: 0, used_seats: 0, purchase_date: '2024-01-01', expiry_date: null, cost: null, notes: 'x' } }) },
    { name: 'licenses/show (restricted)', file: 'licenses/show.ejs', locals: () => ({ ...baseLocals(), user: { ...staffViewer, role: 'staff' }, title: 'License', license: { id: 1, software_name: 'MS365', vendor: 'MS', license_key: 'SECRET-KEY-1234', license_type: 'subscription', total_seats: 10, used_seats: 5, purchase_date: '2024-01-01', expiry_date: '2099-01-01', cost: 1000, notes: null } }) },
    { name: 'licenses/index', file: 'licenses/index.ejs', locals: () => ({ ...baseLocals(), title: 'Licenses', licenses: [], filters: {}, page: 1, limit: 25, totalPages: 1, total: 0, baseUrl: '/licenses' }) },
    { name: 'licenses/form (new)', file: 'licenses/form.ejs', locals: () => ({ ...baseLocals(), title: 'New License', license: {}, isEdit: false }) },
    { name: 'projects/show', file: 'projects/show.ejs', locals: () => ({ ...baseLocals(), title: 'Project', project: { id: 1, name: 'Cloud', description: 'D', status: 'in_progress', priority: 'high', start_date: null, end_date: null, budget: null, spent: null, progress: 0, owner_name: 'Sarah Chen', created_at: '2026-01-01' }, tasks: [], members: [], staff: [staffUser] }) },
    { name: 'projects/index', file: 'projects/index.ejs', locals: () => ({ ...baseLocals(), title: 'Projects', projects: [], filters: {}, page: 1, limit: 25, totalPages: 1, total: 0, baseUrl: '/projects' }) },
    { name: 'projects/form (new)', file: 'projects/form.ejs', locals: () => ({ ...baseLocals(), title: 'New Project', project: {}, isEdit: false, staff: [staffUser] }) },
    { name: 'changes/show', file: 'changes/show.ejs', locals: () => ({ ...baseLocals(), title: 'Change', change: { id: 1, title: 'Patch', change_type: 'maintenance', status: 'scheduled', priority: 'high', impact: null, description: null, scheduled_start: '2026-05-01 02:00', scheduled_end: '2026-05-01 04:00', actual_start: null, actual_end: null, assigned_name: 'Maya Patel' } }) },
    { name: 'changes/index', file: 'changes/index.ejs', locals: () => ({ ...baseLocals(), title: 'Changes', changes: [], filters: {}, page: 1, limit: 25, totalPages: 1, total: 0, baseUrl: '/changes' }) },
    { name: 'changes/form (new)', file: 'changes/form.ejs', locals: () => ({ ...baseLocals(), title: 'New Change', isEdit: false, change: {}, staff: [staffUser] }) },
    { name: 'knowledge/show (published)', file: 'knowledge/show.ejs', locals: () => ({ ...baseLocals(), title: 'VPN Guide', article: { id: 1, title: 'VPN Guide', status: 'published', category: 'how_to', tags: 'vpn', author_name: 'Sarah Chen', views: 5, updated_at: '2026-01-01', renderedContent: '<p>Connect to <strong>vpn.company.com</strong></p>' }, markedFallback: false }) },
    { name: 'knowledge/show (markdown fallback)', file: 'knowledge/show.ejs', locals: () => ({ ...baseLocals(), title: 'VPN Guide', article: { id: 1, title: 'VPN Guide', status: 'published', category: 'how_to', tags: 'vpn', author_name: 'Sarah Chen', views: 5, updated_at: '2026-01-01', renderedContent: 'plain text' }, markedFallback: true }) },
    { name: 'knowledge/index', file: 'knowledge/index.ejs', locals: () => ({ ...baseLocals(), title: 'Knowledge Base', articles: [], filters: {}, page: 1, limit: 25, totalPages: 1, total: 0, baseUrl: '/knowledge' }) },
    { name: 'knowledge/form (new)', file: 'knowledge/form.ejs', locals: () => ({ ...baseLocals(), title: 'New Article', article: {}, isEdit: false }) },
    { name: 'knowledge/form (edit)', file: 'knowledge/form.ejs', locals: () => ({ ...baseLocals(), title: 'Edit Article', article: { id: 1, title: 'VPN', category: 'how_to', status: 'published', tags: 'vpn', content: '# Hi', is_featured: 1 }, isEdit: true }) },
    { name: 'assets/show', file: 'assets/show.ejs', locals: () => ({ ...baseLocals(), title: 'Asset', asset: { id: 1, name: 'MacBook Pro', asset_tag: 'AST-001', status: 'in_use', condition_rating: 'good', category: 'laptop', warranty_expiry: '2099-01-01', purchase_date: '2020-01-01', purchase_price: 1999, assigned_name: 'Sarah', assigned_email: 'admin@company.com' }, relatedTickets: [] }) },
    { name: 'assets/index', file: 'assets/index.ejs', locals: () => ({ ...baseLocals(), title: 'Assets', assets: [], filters: {}, page: 1, limit: 25, totalPages: 1, total: 0, baseUrl: '/assets' }) },
    { name: 'assets/form (new)', file: 'assets/form.ejs', locals: () => ({ ...baseLocals(), title: 'New Asset', asset: {}, isEdit: false, staff: [staffUser] }) },
    { name: 'reports/index', file: 'reports/index.ejs', locals: () => ({ ...baseLocals(), title: 'Reports' }) },
    { name: 'reports/tickets (empty)', file: 'reports/tickets.ejs', locals: () => ({ ...baseLocals(), title: 'Ticket Analytics', period: 30, ticketsByDay: [], byCategory: [], byPriority: [], avgResolution: { avg_days: null }, slaStats: { total_resolved: 0, within_1d: 0, within_3d: 0, within_7d: 0 }, topResolvers: [] }) },
    { name: 'reports/tickets (data)', file: 'reports/tickets.ejs', locals: () => ({ ...baseLocals(), title: 'Ticket Analytics', period: 7, ticketsByDay: [{ date: '2026-01-01', count: 3 }], byCategory: [{ category: 'network', count: 3 }], byPriority: [{ priority: 'critical', count: 1 }], avgResolution: { avg_days: 2.5 }, slaStats: { total_resolved: 10, within_1d: 4, within_3d: 8, within_7d: 9 }, topResolvers: [{ name: 'Sarah Chen', resolved: 5 }] }) },
    { name: 'reports/assets', file: 'reports/assets.ejs', locals: () => ({ ...baseLocals(), title: 'Asset Report', byCategory: [], byStatus: [], byCondition: [], totalValue: { total: 0 }, warrantyCount: 0, warrantyExpiring: [], ageDistribution: [] }) },
    { name: 'reports/staff', file: 'reports/staff.ejs', locals: () => ({ ...baseLocals(), title: 'Staff Performance', performance: [], period: 30 }) },
    { name: 'audit/index', file: 'audit/index.ejs', locals: () => ({ ...baseLocals(), title: 'Audit Log', entries: [], filters: {}, page: 1, limit: 25, totalPages: 1, total: 0, baseUrl: '/audit' }) },
    { name: 'dashboard', file: 'dashboard.ejs', locals: () => ({ ...baseLocals(), title: 'Dashboard', ticketStats: { open: 0, in_progress: 0, waiting: 0, resolved: 0, closed: 0, critical_open: 0, total: 0 }, assetStats: { total: 0, in_use: 0, in_storage: 0, in_repair: 0 }, projectStats: { total: 0, in_progress: 0, planning: 0, completed: 0, on_hold: 0 }, staffCount: { total: 0 }, expiringWarranties: [], licenseAlerts: [], myTickets: [], staffWorkload: [], upcomingChanges: [], recentTickets: [], ticketsByCategory: [] }) },
    { name: '404', file: '404.ejs', locals: () => ({ ...baseLocals(), title: 'Not Found' }) },
    { name: 'error', file: 'error.ejs', locals: () => ({ ...baseLocals(), title: 'Error', error: { message: 'Something went wrong' } }) },
    { name: 'error (no error object)', file: 'error.ejs', locals: () => ({ ...baseLocals(), title: 'Error' }) }
  ];

  it.each(fixtures)('renders $name without throwing', ({ file, locals }) => {
    expect(() => render(file, locals())).not.toThrow();
  });

  it('tickets/show HTML-escapes user-controlled ticket and comment content', () => {
    const html = render('tickets/show.ejs', {
      ...baseLocals(), title: ticket.ticket_number, ticket, comments: [comment]
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(2)</script>');
    expect(html).toContain('&lt;script&gt;alert(2)&lt;/script&gt;');
  });

  it('licenses/show masks the license key for privileged users and hides it for staff', () => {
    const priv = render('licenses/show.ejs', {
      ...baseLocals(), title: 'License',
      license: { id: 1, software_name: 'MS365', vendor: 'MS', license_key: 'SECRET-KEY-1234', license_type: 'subscription', total_seats: 10, used_seats: 5, purchase_date: '2024-01-01', expiry_date: '2099-01-01', cost: 1000, notes: null }
    });
    expect(priv).toContain('****1234');
    expect(priv).not.toContain('SECRET-KEY-1234');
    expect(priv).not.toContain('SECRET-KEY');
    const restricted = render('licenses/show.ejs', {
      ...baseLocals(), user: { ...staffViewer, role: 'staff' }, title: 'License',
      license: { id: 1, software_name: 'MS365', vendor: 'MS', license_key: 'SECRET-KEY-1234', license_type: 'subscription', total_seats: 10, used_seats: 5, purchase_date: '2024-01-01', expiry_date: '2099-01-01', cost: 1000, notes: null }
    });
    expect(restricted).toContain('Restricted');
    expect(restricted).not.toContain('SECRET-KEY-1234');
  });

  it('licenses/show seat percentage is guarded against total_seats = 0', () => {
    const html = render('licenses/show.ejs', {
      ...baseLocals(), title: 'License',
      license: { id: 2, software_name: 'Win Server', vendor: 'MS', license_key: null, license_type: 'perpetual', total_seats: 0, used_seats: 0, purchase_date: '2024-01-01', expiry_date: null, cost: null, notes: null }
    });
    expect(html).toContain('Perpetual');
    expect(html).not.toContain('NaN');
  });

  it('staff/show shows restricted contact info to a non-privileged viewer of another user', () => {
    const html = render('staff/show.ejs', {
      ...baseLocals(), user: { ...staffViewer, role: 'staff', id: 99 }, title: 'Staff', staffUser,
      assignedTickets: [], assignedTasks: [], projectMemberships: [], assignedAssets: []
    });
    expect(html).toContain('Restricted');
    expect(html).not.toContain('m.patel@company.com');
  });

  it('login template only renders static messages — the raw reason query value is never output', () => {
    // The `reason` local is used purely as a branch selector; an attacker-supplied
    // value must never be echoed into the page (reflected XSS via crafted URL).
    const html = render('auth/login.ejs', {
      ...baseLocals(), title: 'Login', reason: '"><script>alert(1)</script>'
    });
    expect(html).not.toContain('alert(1)');
    expect(html).not.toContain('"><script>');
  });
});
