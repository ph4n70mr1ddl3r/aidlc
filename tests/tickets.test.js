const { describe, it, expect } = require('@jest/globals');

// Mock dependencies so the tickets route module loads in isolation.
jest.mock('../src/models/database', () => {
  const stmt = { get: jest.fn(() => null), all: jest.fn(() => []), run: jest.fn(() => ({ changes: 0 })) };
  return { prepare: jest.fn(() => stmt), exec: jest.fn(), pragma: jest.fn() };
});

jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => next(),
  requireAdminOrManager: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
  canAccessResource: jest.fn(() => true)
}));

jest.mock('../src/middleware/audit', () => ({
  audit: jest.fn(),
  auditMiddleware: (req, res, next) => {
    req.audit = jest.fn();
    next();
  }
}));

jest.mock('../src/routes/dashboard', () => {
  const Router = require('express').Router;
  const router = Router();
  router.invalidateDashboardCache = jest.fn();
  return router;
});

const { commentKeyGenerator, ensureLinkedAssetInList } = require('../src/routes/tickets');
const { ipKeyGenerator } = require('express-rate-limit');

describe('commentKeyGenerator', () => {
  it('keys by user id when authenticated (per-account limiting)', () => {
    const req = { session: { user: { id: 42 } }, ip: '1.2.3.4' };
    expect(commentKeyGenerator(req)).toBe('user:42');
  });

  it('falls back to IP key when not authenticated', () => {
    // Regression: previously called an undefined defaultKeyGenerator (removed in
    // express-rate-limit v8), which would throw if this branch ever ran.
    const req = { session: {}, ip: '203.0.113.5' };
    expect(commentKeyGenerator(req)).toBe(ipKeyGenerator('203.0.113.5'));
    expect(commentKeyGenerator(req)).toBe('203.0.113.5');
  });

  it('falls back when session is absent entirely', () => {
    const req = { ip: '198.51.100.7' };
    expect(() => commentKeyGenerator(req)).not.toThrow();
    expect(commentKeyGenerator(req)).toBe('198.51.100.7');
  });
});

describe('ensureLinkedAssetInList', () => {
  // Regression guard for the asset-dropdown cap: when the Related-Asset
  // <select> is bounded by _ASSET_DROPDOWN_LIMIT, a ticket linked to an asset
  // past the cap must still have that asset merged into the list — otherwise
  // it does not render as "selected" and re-saving silently unlinks it.
  it('prepends the linked asset when it is absent from the capped list', () => {
    const assets = [{ id: 1, asset_tag: 'AST-001', name: 'A' }, { id: 2, asset_tag: 'AST-002', name: 'B' }];
    const linked = { id: 1500, asset_tag: 'AST-1500', name: 'Beyond cap' };
    const result = ensureLinkedAssetInList(assets, linked);
    expect(result[0]).toBe(linked);
    expect(result).toHaveLength(3);
    // Original list is not mutated (immutable for the render context).
    expect(assets).toHaveLength(2);
  });

  it('returns the list unchanged when the linked asset is already present', () => {
    const assets = [{ id: 1, asset_tag: 'AST-001', name: 'A' }, { id: 2, asset_tag: 'AST-002', name: 'B' }];
    const result = ensureLinkedAssetInList(assets, assets[1]);
    expect(result).toBe(assets);
    expect(result).toHaveLength(2);
  });

  it('returns the list unchanged when there is no linked asset', () => {
    const assets = [{ id: 1, asset_tag: 'AST-001', name: 'A' }];
    expect(ensureLinkedAssetInList(assets, null)).toBe(assets);
    expect(ensureLinkedAssetInList(assets, undefined)).toBe(assets);
  });
});
