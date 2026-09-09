const { describe, it, expect } = require('@jest/globals');
const fs = require('fs');
const path = require('path');

function readSrc(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

describe('code review 188 — consistency + a11y', () => {
  it('audit index action titleCase carries a null fallback', () => {
    const src = readSrc('views/pages/audit/index.ejs');
    expect(src).toContain("titleCase(e.action || 'unknown')");
  });

  it('license reveal button toggles aria-label on show', () => {
    const jsSrc = readSrc('public/js/app.js');
    // When revealing, the button's aria-label must switch to "Hide license key"
    expect(jsSrc).toContain("btn.setAttribute('aria-label', 'Hide license key')");
  });

  it('license reveal button restores aria-label on hide', () => {
    const jsSrc = readSrc('public/js/app.js');
    // When hiding, the button's aria-label must restore to "Reveal license key"
    expect(jsSrc).toContain("btn.setAttribute('aria-label', 'Reveal license key')");
  });
});
