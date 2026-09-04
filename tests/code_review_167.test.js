const { describe, it, expect } = require('@jest/globals');
const fs = require('fs');
const path = require('path');

// Regression tests for the 167th review pass. Defects closed:
// (1) src/app.js exposed PATCH in _ALLOWED_METHODS/_WRITE_METHODS/_OVERRIDE_METHODS
//     despite no route handling it — dead surface and misleading;
// (2) views/pages/assets/form.ejs submitted a readonly asset_tag on create
//     (tamperable client-side) while backend ignores it and generates AST-xxx;
//     disabled + no name on create is correct;
// (3) src/models/database.js had close() above its _nativeClose binding
//     (TDZ-fragile even though deferred calls succeed);
// (4) eslint.config.js used '*.md' (top-level only) instead of '**/*.md';
// (5) .nvmrc was bare '20' (non-deterministic) vs engines matrix [20,22];
// (6) .env.example said idle timeout values below 60 are "silently" raised
//     while code now warns;
// (7) README.md still said bcrypt (not bcryptjs), lacked ci.yml in tree,
//     gitignore description incomplete, rate-limiting bullet narrow.
// (8) views/pages/projects/show.ejs had members empty-state inside a <select>
//     (invalid HTML).
// (9) CI workflow ran `npm test` (parallel workers contest on DB/ports)
//     without timeout/fail-fast/NODE_ENV:test/test:coverage.

function readSrc(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

describe('code review 167: consistency/completeness/correctness', () => {
  describe('PATCH removed from app.js method sets', () => {
    it('does not appear in _ALLOWED_METHODS/_WRITE_METHODS/_OVERRIDE_METHODS', () => {
      const src = readSrc('src/app.js');
      expect(src).toContain("const _ALLOWED_METHODS = 'GET, HEAD, POST, PUT, DELETE';");
      expect(src).toContain("new Set(['POST', 'PUT', 'DELETE'])");
      expect(src).toContain("new Set(['PUT', 'DELETE'])");
    });
  });

  describe('assets/form ejs uses disabled (not readonly) on create', () => {
    it('omits name attr when disabled and keeps required only on edit', () => {
      const src = readSrc('views/pages/assets/form.ejs');
      expect(src).toContain('disabled style=');
      expect(src).not.toContain('readonly');
    });
  });

  describe('database.js closes after binding _nativeClose', () => {
    it('declares _nativeClose before the close() wrapper', () => {
      const src = readSrc('src/models/database.js');
      const nativeIdx = src.indexOf('const _nativeClose = db.close.bind(db)');
      const closeIdx = src.indexOf('function close()');
      expect(nativeIdx).toBeGreaterThan(-1);
      expect(closeIdx).toBeGreaterThan(-1);
      expect(nativeIdx).toBeLessThan(closeIdx);
    });
  });

  describe('eslint ignores markdown recursively', () => {
    it('uses **/*.md rather than *.md', () => {
      const src = readSrc('eslint.config.js');
      expect(src).toContain("'**/*.md'");
      expect(src).not.toContain("'*.md'");
    });
  });

  describe('.nvmrc pinned to a specific release', () => {
    it('is not a bare major version', () => {
      const src = readSrc('.nvmrc').trim();
      expect(src).toMatch(/^\d+\.\d+\.\d+$/);
    });
  });

  describe('.env.example reflects the idle timeout warning', () => {
    it('says raised with a warning, not silently', () => {
      const src = readSrc('.env.example');
      expect(src).toContain('with a warning');
      expect(src).not.toContain('silently raised');
    });
  });

  describe('README reflects actual deps and structure', () => {
    it('references bcryptjs, not bcrypt', () => {
      const readme = readSrc('README.md');
      expect(readme).toContain('bcryptjs');
      expect(readme).not.toContain('with bcrypt ');
    });
    it('includes .github/workflows/ci.yml in the tree', () => {
      expect(readSrc('README.md')).toContain('ci.yml');
      expect(readSrc('README.md')).toContain('.github/workflows/');
    });
    it('lists the real repo clone URL', () => {
      expect(readSrc('README.md')).toContain('github.com/ph4n70mr1ddl3r/aidlc');
    });
    it('expands gitignore description beyond node_modules/data/.env/coverage', () => {
      const readme = readSrc('README.md');
      const line = readme.split('\n').find(l => l.includes('.gitignore') && l.includes('Ignores'));
      expect(line).toMatch(/\.db\*|certs|log/);
    });
  });

  describe('projects/show has no invalid HTML nesting', () => {
    it('does not place conditional text inside <select>', () => {
      const src = readSrc('views/pages/projects/show.ejs');
      // The old bug nested a paragraph inside the task-status select.
      // With the fix, the select closes before any conditional empty-state.
      const selectMatch = src.match(/<select name="status"[^>]*>[\s\S]*?<\/select>/);
      expect(selectMatch).toBeTruthy();
      const selectContent = selectMatch[0];
      expect(selectContent).not.toContain('No team members yet');
      // The empty-state should appear after the select in the Team card.
      const teamCard = src.match(/Team[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/);
      expect(teamCard).toBeTruthy();
      expect(teamCard[0]).toContain('No team members yet');
    });
  });

  describe('CI workflow uses test:coverage', () => {
    it('runs --runInBand --coverage with NODE_ENV=test and timeout', () => {
      const ci = readSrc('.github/workflows/ci.yml');
      expect(ci).toContain('test:coverage');
      expect(ci).toContain('NODE_ENV: test');
      expect(ci).toContain('timeout-minutes');
      expect(ci).toContain('fail-fast: false');
    });
  });
});
