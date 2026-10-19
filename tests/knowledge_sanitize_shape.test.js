const { describe, it, expect } = require('@jest/globals');

// Pass 362 regression: when the sanitize-html module LOADS successfully but in
// an unexpected shape (e.g. someone rewrites the interop wrapper and returns
// a non-sanitizer object), the loader must fail closed — it must NOT silently
// fall back to the identity function, which would turn renderMarkdown into a
// stored-XSS surface.
jest.mock('sanitize-html', () => ({ unexpectedShape: true }));

jest.mock('marked', () => ({
  parse: (content) => `<h1>${content}</h1>`
}));

jest.mock('../src/models/database', () => {
  const stmt = { get: jest.fn(() => null), all: jest.fn(() => []), run: jest.fn(() => ({ changes: 0 })) };
  return { prepare: jest.fn(() => stmt), exec: jest.fn(), pragma: jest.fn(), transaction: jest.fn((fn) => fn) };
});

jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => next(),
  requireAdminOrManager: (req, res, next) => next()
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

// Capture console.error so we can assert the "unexpected shape" was reported.
const origError = console.error;
console.error = jest.fn();

describe('sanitize-html loader fail-closed shape check (pass 362)', () => {
  it('throws at module load when the module shape is not a known sanitizer', () => {
    expect(() => require('../src/routes/knowledge')).toThrow(/unexpected sanitize-html shape/);
  });

  it('reports the shape error via the console before throwing', () => {
    const allLogs = console.error.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allLogs).toContain('unexpected shape');
  });
});

afterAll(() => {
  console.error = origError;
});
