/**
 * Pass 369 — access-scoping, fail-closed blank values, cap disclosure, and
 * ordering-determinism regression tests.
 *
 * Fixes covered here:
 *  1. The dashboard's "Upcoming Changes" panel listed EVERY scheduled change
 *     (title + start time) to every authenticated viewer, while the change-log
 *     module scopes its list to `assigned_to = user.id` for non-privileged
 *     users and denies them the detail route — an existence/metadata oracle.
 *  2. `/changes/:id` used a distinct "you do not have permission" message for
 *     a record the viewer may not open, which turned the show route into an
 *     existence oracle now that the list is scoped.
 *  3. A present-but-whitespace-only optional text field silently CLEARED the
 *     stored value on every update route (the shared resolveOptionalField
 *     helper treated it as an explicit empty string). The app-wide convention
 *     (established for staff.department) is to fail closed instead.
 *  4. Capped lists did not disclose their truncation ("N+" marker), and the
 *     ticket-comment marker under-reported it for non-privileged viewers.
 *  5. Capped dashboard/report queries lacked the documented `id` tiebreaker.
 *  6. The change-log assignee filter was inert for non-privileged viewers,
 *     and the assets/projects lists exposed no sort control although the
 *     routes honour a `sort` parameter.
 *  7. `password_changed_at` used one-second resolution, so a credential change
 *     in the same second as the session marker did not invalidate the session.
 *
 * The behavioural tests run against a REAL in-memory SQLite database so the
 * SQL and the transaction semantics are genuinely exercised.
 */
process.env.DB_PATH = ':memory:';

const { describe, it, expect, beforeAll, beforeEach } = require('@jest/globals');
const { lastHandlerFor } = require('./helpers');
const { baseLocals, render } = require('./template_helpers');

const db = require('../src/models/database');
const dashboardRouter = require('../src/routes/dashboard');
const ticketsRouter = require('../src/routes/tickets');
const projectsRouter = require('../src/routes/projects');
const changesRouter = require('../src/routes/changes');

const ADMIN = { id: 1, role: 'admin' };
const STAFF = { id: 2, role: 'staff' };

/**
 * Invoke a route handler in isolation and capture its flash/redirect calls.
 */
function runHandler(handler, { method = 'POST', body = {}, params = {}, sessionUser = ADMIN } = {}) {
  const redirectCalls = [];
  const flashCalls = [];
  const auditCalls = [];
  const req = {
    body, params, method,
    session: { user: sessionUser },
    flash: (type, msg) => flashCalls.push([type, msg]),
    audit: (...args) => auditCalls.push(args)
  };
  const res = {
    redirect: (to) => {
      redirectCalls.push(to);
    },
    render: () => {},
    status: () => res,
    json: () => {},
    end: () => {}
  };  handler(req, res, () => {});
  return { redirectCalls, flashCalls, auditCalls };
}

/**
 * Invoke the dashboard GET / handler and return the render locals.
 */
function runDashboard(sessionUser) {
  const layer = dashboardRouter.stack.find(l => l.route && l.route.methods.get);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  let captured = null;
  const req = {
    session: { user: sessionUser },
    path: '/dashboard',
    audit: jest.fn()
  };
  const res = {
    locals: {},
    render: jest.fn((view, locals) => {
      captured = locals;
    }),
    set: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn()
  };
  handler(req, res, () => {});
  return captured;
}

beforeAll(() => {
  db.prepare(`
    INSERT INTO users (id, username, email, first_name, last_name, role, password, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
  `).run(ADMIN.id, 'admin', 'admin@example.com', 'Ada', 'Admin', 'admin', 'x');
  db.prepare(`
    INSERT INTO users (id, username, email, first_name, last_name, role, password, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
  `).run(STAFF.id, 'mpatel', 'mpatel@example.com', 'Maya', 'Patel', 'staff', 'x');
});

beforeEach(() => {
  db.exec('DELETE FROM change_log; DELETE FROM ticket_comments; DELETE FROM tickets; DELETE FROM project_tasks; DELETE FROM project_members; DELETE FROM projects; DELETE FROM assets;');
  dashboardRouter.resetCachedStatements();
});

