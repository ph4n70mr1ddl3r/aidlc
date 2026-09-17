const { describe, it, expect } = require('@jest/globals');
const fs = require('fs');
const path = require('path');

describe('code review 209 — logError consistency across all route modules', () => {
  const ROUTE_FILES = [
    'src/routes/tickets.js',
    'src/routes/assets.js',
    'src/routes/projects.js',
    'src/routes/vendors.js',
    'src/routes/licenses.js',
    'src/routes/changes.js',
    'src/routes/dashboard.js',
    'src/routes/reports.js'
  ];

  it('all route modules import logError from utils', () => {
    for (const file of ROUTE_FILES) {
      const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
      expect(src).toContain("logError } = require('../utils')");
    }
  });

  it('no route module uses raw console.error with an err-like last argument', () => {
    const errLikePattern = /console\.error\([^)]*(?:err|innerErr)\)/;
    for (const file of ROUTE_FILES) {
      const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
      const lines = src.split('\n');
      for (const line of lines) {
        // Allow package-load-failure messages that embed the error in a larger
        // informational string (e.g. knowledge.js marked/sanitize-html fallbacks)
        if (line.includes('console.error') && errLikePattern.test(line)) {
          expect(line).toMatch(/npm install|Falling back|session store/i);
        }
      }
    }
  });

  it('middleware/auth.js uses logError, not raw console.error, for err logging', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'middleware', 'auth.js'),
      'utf8'
    );
    // Both error sites in destroySessionAndRedirect and _verifySessionUser must
    // use logError rather than the inline (err && err.message) || String(err)
    // pattern that was previously used.
    expect(src).not.toMatch(/console\.error\(errMsg.*String\(err\)\)/);
    expect(src).not.toMatch(/console\.error\('Session save error:'.*String\(err\)\)/);
    expect(src).toContain("logError(errMsg, err)");
    expect(src).toContain("logError('Session save error:', err)");
  });
});
