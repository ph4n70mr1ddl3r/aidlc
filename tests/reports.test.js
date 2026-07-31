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
