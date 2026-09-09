const { describe, it, expect } = require('@jest/globals');
const fs = require('fs');
const path = require('path');

function readSrc(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

describe('code review 190 — error logging null safety', () => {
  it('server error handler uses null-safe err.message access', () => {
    const src = readSrc('src/app.js');
    // The server error handler must not access err.message without a guard,
    // since catch blocks can receive non-Error values.
    expect(src).toContain("console.error('Server error:', (err && err.message) || String(err))");
  });

  it('idle connections close error handler uses null-safe err.message access', () => {
    const src = readSrc('src/app.js');
    expect(src).toContain("console.error('Error closing idle connections:', (err && err.message) || String(err))");
  });

  it('database close error handler uses null-safe err.message access', () => {
    const src = readSrc('src/app.js');
    expect(src).toContain("console.error('Error closing database:', (err && err.message) || String(err))");
  });
});
