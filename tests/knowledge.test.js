const { describe, it, expect, beforeEach } = require('@jest/globals');

// marked v18 ships ESM-only; jest's CJS runtime cannot `require()` it (production
// works because Node 22+ supports `require(esm)`). Mock it to mirror the real v18
// API surface — exposing `.parse` but NOT `.parseSync` (which never existed in v18).
// This is precisely the regression: before the fix the code called `.parseSync`,
// hit the TypeError, and fell back to the plain-text error notice.
jest.mock('marked', () => {
  const mockParse = jest.fn((content) => {
    if (content === '__THROW__') {
      throw new Error('boom');
    }
    // Minimal transform mirroring real marked output for the tested syntax.
    let html = content;
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/`(.+?)`/g, '<code>$1</code>');
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>');
    html = html.replace(/- \[x\] (.+)/g, '<ul><li><input checked disabled type="checkbox"> $1</li></ul>');
    return html;
  });
  return { marked: { parse: mockParse }, parse: mockParse };
});

// Mock the heavy/route dependencies so the module loads in isolation.
// `sanitize-html` is left REAL so the sanitization pipeline is exercised.
jest.mock('../src/models/database', () => {
  const stmt = { get: jest.fn(() => null), all: jest.fn(() => []), run: jest.fn(() => ({ changes: 0 })) };
  return { prepare: jest.fn(() => stmt), exec: jest.fn(), pragma: jest.fn() };
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

const { marked } = require('marked');
const { renderMarkdown } = require('../src/routes/knowledge');

describe('renderMarkdown', () => {
  beforeEach(() => {
    marked.parse.mockClear();
  });

  it('renders markdown to sanitized HTML via marked.parse (regression: parseSync was removed in v18)', () => {
    const html = renderMarkdown('# Heading\n\n**bold** and `code`');
    expect(marked.parse).toHaveBeenCalledTimes(1);
    expect(html).toContain('<h1>Heading</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code</code>');
    // Must NOT fall through to the error-notice fallback path.
    expect(html).not.toContain('could not be rendered');
  });

  it('renders GitHub task list checkboxes', () => {
    const html = renderMarkdown('- [x] done');
    expect(html).toContain('<input');
    expect(html).toMatch(/checked/i);
  });

  it('returns empty string for empty / non-string input (and does not call marked)', () => {
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown(null)).toBe('');
    expect(renderMarkdown(undefined)).toBe('');
    expect(renderMarkdown(123)).toBe('');
    expect(marked.parse).not.toHaveBeenCalled();
  });

  it('strips dangerous markup (script tags and inline event handlers)', () => {
    const html = renderMarkdown('<script>alert(1)</script>\n<img src="x.png" onerror="alert(1)">');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror');
    expect(html).not.toMatch(/javascript:/i);
  });

  it('forces rel="noopener noreferrer" on links (tabnabbing defense)', () => {
    const html = renderMarkdown('[example](https://example.com)');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('falls back to a plain-text notice when rendering throws', () => {
    const html = renderMarkdown('__THROW__');
    expect(html).toContain('could not be rendered');
  });
});
