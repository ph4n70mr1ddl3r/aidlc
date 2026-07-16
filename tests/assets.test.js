const { describe, it, expect } = require('@jest/globals');

const { isValidAssetTag, safePositiveFloat } = require('../src/utils');

describe('Asset tag validation', () => {
  it('accepts valid asset tags (AST-XXX)', () => {
    expect(isValidAssetTag('AST-001')).toBe(true);
    expect(isValidAssetTag('AST-999')).toBe(true);
    expect(isValidAssetTag('AST-123')).toBe(true);
  });

  it('rejects malformed asset tags', () => {
    expect(isValidAssetTag('AST-01')).toBe(false);
    expect(isValidAssetTag('AST-1234')).toBe(false);
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

  it('ASSET_TAG_RE matches the prefix and exactly 3 digits', () => {
    expect(ASSET_TAG_PREFIX).toBe('AST-');
    expect(ASSET_TAG_RE.test('AST-001')).toBe(true);
    expect(ASSET_TAG_RE.test('AST-999')).toBe(true);
    expect(ASSET_TAG_RE.test('AST-1234')).toBe(false);
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
