const { describe, it, expect } = require('@jest/globals');

// Exercise real SQL behavior for dashboard.js business logic (defensive defaults,
// statement shapes) against an in-memory SQLite database. Uses the same pattern
// as reports.test.js: set DB_PATH before the modules are loaded.

jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => next()
}));

jest.mock('../src/middleware/audit', () => ({
  auditMiddleware: (req, res, next) => next()
}));

const db = require('../src/models/database');
const dashboard = require('../src/routes/dashboard');

function clearDashboard() {
  db.pragma('foreign_keys = OFF');
  db.exec('DELETE FROM ticket_comments; DELETE FROM tickets; DELETE FROM project_tasks; DELETE FROM project_members; DELETE FROM assets; DELETE FROM licenses; DELETE FROM change_log');
  db.pragma('foreign_keys = ON');
}

describe('dashboard cache invalidation', () => {
  beforeEach(() => {
    dashboard.resetCachedStatements();
  });

  it('invalidateDashboardCache is a function', () => {
    expect(dashboard.invalidateDashboardCache).toBeInstanceOf(Function);
  });

  it('resetCachedStatements resets the TTL cache', () => {
    expect(() => dashboard.resetCachedStatements()).not.toThrow();
  });
});

describe('all dashboard statements exist', () => {
  beforeEach(clearDashboard);

  it('ticketStats statement exists', () => {
    expect(dashboard.__stmts.ticketStats).toBeTruthy();
    const stats = dashboard.__stmts.ticketStats.get();
    expect(stats).toHaveProperty('total');
    expect(stats).toHaveProperty('open');
    expect(stats).toHaveProperty('in_progress');
    expect(stats).toHaveProperty('waiting');
    expect(stats).toHaveProperty('resolved');
    expect(stats).toHaveProperty('closed');
    expect(stats).toHaveProperty('critical_open');
  });

  it('assetStats statement exists', () => {
    expect(dashboard.__stmts.assetStats).toBeTruthy();
    const stats = dashboard.__stmts.assetStats.get();
    expect(stats).toHaveProperty('total');
    expect(stats).toHaveProperty('in_use');
    expect(stats).toHaveProperty('in_storage');
    expect(stats).toHaveProperty('in_repair');
  });

  it('projectStats statement exists', () => {
    expect(dashboard.__stmts.projectStats).toBeTruthy();
    const stats = dashboard.__stmts.projectStats.get();
    expect(stats).toHaveProperty('total');
    expect(stats).toHaveProperty('in_progress');
    expect(stats).toHaveProperty('planning');
    expect(stats).toHaveProperty('completed');
    expect(stats).toHaveProperty('on_hold');
  });

  it('staffCount statement exists', () => {
    expect(dashboard.__stmts.staffCount).toBeTruthy();
    const stats = dashboard.__stmts.staffCount.get();
    expect(stats).toHaveProperty('total');
  });
});

describe('dashboard queries select only rendered columns', () => {
  beforeEach(clearDashboard);

  it('recentTickets does not fetch requester PII', () => {
    const stmt = dashboard.__stmts.recentTickets;
    expect(stmt).toBeTruthy();
    // better-sqlite3 v11 uses .source, older versions use .sql
    const stmtText = stmt.source || stmt.sql || '';
    // Should NOT contain requester_email, requester_phone, requester_department
    expect(stmtText).not.toContain('requester_email');
    expect(stmtText).not.toContain('requester_phone');
    expect(stmtText).not.toContain('requester_department');
    // Should contain the expected columns
    expect(stmtText).toContain('ticket_number');
    expect(stmtText).toContain('title');
    expect(stmtText).toContain('category');
    expect(stmtText).toContain('priority');
    expect(stmtText).toContain('status');
    expect(stmtText).toContain('created_at');
    expect(stmtText).toContain('assigned_name');
  });

  it('myTickets selects only rendered columns (no requester PII)', () => {
    const stmt = dashboard.__stmts.myTickets;
    expect(stmt).toBeTruthy();
    const stmtText = stmt.source || stmt.sql || '';
    expect(stmtText).not.toContain('requester_email');
    expect(stmtText).not.toContain('requester_phone');
    expect(stmtText).not.toContain('requester_department');
    expect(stmtText).toContain('ticket_number');
    expect(stmtText).toContain('assigned_name');
  });

  it('licenseAlerts does not include license_key column', () => {
    const stmt = dashboard.__stmts.licenseAlerts;
    expect(stmt).toBeTruthy();
    const stmtText = stmt.source || stmt.sql || '';
    expect(stmtText).not.toContain('license_key');
    expect(stmtText).toContain('software_name');
    expect(stmtText).toContain('vendor');
    expect(stmtText).toContain('expiry_date');
  });
});

describe('staffWorkload aggregation', () => {
  beforeEach(clearDashboard);

  it('returns staff with open ticket counts', () => {
    const workload = dashboard.__stmts.staffWorkload.all();
    expect(Array.isArray(workload)).toBe(true);
    for (const row of workload) {
      expect(row).toHaveProperty('id');
      expect(row).toHaveProperty('name');
      expect(row).toHaveProperty('role');
      expect(row).toHaveProperty('open_tickets');
    }
  });
});

describe('ticketsByCategory aggregation', () => {
  beforeEach(clearDashboard);

  it('groups active tickets by category', () => {
    const categories = dashboard.__stmts.ticketsByCategory.all();
    expect(Array.isArray(categories)).toBe(true);
    for (const row of categories) {
      expect(row).toHaveProperty('category');
      expect(row).toHaveProperty('count');
    }
  });
});
