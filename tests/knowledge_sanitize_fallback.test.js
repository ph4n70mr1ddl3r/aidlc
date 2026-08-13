const { describe, it, expect } = require('@jest/globals');

// Force sanitize-html to fail loading so the module's fail-closed fallback path
// is exercised (stored-XSS defense-in-depth).
jest.mock('sanitize-html', () => {
  throw new Error('simulated load failure');
});

jest.mock('marked', () => ({
  marked: { parse: (content) => `<h1>${content}</h1>` },
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

// Suppress the module-load error logs from the fallback path so the suite output
// stays clean (module require happens at collection time, before beforeAll).
const origError = console.error;
console.error = jest.fn();

const { renderMarkdown } = require('../src/routes/knowledge');

afterAll(() => {
  console.error = origError;
});

describe('renderMarkdown sanitize-html fallback (fail-closed regression)', () => {
  it('escapes HTML instead of passing it through when sanitize-html fails to load', () => {
    // Regression: the fallback used to be a no-op (html => html), which would
    // turn renderMarkdown into a stored-XSS surface if sanitize-html were ever
    // missing/broken. It now escapes all output — mirroring the marked
    // fallback, which degrades to plain text.
    const html = renderMarkdown('# Heading');
    expect(html).not.toContain('<h1>');
    expect(html).toContain('&lt;h1&gt;');
  });
});
