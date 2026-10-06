const { describe, it, expect } = require('@jest/globals');
const fs = require('fs');
const path = require('path');
const constants = require('../src/constants');
const utils = require('../src/utils');

describe('code review 299 — hardening plateau verification', () => {
  // ---------------------------------------------------------------------------
  // 1. Badge mappings: every mapping covers its corresponding enum exactly —
  //    no missing keys (would silently fall back to 'medium') and no extra keys
  //    (would be dead code). Mirrors the automated cross-reference in the
  //    review cycle.
  // ---------------------------------------------------------------------------
  const badgeEnumPairs = Object.freeze([
    ['CONDITION_BADGE', 'ASSET_CONDITIONS'],
    ['CHANGE_TYPE_BADGE', 'CHANGE_TYPES'],
    ['ROLE_BADGE', 'USER_ROLES'],
    ['MEMBER_ROLE_BADGE', 'MEMBER_ROLES'],
    ['KB_CATEGORY_BADGE', 'KB_CATEGORIES'],
    ['LICENSE_TYPE_BADGE', 'LICENSE_TYPES'],
    ['TICKET_STATUS_BADGE', 'TICKET_STATUSES'],
    ['TICKET_PRIORITY_BADGE', 'TICKET_PRIORITIES'],
    ['ASSET_STATUS_BADGE', 'ASSET_STATUSES'],
    ['PROJECT_STATUS_BADGE', 'PROJECT_STATUSES'],
    ['PROJECT_PRIORITY_BADGE', 'PROJECT_PRIORITIES'],
    ['TASK_PRIORITY_BADGE', 'TASK_PRIORITIES'],
    ['CHANGE_STATUS_BADGE', 'CHANGE_STATUSES'],
    ['CHANGE_PRIORITY_BADGE', 'CHANGE_PRIORITIES'],
    ['KB_STATUS_BADGE', 'KB_STATUSES'],
    ['VENDOR_CATEGORY_BADGE', 'VENDOR_CATEGORIES']
  ]);

  for (const [badgeKey, enumKey] of badgeEnumPairs) {
    it(`every ${enumKey} value has a entry in ${badgeKey}`, () => {
      const badge = constants[badgeKey];
      const enumVals = constants[enumKey];
      const badgeKeys = Object.keys(badge);
      for (const val of enumVals) {
        expect(badgeKeys).toContain(val);
      }
    });

    it(`no extra keys in ${badgeKey} beyond ${enumKey}`, () => {
      const badge = constants[badgeKey];
      const enumVals = constants[enumKey];
      const badgeKeys = Object.keys(badge);
      for (const key of badgeKeys) {
        expect(enumVals).toContain(key);
      }
    });
  }

  // IS_ACTIVE_BADGE uses numeric keys (0/1) rather than string enum values,
  // so it cannot be checked with the same badgeEnumPairs loop above. Verify
  // it explicitly so the guarantee is testable, not just asserted by hand.
  it('IS_ACTIVE_BADGE covers exactly the two is_active values (0 and 1)', () => {
    const badge = constants.IS_ACTIVE_BADGE;
    const keys = Object.keys(badge);
    expect(keys).toEqual(expect.arrayContaining(['0', '1']));
    expect(keys.length).toBe(2);
    expect(badge[0]).toBe('medium');
    expect(badge[1]).toBe('low');
  });

  // ---------------------------------------------------------------------------
  // 2. Template badgeClass() calls: every reference in EJS templates resolves
  //    to an existing constant mapping — no typos or stale keys can slip
  //    through to produce `badge-badge-<unknown>` CSS classes.
  // ---------------------------------------------------------------------------
  it('every badgeClass() call in EJS templates references an existing constant mapping', () => {
    const viewsDir = path.join(__dirname, '..', 'views');
    const badgeMappings = new Set(
      Object.keys(constants).filter(k => k.endsWith('_BADGE'))
    );

    function walkEjs(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkEjs(fullPath);
        } else if (entry.name.endsWith('.ejs')) {
          const content = fs.readFileSync(fullPath, 'utf8');
          const regex = /badgeClass\([^,]+,\s*(\w+_BADGE)\)/g;
          let match;
          while ((match = regex.exec(content)) !== null) {
            expect(badgeMappings).toContain(match[1]);
          }
        }
      }
    }
    walkEjs(viewsDir);
  });

  // ---------------------------------------------------------------------------
  // 3. Audit action allowlist: ALLOWED_ACTIONS is the exact union of all
  //    actions emitted across the codebase — no gaps (would throw on first
  //    use) and no dead entries.
  // ---------------------------------------------------------------------------
  it('ALLOWED_ACTIONS exactly matches all emitted audit actions', () => {
    const srcDir = path.join(__dirname, '..', 'src');
    const emitted = new Set();

    function walkSrc(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkSrc(fullPath);
        } else if (entry.name.endsWith('.js')) {
          const content = fs.readFileSync(fullPath, 'utf8');
          const reqMatches = content.matchAll(/req\.audit\(\s*'([^']+)'/g);
          for (const m of reqMatches) {
            emitted.add(m[1]);
          }
          const directMatches = content.matchAll(/action:\s*'([^']+)'/g);
          for (const m of directMatches) {
            emitted.add(m[1]);
          }
        }
      }
    }
    walkSrc(srcDir);

    const allowed = new Set(constants.ALLOWED_ACTIONS);
    for (const action of emitted) {
      expect(allowed).toContain(action);
    }
    for (const action of allowed) {
      expect(emitted).toContain(action);
    }
  });

  // ---------------------------------------------------------------------------
  // 4. Audit entity-type allowlist: ALLOWED_ENTITY_TYPES is the exact union
  //    of all entity values emitted across the codebase.
  // ---------------------------------------------------------------------------
  it('ALLOWED_ENTITY_TYPES exactly matches all emitted audit entity types', () => {
    const srcDir = path.join(__dirname, '..', 'src');
    const emitted = new Set();

    function walkSrc(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkSrc(fullPath);
        } else if (entry.name.endsWith('.js')) {
          const content = fs.readFileSync(fullPath, 'utf8');
          const entityMatches = content.matchAll(/entity:\s*'([^']+)'/g);
          for (const m of entityMatches) {
            emitted.add(m[1]);
          }
          const reqEntityMatches = content.matchAll(/req\.audit\([^,]+,\s*'([^']+)'/g);
          for (const m of reqEntityMatches) {
            emitted.add(m[1]);
          }
        }
      }
    }
    walkSrc(srcDir);

    const allowed = new Set(constants.ALLOWED_ENTITY_TYPES);
    for (const entity of emitted) {
      expect(allowed).toContain(entity);
    }
    for (const entity of allowed) {
      expect(emitted).toContain(entity);
    }
  });

  // ---------------------------------------------------------------------------
  // 5. resetCachedStatements API contract: all 15 modules (12 routes + 2
  //    middleware + utils) export resetCachedStatements as a function that
  //    does not throw.
  // ---------------------------------------------------------------------------
  it('all 15 core modules export resetCachedStatements', () => {
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
      'src/routes/vendors',
      'src/utils'
    ];

    for (const modPath of modules) {
      const mod = require('../' + modPath);
      expect(typeof mod.resetCachedStatements).toBe('function');
      expect(() => mod.resetCachedStatements()).not.toThrow();
    }
  });

  // ---------------------------------------------------------------------------
  // 6. Try/catch balance: every try block in source has a matching catch.
  //    Unbalanced blocks indicate error paths that could leak unhandled
  //    exceptions to the caller instead of being caught and logged.
  // ---------------------------------------------------------------------------
  it('all source files have balanced try/catch blocks', () => {
    const srcDir = path.join(__dirname, '..', 'src');
    const entries = fs.readdirSync(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(srcDir, entry.name);
      if (entry.isDirectory()) {
        // Recurse into subdirectories
        const subEntries = fs.readdirSync(fullPath, { withFileTypes: true });
        for (const sub of subEntries) {
          const subPath = path.join(fullPath, sub.name);
          if (sub.name.endsWith('.js')) {
            const content = fs.readFileSync(subPath, 'utf8');
            const tries = (content.match(/\btry\s*\{/g) || []).length;
            // Match `catch` as a statement keyword, not as a method call like `.catch()`.
            // Use a negative lookbehind to exclude `.catch(` patterns.
            // `catch (` or `catch {` are the only valid forms of a catch clause in JS.
            const catches = (content.match(/(?<!\.)\bcatch\s*(\{|\()/g) || []).length;
            expect(tries).toBe(catches);
          }
        }
      } else if (entry.name.endsWith('.js')) {
        const content = fs.readFileSync(fullPath, 'utf8');
        const tries = (content.match(/\btry\s*\{/g) || []).length;
        // Match `catch` as a statement keyword, not as a method call like `.catch()`.
        // Use a negative lookbehind to exclude `.catch(` patterns.
        // `catch (` or `catch {` are the only valid forms of a catch clause in JS.
        const catches = (content.match(/(?<!\.)\bcatch\s*(\{|\()/g) || []).length;
        expect(tries).toBe(catches);
      }
    }
  });

  // ---------------------------------------------------------------------------
  // 7. No dangerous patterns: no eval(), new Function(), innerHTML,
  //    document.write, or javascript: URLs in source or views.
  // ---------------------------------------------------------------------------
  it('no dangerous patterns (eval, new Function, innerHTML, document.write, javascript:)', () => {
    const dangerousPatterns = [
      { regex: /eval\s*\(/, desc: 'eval()' },
      { regex: /new\s+Function\s*\(/, desc: 'new Function()' }
    ];
    const srcDir = path.join(__dirname, '..', 'src');
    function walkSrc(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkSrc(fullPath);
        } else if (entry.name.endsWith('.js')) {
          const content = fs.readFileSync(fullPath, 'utf8');
          for (const p of dangerousPatterns) {
            expect(content).not.toMatch(p.regex);
          }
        }
      }
    }
    walkSrc(srcDir);

    // Check views for HTML-injection patterns
    const viewsDir = path.join(__dirname, '..', 'views');
    function walkViews(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkViews(fullPath);
        } else if (entry.name.endsWith('.ejs')) {
          const content = fs.readFileSync(fullPath, 'utf8');
          expect(content).not.toMatch(/innerHTML/);
          expect(content).not.toMatch(/document\.write/);
          expect(content).not.toMatch(/javascript:/);
        }
      }
    }
    walkViews(viewsDir);

    // Check public JS
    const publicJs = path.join(__dirname, '..', 'public', 'js', 'app.js');
    if (fs.existsSync(publicJs)) {
      const content = fs.readFileSync(publicJs, 'utf8');
      for (const p of dangerousPatterns) {
        expect(content).not.toMatch(p.regex);
      }
      expect(content).not.toMatch(/innerHTML/);
      expect(content).not.toMatch(/document\.write/);
      expect(content).not.toMatch(/javascript:/);
    }
  });

  // ---------------------------------------------------------------------------
  // 8. All redirects are same-origin: no open-redirect vectors via
  //    res.redirect() with absolute URLs.
  // ---------------------------------------------------------------------------
  it('all res.redirect() targets are same-origin pathnames', () => {
    const srcDir = path.join(__dirname, '..', 'src');
    function walkSrc(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkSrc(fullPath);
        } else if (entry.name.endsWith('.js')) {
          const content = fs.readFileSync(fullPath, 'utf8');
          const matches = [...content.matchAll(/res\.redirect\(\s*['"]([^'"]+)['"]/g)];
          for (const m of matches) {
            const target = m[1];
            // Relative paths (starting with / or .) are safe
            if (target.startsWith('/') || target.startsWith('.')) {
              continue;
            }
            // Absolute URLs must be same-origin
            expect(target).not.toMatch(/^https?:\/\//);
            expect(target).not.toMatch(/^\/\//);
          }
        }
      }
    }
    walkSrc(srcDir);
  });

  // ---------------------------------------------------------------------------
  // 9. All form action URLs are relative (no absolute URLs in EJS forms).
  // ---------------------------------------------------------------------------
  it('all form action URLs in EJS templates are relative', () => {
    const viewsDir = path.join(__dirname, '..', 'views');
    function walkViews(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkViews(fullPath);
        } else if (entry.name.endsWith('.ejs')) {
          const content = fs.readFileSync(fullPath, 'utf8');
          const matches = [...content.matchAll(/action="([^"]*)"/g)];
          for (const m of matches) {
            const action = m[1];
            expect(action).not.toMatch(/^https?:\/\//);
            expect(action).not.toMatch(/^\/\//);
          }
        }
      }
    }
    walkViews(viewsDir);
  });

  // ---------------------------------------------------------------------------
  // 10. Every exported constant from constants.js is referenced in at least
  //     one source file (route, middleware, or model). Dead exports increase
  //     maintenance burden and may indicate stale documentation.
  // ---------------------------------------------------------------------------
  it('every exported constant is referenced in source code', () => {
    const srcDir = path.join(__dirname, '..', 'src');
    const allSrc = [];
    function walkSrc(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkSrc(fullPath);
        } else if (entry.name.endsWith('.js')) {
          allSrc.push(fs.readFileSync(fullPath, 'utf8'));
        }
      }
    }
    walkSrc(srcDir);
    const combined = allSrc.join('\n');
    for (const key of Object.keys(constants)) {
      expect(combined).toContain(key);
    }
  });

  // ---------------------------------------------------------------------------
  // 11. Every exported utility from utils.js is referenced in at least one
  //     source file. Mirrors the constant-reference check above.
  // ---------------------------------------------------------------------------
  it('every exported utility is referenced in source code', () => {
    const srcDir = path.join(__dirname, '..', 'src');
    const allSrc = [];
    function walkSrc(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkSrc(fullPath);
        } else if (entry.name.endsWith('.js')) {
          allSrc.push(fs.readFileSync(fullPath, 'utf8'));
        }
      }
    }
    walkSrc(srcDir);
    const combined = allSrc.join('\n');
    for (const key of Object.keys(utils)) {
      if (key.startsWith('_')) {
        continue;
      }
      // Exported names may appear as imports, function calls, or property access
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(
        '(?:\\b' + escaped + '\\s*\\(|\\b' + escaped + '\\b.*=|require\\([^)]+\\).*\\.' + escaped + '\\b)'
      );
      expect(combined).toMatch(pattern);
    }
  });

  // ---------------------------------------------------------------------------
  // 12. All write routes (POST/PUT/DELETE) carry rejectHppArrays guards.
  //     Missing guards on write routes is a regression vector for HTTP
  //     parameter pollution attacks.
  // ---------------------------------------------------------------------------
  it('all write routes have rejectHppArrays guards', () => {
    const routesDir = path.join(__dirname, '..', 'src', 'routes');
    const files = fs.readdirSync(routesDir).filter(f => f.endsWith('.js'));
    for (const file of files) {
      const content = fs.readFileSync(path.join(routesDir, file), 'utf8');
      const hasWrite = /router\.(post|put|delete)\(/.test(content);
      if (hasWrite) {
        expect(content).toContain('rejectHppArrays');
      }
    }
  });

  // ---------------------------------------------------------------------------
  // 13. All environment variables used in source code are documented in
  //     .env.example (either commented or uncommented).
  // ---------------------------------------------------------------------------
  it('all source env vars are documented in .env.example', () => {
    const srcDir = path.join(__dirname, '..', 'src');
    const allSrc = [];
    function walkSrc(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkSrc(fullPath);
        } else if (entry.name.endsWith('.js')) {
          allSrc.push(fs.readFileSync(fullPath, 'utf8'));
        }
      }
    }
    walkSrc(srcDir);
    const combined = allSrc.join('\n');
    const envVars = [...new Set([...combined.matchAll(/process\.env\.(\w+)/g)].map(m => m[1]))]
      .filter(v => !['cwd', 'env'].includes(v));

    const envExample = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
    for (const v of envVars) {
      // The var name should appear somewhere in .env.example (as a variable
      // definition or in a comment explaining it)
      const varPattern = new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      expect(envExample).toMatch(varPattern);
    }
  });
});
