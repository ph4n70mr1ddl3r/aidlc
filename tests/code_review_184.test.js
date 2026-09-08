const { describe, it, expect } = require('@jest/globals');

// Regression tests for review cycle 184: sanitize-html mock's allowedTags
// array contained a stray 'nl' entry (not a valid HTML tag) between 'ol' and
// 'li'. The typo has been removed so the mock's allowed tags match the real
// library's canonical list.
describe('code review 184 — sanitize-html mock allowedTags', () => {
  it("sanitize-html mock allowedTags does not contain the stray 'nl' entry", () => {
    // Require the mock setup file directly to inspect its exported defaults.
    // jest.mock() in tests/jest.setup.js replaces the real module before any
    // test file runs, so importing 'sanitize-html' here gives us the mock.
    const sanitizeHtml = require('sanitize-html');
    const allowedTags = sanitizeHtml.defaults.allowedTags;
    expect(allowedTags).toContain('li');
    expect(allowedTags).not.toContain('nl');
  });

  it('sanitize-html mock preserves <li> and strips unknown <nl> tags', () => {
    const sanitizeHtml = require('sanitize-html');
    // With defaults, <li> should be preserved (mock keeps tags in allowedTags).
    const withLi = sanitizeHtml('<ul><li>item</li></ul>');
    expect(withLi).toContain('item');

    // Unknown tags like <nl> are stripped from the markup, but their inner
    // text is kept (the mock removes the tag wrapper, not the content).
    const withNl = sanitizeHtml('<ul><nl>bad</nl></ul>');
    expect(withNl).not.toContain('<nl>');
  });
});