describe('dashboard upcoming changes are scoped to the viewer (pass 369)', () => {
  const insertChange = (title, assignedTo) => db.prepare(`
    INSERT INTO change_log (title, change_type, status, priority, scheduled_start, assigned_to)
    VALUES (?, 'maintenance', 'scheduled', 'medium', '2099-01-01 09:00', ?)
  `).run(title, assignedTo);

  it('shows a regular staff member only the changes assigned to them', () => {
    insertChange('My Assigned Change', STAFF.id);
    insertChange('Someone Elses Change', ADMIN.id);

    const locals = runDashboard({ id: STAFF.id, role: 'staff' });
    expect(locals.upcomingChanges.map(c => c.title)).toEqual(['My Assigned Change']);
  });

  it('shows a privileged viewer every scheduled change', () => {
    insertChange('My Assigned Change', STAFF.id);
    insertChange('Someone Elses Change', ADMIN.id);

    const locals = runDashboard({ id: ADMIN.id, role: 'admin' });
    const titles = locals.upcomingChanges.map(c => c.title);
    expect(titles).toContain('My Assigned Change');
    expect(titles).toContain('Someone Elses Change');
  });

  it('never serves the scoped list from the shared TTL cache', () => {
    // The upcoming-changes list is viewer-specific, so it must not live in the
    // shared cache payload — otherwise one viewer's rows could be served to
    // another viewer within the cache TTL.
    insertChange('My Assigned Change', STAFF.id);
    insertChange('Someone Elses Change', ADMIN.id);

    const staffLocals = runDashboard({ id: STAFF.id, role: 'staff' });
    const adminLocals = runDashboard({ id: ADMIN.id, role: 'admin' });
    expect(staffLocals.upcomingChanges).toHaveLength(1);
    expect(adminLocals.upcomingChanges).toHaveLength(2);
  });
});

describe('change show route does not leak record existence (pass 369)', () => {
  it('uses the same non-enumerating wording for a denied record as for a missing one', () => {
    const info = db.prepare(`
      INSERT INTO change_log (title, change_type, status, priority, scheduled_start, assigned_to)
      VALUES ('Secret Change', 'security', 'scheduled', 'high', '2099-01-01 09:00', ?)
    `).run(ADMIN.id);

    const handler = lastHandlerFor(changesRouter, 'get', '/:id');
    const { flashCalls, auditCalls } = runHandler(handler, {
      method: 'GET',
      params: { id: String(info.lastInsertRowid) },
      sessionUser: { id: STAFF.id, role: 'staff' }
    });

    expect(flashCalls).toContainEqual(['error', 'Change not found']);
    // The denial is still audited — only the wording changed.
    expect(auditCalls.some(([action]) => action === 'access_denied')).toBe(true);
  });

  it('reports a missing record with the same wording', () => {
    const handler = lastHandlerFor(changesRouter, 'get', '/:id');
    const { flashCalls } = runHandler(handler, {
      method: 'GET',
      params: { id: '999999' },
      sessionUser: { id: STAFF.id, role: 'staff' }
    });
    expect(flashCalls).toContainEqual(['error', 'Change not found']);
  });
});

