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
const { renderMarkdown, resolveSafeFeatured } = require('../src/routes/knowledge');
const utils = require('../src/utils');

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

describe('resolveSafeFeatured (Featured checkbox)', () => {
  const admin = { role: 'admin' };
  const manager = { role: 'manager' };
  const staff = { role: 'staff' };

  // Regression: the "Featured article" checkbox used a hidden-field companion
  // (<input type="hidden" name="is_featured" value="0">) plus the checkbox
  // (value="1"). With express.urlencoded({ extended: false }) a checked box
  // submitted is_featured=0&is_featured=1, which parsed to ['0','1']. The
  // route ran that through safeQueryValue (first array element wins) -> '0',
  // so resolveSafeFeatured always returned 0 and the checkbox was unusable.
  // The form's hidden field was removed; resolveSafeFeatured must now correctly
  // resolve the plain checkbox value ('1' when checked, absent when not).
  it('enables featuring for a privileged user who checks the box (regression)', () => {
    // Simulate the route pipeline: safeQueryValue(req.body.is_featured) -> resolveSafeFeatured
    const checked = utils.safeQueryValue('1');
    expect(resolveSafeFeatured(admin, checked)).toBe(1);
    expect(resolveSafeFeatured(manager, checked)).toBe(1);
  });

  it('treats an unchecked (absent) box as not featured', () => {
    const unchecked = utils.safeQueryValue(undefined);
    expect(resolveSafeFeatured(admin, unchecked)).toBe(0);
  });

  it('never lets a non-privileged user set the featured flag', () => {
    expect(resolveSafeFeatured(staff, '1')).toBe(0);
    expect(resolveSafeFeatured(staff, undefined)).toBe(0);
    expect(resolveSafeFeatured(null, '1')).toBe(0);
  });

  it('rejects the legacy hidden-field "0" value', () => {
    // Defense-in-depth: even if a '0' leaks through, it must not feature.
    expect(resolveSafeFeatured(admin, '0')).toBe(0);
  });
});
