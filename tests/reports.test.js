const { describe, it, expect } = require('@jest/globals');

// Exercise the REAL database.js schema + the REAL prepared statements in
// reports.js / dashboard.js against an in-memory SQLite database. Using the
// actual modules (instead of mocking the DB) lets us assert real SQL behavior —
// the age-bucket ORDER BY and the disposed-asset warranty exclusion — without
// mirroring SQL strings in the test (which would drift from the source).
//
// DB_PATH must be set BEFORE database.js is required (it reads the env at
// module-load time). We use jest.resetModules() to ensure a fresh module
// graph so the in-memory DB is not polluted by other test files that may have
// loaded these modules against a file-backed DB.
jest.resetModules();
process.env.DB_PATH = ':memory:';

jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => next(),
  requireAdminOrManager: (req, res, next) => next()
}));

jest.mock('../src/middleware/audit', () => ({
  audit: jest.fn(),
  auditMiddleware: (req, res, next) => next()
}));

const db = require('../src/models/database');
const reports = require('../src/routes/reports');
const dashboard = require('../src/routes/dashboard');

// Build a YYYY-MM-DD string N days from today, in UTC (SQLite date('now') is UTC).
// Keeps the test stable regardless of when it runs or the host timezone.
function daysFromNow(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

let _assetSeq = 0;
function insertAsset(row) {
  _assetSeq += 1;
  db.prepare(
    'INSERT INTO assets (asset_tag, name, category, status, purchase_date, warranty_expiry) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('AST-T' + String(_assetSeq).padStart(3, '0'), row.name, row.category || 'other', row.status, row.purchase_date || null, row.warranty_expiry || null);
}

function clearAssets() {
  // Disable FK checks for cleanup to avoid cascade issues with dependent tables
  db.pragma('foreign_keys = OFF');
  db.exec('DELETE FROM ticket_comments; DELETE FROM tickets; DELETE FROM project_tasks; DELETE FROM project_members; DELETE FROM assets');
  db.pragma('foreign_keys = ON');
  _assetSeq = 0;
}

describe('asset age distribution ordering', () => {
  beforeEach(clearAssets);
  it('returns age buckets in natural age order (newest first), not lexicographic', () => {
    // Insert one asset per bucket. Purchase dates are relative to "now" (UTC)
    // so each lands deterministically in its bucket regardless of run date.
    insertAsset({ name: 'fresh', status: 'in_use', purchase_date: daysFromNow(-100) }); // < 1 year
    insertAsset({ name: 'yr2', status: 'in_use', purchase_date: daysFromNow(-500) }); // 1-2 years
    insertAsset({ name: 'yr3', status: 'in_use', purchase_date: daysFromNow(-800) }); // 2-3 years
    insertAsset({ name: 'yr4', status: 'in_use', purchase_date: daysFromNow(-1100) }); // 3-4 years
    insertAsset({ name: 'old', status: 'in_storage', purchase_date: daysFromNow(-2000) }); // 4+ years

    const rows = reports.__stmts.ageDistribution.all();
    const groups = rows.map(r => r.age_group);

    // Regression: ORDER BY age_group (lexicographic) put '< 1 year' LAST because
    // '<' (ASCII 60) sorts after the digits '1'..'4'. The fix uses an explicit
    // CASE mapping so buckets appear in natural age order.
    expect(groups).toEqual(['< 1 year', '1-2 years', '2-3 years', '3-4 years', '4+ years']);
    for (const r of rows) {
      expect(r.count).toBe(1);
    }
  });
});

describe('warranty expiry alerts exclude disposed assets', () => {
  beforeEach(clearAssets);
  it('reports warrantyExpiring list and count skip disposed assets', () => {
    // In-use asset with a soon-expiring warranty — should appear (within 90d).
    insertAsset({ name: 'active-soon', status: 'in_use', warranty_expiry: daysFromNow(30) });
    // Disposed asset with a soon-expiring warranty — must NOT appear.
    insertAsset({ name: 'disposed-soon', status: 'disposed', warranty_expiry: daysFromNow(20) });
    // In-use asset with a far-future warranty — must NOT appear (out of window).
    insertAsset({ name: 'active-far', status: 'in_use', warranty_expiry: daysFromNow(4000) });

    const list = reports.__stmts.warrantyExpiring.all().map(r => r.name);
    const count = reports.__stmts.warrantyExpiringCount.get().c;

    expect(list).toEqual(['active-soon']);
    expect(count).toBe(1);
  });

  it('dashboard expiringWarranties skip disposed assets', () => {
    // Dashboard uses a 30-day window — keep both warranties inside it.
    insertAsset({ name: 'dash-active', status: 'in_use', warranty_expiry: daysFromNow(10) });
    insertAsset({ name: 'dash-disposed', status: 'disposed', warranty_expiry: daysFromNow(5) });

    const list = dashboard.__stmts.expiringWarranties.all().map(r => r.name);

    expect(list).toEqual(['dash-active']);
  });
});

describe('asset inventory value excludes disposed assets', () => {
  beforeEach(clearAssets);
  it('assetsTotalValue and assetsByCategory skip disposed assets (regression)', () => {
    const insert = db.prepare('INSERT INTO assets (asset_tag, name, category, status, purchase_price) VALUES (?, ?, ?, ?, ?)');
    insert.run('AST-V001', 'active-laptop', 'laptop', 'in_use', 1000);
    insert.run('AST-V002', 'active-server', 'server', 'in_storage', 5000);
    // Disposed asset must not count toward inventory value or per-category value.
    insert.run('AST-V003', 'disposed-laptop', 'laptop', 'disposed', 9000);

    expect(reports.__stmts.assetsTotalValue.get().total).toBe(6000);

    const byCategory = reports.__stmts.assetsByCategory.all();
    const laptop = byCategory.find(r => r.category === 'laptop');
    const server = byCategory.find(r => r.category === 'server');
    expect(laptop.count).toBe(1);
    expect(laptop.total_value).toBe(1000);
    expect(server.total_value).toBe(5000);
  });

  it('dashboard assetStats skips disposed assets and stays consistent with subtotals (regression)', () => {
    // Regression: the dashboard assetStats query must exclude disposed assets
    // so the total matches the "Active Assets" label and the subtotals (in_use,
    // in_storage, in_repair) sum to the total — matching the reports page
    // convention and preventing a misleading dashboard stat card.
    const insert = db.prepare('INSERT INTO assets (asset_tag, name, category, status) VALUES (?, ?, ?, ?)');
    insert.run('AST-D001', 'active-laptop', 'laptop', 'in_use');
    insert.run('AST-D002', 'active-server', 'server', 'in_storage');
    insert.run('AST-D003', 'disposed-laptop', 'laptop', 'disposed');

    const stats = dashboard.__stmts.assetStats.get();
    expect(stats.total).toBe(2);
    expect(stats.in_use).toBe(1);
    expect(stats.in_storage).toBe(1);
    expect(stats.in_repair).toBe(0);
    // Subtotals must sum to total (no disposed leakage).
    expect(stats.in_use + stats.in_storage + stats.in_repair).toBe(stats.total);
  });
});

describe('dashboard alert counts are uncapped while lists stay capped (regression)', () => {
  beforeEach(clearAssets);
  it('expiringWarrantiesCount reports the true total past the 20-row list cap', () => {
    // Regression: the alert card used to render expiringWarranties.length,
    // which is capped at LIMIT 20 — with 25 qualifying assets the card said
    // "20 asset(s)" as if that were the total.
    for (let i = 1; i <= 25; i++) {
      insertAsset({ name: 'warranty-' + i, status: 'in_use', warranty_expiry: daysFromNow(i % 25) });
    }
    const list = dashboard.__stmts.expiringWarranties.all();
    const count = dashboard.__stmts.expiringWarrantiesCount.get().c;
    expect(list.length).toBe(20); // list stays capped to bound the cached payload
    expect(count).toBe(25); // count is the true, uncapped total
  });

  it('licenseAlertsCount reports the true total past the 20-row list cap', () => {
    const insert = db.prepare('INSERT INTO licenses (software_name, vendor, license_key, license_type, total_seats, used_seats, cost, expiry_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (let i = 1; i <= 22; i++) {
      insert.run('Soft-' + i, null, null, null, 1, 0, 0, daysFromNow(5));
    }
    const list = dashboard.__stmts.licenseAlerts.all();
    const count = dashboard.__stmts.licenseAlertsCount.get().c;
    expect(list.length).toBe(20);
    expect(count).toBe(22);
  });
});

describe('dashboard critical_open includes waiting tickets (regression)', () => {
  beforeEach(() => {
    db.pragma('foreign_keys = OFF');
    db.exec('DELETE FROM ticket_comments; DELETE FROM tickets;');
    db.pragma('foreign_keys = ON');
  });
  it('a critical ticket in waiting status still counts as critical_open', () => {
    // Regression: critical_open used status IN ('open','in_progress') while
    // every other "active" metric on the page includes 'waiting' — a critical
    // ticket moved to waiting (e.g. pending vendor RMA) vanished from the most
    // severe alert while still appearing in Recent Tickets below it.
    const insert = db.prepare('INSERT INTO tickets (ticket_number, title, category, priority, status, requester_name, requester_email) VALUES (?, ?, ?, ?, ?, ?, ?)');
    insert.run('TK-C1', 'waiting critical', 'hardware', 'critical', 'waiting', 'R', 'r@x.com');
    const stats = dashboard.__stmts.ticketStats.get();
    expect(stats.critical_open).toBe(1);
    expect(stats.waiting).toBe(1);
  });
});

describe('dashboard assetStats carries a reserved subtotal (regression)', () => {
  beforeEach(clearAssets);
  it('reserved assets count toward the total and the four subtotals still sum to it', () => {
    // Regression: 'reserved' is a legal asset status but had no subtotal, so
    // in_use+in_storage+in_repair could never sum to the total whenever a
    // reserved asset existed — the exact invariant the query comment claimed.
    const insert = db.prepare('INSERT INTO assets (asset_tag, name, category, status) VALUES (?, ?, ?, ?)');
    insert.run('AST-R001', 'laptop', 'laptop', 'in_use');
    insert.run('AST-R002', 'held laptop', 'laptop', 'reserved');
    insert.run('AST-R003', 'dead laptop', 'laptop', 'disposed');
    const stats = dashboard.__stmts.assetStats.get();
    expect(stats.reserved).toBe(1);
    expect(stats.total).toBe(2);
    expect(stats.in_use + stats.in_storage + stats.in_repair + stats.reserved).toBe(stats.total);
  });
});

describe('resolved metrics window on the resolution date (regression)', () => {
  beforeEach(() => {
    db.pragma('foreign_keys = OFF');
    db.exec('DELETE FROM ticket_comments; DELETE FROM tickets; DELETE FROM users WHERE username LIKE \'rpt-%\';');
    db.pragma('foreign_keys = ON');
  });
  it('a ticket created outside the period but resolved inside it counts (30-day period)', () => {
    // Regression: avgResolution / slaStats / topResolvers windowed on
    // created_at while the staff report windows on resolved_at — the same
    // "Resolved" label measured two different ticket sets on the two pages.
    db.prepare("INSERT INTO users (username, password, email, first_name, last_name, role) VALUES ('rpt-solver', 'x', 's@x.com', 'Solve', 'R', 'staff')").run();
    const uid = db.prepare("SELECT id FROM users WHERE username = 'rpt-solver'").get().id;
    db.prepare("INSERT INTO tickets (ticket_number, title, category, priority, status, requester_name, requester_email, assigned_to, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-40 days'), datetime('now', '-1 day'))")
      .run('TK-R1', 'old but resolved', 'hardware', 'low', 'resolved', 'R', 'r@x.com', uid);

    const top = reports.__stmts.topResolvers.all(30);
    expect(top).toHaveLength(1);
    expect(top[0].resolved).toBe(1);

    const avg = reports.__stmts.avgResolution.get(30);
    expect(avg.avg_days).not.toBeNull();

    const sla = reports.__stmts.slaStats.get(30);
    expect(sla.total_resolved).toBe(1);
  });
});

describe('resetCachedStatements', () => {
  it('resetCachedStatements is a function that does not throw', () => {
    expect(typeof reports.resetCachedStatements).toBe('function');
    expect(() => reports.resetCachedStatements()).not.toThrow();
  });
});

describe('resolveReportPeriod HPP fail-closed', () => {
  const { resolveReportPeriod } = require('../src/routes/reports');

  it('rejects HPP array period and falls back to default', () => {
    // HTTP parameter pollution (an array) must NOT silently use the first
    // element — it must fail closed to the default rather than an
    // attacker-controlled value.
    expect(resolveReportPeriod(['999', '1'])).toBe(30);
    expect(resolveReportPeriod(['1', '999'])).toBe(30);
  });

  it('clamps out-of-range values to [1, 365]', () => {
    expect(resolveReportPeriod('9999')).toBe(365);
    expect(resolveReportPeriod('0')).toBe(1);
    expect(resolveReportPeriod('-5')).toBe(1);
  });

  it('accepts a valid in-range value', () => {
    expect(resolveReportPeriod('90')).toBe(90);
  });

  it('falls back to default for non-numeric junk', () => {
    expect(resolveReportPeriod('abc')).toBe(30);
  });
});
