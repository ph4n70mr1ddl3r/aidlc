const { describe, it, expect } = require('@jest/globals');

// Regression test: every module in src/routes/ and src/middleware/ must export
// resetCachedStatements so tests can isolate state between suites. Forgetting
// the export causes cached prepared statements from one test to leak into the
// next, producing flaky failures that are hard to diagnose. This test acts as
// an API-contract guard — if a new module is added without the export, the
// suite fails immediately rather than at runtime in an unrelated test.
describe('resetCachedStatements API contract', () => {
  const modules = [
    'src/middleware/audit',
    'src/middleware/auth',
    'src/routes/assets',
    'src/routes/audit',
    'src/routes/auth',
    'src/routes/changes',
    'src/routes/dashboard',
    'src/routes/knowledge',
    'src/routes/licenses',
    'src/routes/projects',
    'src/routes/reports',
    'src/routes/staff',
    'src/routes/tickets',
    'src/routes/vendors'
  ];

  for (const modPath of modules) {
    it(`${modPath} exports resetCachedStatements as a function`, () => {
      const mod = require(`../${modPath}`);
      expect(typeof mod.resetCachedStatements).toBe('function');
      expect(() => mod.resetCachedStatements()).not.toThrow();
    });
  }
});