describe('a whitespace-only optional field fails closed instead of clearing (pass 369)', () => {
  const insertTicket = () => {
    const info = db.prepare(`
      INSERT INTO tickets (ticket_number, title, description, category, priority, status,
        requester_name, requester_email, assigned_to)
      VALUES ('TK-369-001', 'Printer offline', 'Stored description', 'hardware', 'medium', 'open',
        'Requester', 'requester@example.com', ?)
    `).run(ADMIN.id);
    return info.lastInsertRowid;
  };

  it('rejects a whitespace-only ticket description and preserves the stored value', () => {
    const id = insertTicket();
    const handler = lastHandlerFor(ticketsRouter, 'put', '/:id');
    const { flashCalls } = runHandler(handler, {
      method: 'PUT',
      params: { id: String(id) },
      body: { title: 'Printer offline', description: '   ' }
    });

    expect(flashCalls).toContainEqual(['error', 'Invalid Description']);
    expect(db.prepare('SELECT description FROM tickets WHERE id = ?').get(id).description)
      .toBe('Stored description');
  });

  it('rejects a whitespace-only resolution note and preserves the stored value', () => {
    const id = insertTicket();
    const handler = lastHandlerFor(ticketsRouter, 'put', '/:id');
    const { flashCalls } = runHandler(handler, {
      method: 'PUT',
      params: { id: String(id) },
      body: { title: 'Printer offline', resolution_notes: '  ' }
    });

    expect(flashCalls).toContainEqual(['error', 'Invalid Resolution Notes']);
    expect(db.prepare('SELECT resolution_notes FROM tickets WHERE id = ?').get(id).resolution_notes)
      .toBeNull();
  });

  it('still clears the field when an explicit empty string is submitted', () => {
    const id = insertTicket();
    const handler = lastHandlerFor(ticketsRouter, 'put', '/:id');
    const { flashCalls } = runHandler(handler, {
      method: 'PUT',
      params: { id: String(id) },
      body: { title: 'Printer offline', description: '' }
    });

    expect(flashCalls).toContainEqual(['success', 'Ticket updated successfully.']);
    expect(db.prepare('SELECT description FROM tickets WHERE id = ?').get(id).description)
      .toBeNull();
  });

  it('rejects a whitespace-only project description and preserves the stored value', () => {
    const info = db.prepare(`
      INSERT INTO projects (name, description, status, priority) VALUES ('Cloud Migration', 'Stored description', 'in_progress', 'high')
    `).run();

    const handler = lastHandlerFor(projectsRouter, 'put', '/:id');
    const { flashCalls } = runHandler(handler, {
      method: 'PUT',
      params: { id: String(info.lastInsertRowid) },
      body: { name: 'Cloud Migration', description: '   ' }
    });

    expect(flashCalls).toContainEqual(['error', 'Invalid Description']);
    expect(db.prepare('SELECT description FROM projects WHERE id = ?').get(info.lastInsertRowid).description)
      .toBe('Stored description');
  });

  it('still clears a project description when an explicit empty string is submitted', () => {
    const info = db.prepare(`
      INSERT INTO projects (name, description, status, priority) VALUES ('Cloud Migration', 'Stored description', 'in_progress', 'high')
    `).run();

    const handler = lastHandlerFor(projectsRouter, 'put', '/:id');
    const { flashCalls } = runHandler(handler, {
      method: 'PUT',
      params: { id: String(info.lastInsertRowid) },
      body: { name: 'Cloud Migration', description: '' }
    });

    expect(flashCalls).toContainEqual(['success', 'Project updated successfully.']);
    expect(db.prepare('SELECT description FROM projects WHERE id = ?').get(info.lastInsertRowid).description)
      .toBeNull();
  });
});

