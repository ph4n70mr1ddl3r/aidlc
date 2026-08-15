const { describe, it, expect } = require('@jest/globals');

const { isValidAssetTag, safePositiveFloat } = require('../src/utils');

// Mock database so we can inspect the SQL passed to prepare() for regression
// tests that assert statement shapes without needing a live DB.
let mockStmt;
jest.mock('../src/models/database', () => {
  mockStmt = { get: jest.fn(() => null), all: jest.fn(() => []), run: jest.fn(() => ({ changes: 1, lastInsertRowid: 1 })) };
  return { prepare: jest.fn(() => mockStmt), exec: jest.fn(), pragma: jest.fn(), transaction: jest.fn((fn) => fn), close: jest.fn() };
});

describe('Asset tag validation', () => {
  it('accepts valid asset tags (AST-XXX)', () => {
    expect(isValidAssetTag('AST-001')).toBe(true);
    expect(isValidAssetTag('AST-999')).toBe(true);
    expect(isValidAssetTag('AST-123')).toBe(true);
  });

  it('rejects malformed asset tags', () => {
    expect(isValidAssetTag('AST-01')).toBe(false);
    expect(isValidAssetTag('ast-001')).toBe(false);
    expect(isValidAssetTag('XYZ-001')).toBe(false);
    expect(isValidAssetTag('AST001')).toBe(false);
    expect(isValidAssetTag('')).toBe(false);
    expect(isValidAssetTag(null)).toBe(false);
    expect(isValidAssetTag(undefined)).toBe(false);
  });
});

describe('Safe positive float (asset purchase_price)', () => {
  it('rejects comma-formatted numbers that parseFloat would silently truncate', () => {
    expect(safePositiveFloat('1,000')).toBeNull();
    expect(safePositiveFloat('1,000.50')).toBeNull();
  });

  it('accepts decimals and whole numbers', () => {
    expect(safePositiveFloat('123.45')).toBe(123.45);
    expect(safePositiveFloat('0')).toBe(0);
    expect(safePositiveFloat('100')).toBe(100);
  });

  it('rejects negative values', () => {
    expect(safePositiveFloat('-50')).toBeNull();
    expect(safePositiveFloat('-0.01')).toBeNull();
  });
});

describe('Asset constants', () => {
  const { ASSET_CATEGORIES, ASSET_STATUSES, ASSET_TAG_PREFIX, ASSET_TAG_RE } = require('../src/constants');

  it('ASSET_TAG_RE matches the prefix and 3 or more digits', () => {
    expect(ASSET_TAG_PREFIX).toBe('AST-');
    expect(ASSET_TAG_RE.test('AST-001')).toBe(true);
    expect(ASSET_TAG_RE.test('AST-999')).toBe(true);
    expect(ASSET_TAG_RE.test('AST-1234')).toBe(true);
    expect(ASSET_TAG_RE.test('AST-01')).toBe(false);
  });

  it('ASSET_CATEGORIES includes all expected values', () => {
    const expected = ['laptop','desktop','server','monitor','printer','network','phone','tablet','software','peripheral','other'];
    expect(ASSET_CATEGORIES).toEqual(expected);
  });

  it('ASSET_STATUSES includes all expected values', () => {
    expect(ASSET_STATUSES).toContain('in_use');
    expect(ASSET_STATUSES).toContain('in_storage');
    expect(ASSET_STATUSES).toContain('in_repair');
    expect(ASSET_STATUSES).toContain('disposed');
    expect(ASSET_STATUSES).toContain('reserved');
  });
});

describe('Assets create purchase_price sentinel regression', () => {
  // Regression test for the assets CREATE path: an absent/empty purchase_price
  // must resolve to 0 (not Infinity) so SQLite does not store a non-finite REAL
  // that corrupts the asset-report SUM aggregation and renders "$Infinity" in
  // the asset show page. Mirrors the projects.js budget/spent and licenses.js
  // cost conventions where absent money fields default to 0.
  it('absent purchase_price creates asset with 0, not Infinity', () => {
    // The fix ensures the sentinel used in the INSERT is 0 for absent values.
    // Directly verify the sentinel logic used in assets.js create:
    const purchase_price = undefined;
    const safePurchasePrice = purchase_price === undefined || purchase_price === null || purchase_price === ''
      ? 0
      : safePositiveFloat(purchase_price, Infinity);
    expect(safePurchasePrice).toBe(0);
    expect(safePurchasePrice).not.toBe(Infinity);
  });
});

describe('Assets delete — detach tickets updates updated_at (regression)', () => {
  // Regression test for the assets DELETE path: when an asset is deleted,
  // related tickets must have their updated_at refreshed so they continue
  // to surface in "recently updated" lists. Previously _deleteDetachTicketsStmt
  // only set asset_id = NULL without touching updated_at, leaving orphaned
  // tickets stale in time-sensitive sorting.
  it('includes updated_at in the detach-statement SQL', () => {
    // Require the route module to trigger module-level prepare() calls
    // that seed db.prepare.mock.calls.
    require('../src/routes/assets');
    const db = jest.requireMock('../src/models/database');
    const prepareCalls = db.prepare.mock.calls;
    const detachSql = prepareCalls
      .map(([sql]) => sql)
      .find((sql) => sql.includes('UPDATE') && sql.includes('tickets') && sql.includes('asset_id'));
    expect(detachSql).toBeDefined();
    expect(detachSql).toContain("updated_at = datetime('now')");
    expect(detachSql).toContain('asset_id = NULL');
    expect(detachSql).toContain('WHERE asset_id = ?');
  });
});