describe('capped lists disclose their truncation (pass 369)', () => {
  it('asset detail marks the related-ticket list as capped', () => {
    const html = render('assets/show.ejs', {
      ...baseLocals(),
      title: 'Asset',
      asset: { id: 1, name: 'MacBook Pro', asset_tag: 'AST-001', status: 'in_use', condition_rating: 'good', category: 'laptop' },
      relatedTickets: Array.from({ length: 10 }, (_, i) => ({
        id: i + 1, ticket_number: `TK-${i}`, title: `Ticket ${i}`, status: 'open', priority: 'medium', assigned_to: 1, created_at: '2026-01-01 09:00'
      }))
    });
    expect(html).toContain('Related Tickets (10+)');
  });

  it('asset detail shows an exact count when the cap was not reached', () => {
    const html = render('assets/show.ejs', {
      ...baseLocals(),
      title: 'Asset',
      asset: { id: 1, name: 'MacBook Pro', asset_tag: 'AST-001', status: 'in_use', condition_rating: 'good', category: 'laptop' },
      relatedTickets: []
    });
    expect(html).toContain('Related Tickets (0)');
  });

  it('ticket comments mark a capped list as truncated', () => {
    const capped = render('tickets/show.ejs', {
      ...baseLocals(),
      title: 'TK-1',
      ticket: { id: 1, ticket_number: 'TK-1', title: 'T', description: 'D', category: 'hardware', priority: 'high', status: 'open', requester_name: 'R', requester_email: 'r@example.com', assigned_to: 1, assigned_name: 'A', created_at: '2026-01-01 09:00', updated_at: '2026-01-01 09:00', resolved_at: null, satisfaction_rating: 0, resolution_notes: null },
      comments: [{ id: 1, author_name: 'A', author_role: 'staff', is_internal: 0, comment: 'c', created_at: '2026-01-01 09:00' }],
      commentsTruncated: true
    });
    expect(capped).toContain('Comments (1+)');

    const notCapped = render('tickets/show.ejs', {
      ...baseLocals(),
      title: 'TK-1',
      ticket: { id: 1, ticket_number: 'TK-1', title: 'T', description: 'D', category: 'hardware', priority: 'high', status: 'open', requester_name: 'R', requester_email: 'r@example.com', assigned_to: 1, assigned_name: 'A', created_at: '2026-01-01 09:00', updated_at: '2026-01-01 09:00', resolved_at: null, satisfaction_rating: 0, resolution_notes: null },
      comments: [{ id: 1, author_name: 'A', author_role: 'staff', is_internal: 0, comment: 'c', created_at: '2026-01-01 09:00' }],
      commentsTruncated: false
    });
    expect(notCapped).toContain('Comments (1)');
  });

  it('dashboard widgets disclose their caps', () => {
    const html = render('dashboard.ejs', {
      ...baseLocals(),
      title: 'Dashboard',
      ticketStats: { open: 0, in_progress: 0, waiting: 0, resolved: 0, closed: 0, critical_open: 0, total: 0 },
      assetStats: { total: 0, in_use: 0, in_storage: 0, in_repair: 0, reserved: 0 },
      projectStats: { total: 0, in_progress: 0, planning: 0, completed: 0, on_hold: 0 },
      staffCount: { total: 0 },
      expiringWarranties: [], expiringWarrantiesCount: 0,
      licenseAlerts: [], licenseAlertsCount: 0,
      myTickets: Array.from({ length: 10 }, (_, i) => ({ id: i, ticket_number: `TK-${i}`, title: 't', priority: 'low', status: 'open', created_at: '2026-01-01 09:00' })),
      staffWorkload: Array.from({ length: 8 }, (_, i) => ({ id: i, name: `w${i}`, role: 'staff', open_tickets: 1 })),
      upcomingChanges: Array.from({ length: 5 }, (_, i) => ({ id: i, title: `c${i}`, scheduled_start: '2099-01-01 09:00' })),
      recentTickets: Array.from({ length: 10 }, (_, i) => ({ id: i, ticket_number: `TK-R-${i}`, title: 't', category: 'network', priority: 'low', status: 'open', assigned_to: 1, assigned_name: 'A', created_at: '2026-01-01 09:00' })),
      ticketsByCategory: []
    });
    expect(html).toContain('My Active Tickets (10+)');
    expect(html).toContain('Team Workload (8+)');
    expect(html).toContain('Upcoming Changes (5+)');
    expect(html).toContain('Recently Active Tickets (10+)');
  });
});

describe('list filter controls match what the route supports (pass 369)', () => {
  it('hides the change-log assignee filter from non-privileged viewers', () => {
    const staffHtml = render('changes/index.ejs', {
      ...baseLocals({ role: 'staff', id: 2 }),
      title: 'Change Log', changes: [], filters: {}, staff: [],
      page: 1, limit: 25, totalPages: 1, total: 0, baseUrl: '/changes'
    });
    expect(staffHtml).not.toContain('name="assigned_to"');

    const adminHtml = render('changes/index.ejs', {
      ...baseLocals({ role: 'admin' }),
      title: 'Change Log', changes: [], filters: {}, staff: [],
      page: 1, limit: 25, totalPages: 1, total: 0, baseUrl: '/changes'
    });
    expect(adminHtml).toContain('name="assigned_to"');
  });

  it('exposes the sort control on the assets and projects lists', () => {
    const assetsHtml = render('assets/index.ejs', {
      ...baseLocals(),
      title: 'Assets', assets: [], filters: {}, staff: [],
      page: 1, limit: 25, totalPages: 1, total: 0, baseUrl: '/assets'
    });
    expect(assetsHtml).toContain('name="sort"');
    expect(assetsHtml).toContain('<option value="name_asc" selected>');

    const projectsHtml = render('projects/index.ejs', {
      ...baseLocals(),
      title: 'Projects', projects: [], filters: {},
      page: 1, limit: 25, totalPages: 1, total: 0, baseUrl: '/projects'
    });
    expect(projectsHtml).toContain('name="sort"');
    expect(projectsHtml).toContain('<option value="newest" selected>');
  });
});

describe('ordering determinism and credential markers (pass 369)', () => {
  const stmtText = (stmt) => stmt.source || stmt.sql || '';

  it('every capped dashboard query carries an id tiebreaker', () => {
    const capped = ['recentTickets', 'expiringWarranties', 'upcomingChangesAll', 'upcomingChangesOwned', 'staffWorkload', 'licenseAlerts', 'myTickets'];
    for (const name of capped) {
      const sql = stmtText(dashboardRouter.__stmts[name]);
      expect(sql).toMatch(/ORDER BY[\s\S]*\bid\b/);
    }
  });

  it('every capped report query carries a unique trailing key', () => {
    const reports = require('../src/routes/reports');
    // topResolvers groups by the assignee, so the group key is its unique
    // trailing key; the other two are keyed by the row id.
    expect(stmtText(reports.__stmts.topResolvers)).toMatch(/ORDER BY resolved DESC, t\.assigned_to ASC/);
    expect(stmtText(reports.__stmts.warrantyExpiring)).toMatch(/ORDER BY warranty_expiry ASC, id ASC/);
    expect(stmtText(reports.__stmts.staffPerformance)).toMatch(/ORDER BY resolved_tickets DESC, u\.id ASC/);
  });

  it('the credential-change marker uses millisecond resolution', () => {
    const fs = require('fs');
    const path = require('path');
    const staffSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'staff.js'), 'utf8');
    const authSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'auth.js'), 'utf8');
    // A one-second marker (datetime('now')) lets a reset that lands in the same
    // second as the session marker compare equal, so the old session survives
    // a credential change.
    expect(staffSrc).toContain("password_changed_at = strftime(\\'%Y-%m-%d %H:%M:%f\\', \\'now\\')");
    expect(authSrc).toContain("password_changed_at = strftime(\\'%Y-%m-%d %H:%M:%f\\', \\'now\\')");
    expect(staffSrc).not.toContain("password_changed_at = datetime('now')");
    expect(authSrc).not.toContain("password_changed_at = datetime('now')");
  });

  it('the stylesheet no longer carries unreachable per-enum badge rules', () => {
    const fs = require('fs');
    const path = require('path');
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
    // Every badge is rendered through badgeClass(value, BADGE_MAP), which can
    // only emit the four severity classes.
    for (const dead of ['badge-open', 'badge-in_progress', 'badge-waiting', 'badge-resolved', 'badge-closed', 'badge-in_use', 'badge-in_storage', 'badge-in_repair', 'badge-disposed', 'badge-reserved', 'badge-planning', 'badge-on_hold', 'badge-completed', 'badge-cancelled', 'badge-scheduled', 'badge-failed', 'badge-draft', 'badge-published', 'badge-archived', 'badge-todo', 'badge-review', 'badge-done']) {
      expect(css).not.toContain(`.${dead} {`);
    }
    expect(css).toContain('.badge-critical');
    expect(css).toContain('.badge-low');
  });
});
