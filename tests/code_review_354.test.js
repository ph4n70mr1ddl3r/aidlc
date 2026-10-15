const { describe, it, expect } = require('@jest/globals');
const fs = require('fs');
const path = require('path');
const constants = require('../src/constants');
const utils = require('../src/utils');

describe('code review 354 — hardening plateau verification', () => {
  // ---------------------------------------------------------------------------
  // 1. Badge mappings: every mapping covers its corresponding enum exactly.
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
    it(`every ${enumKey} value has an entry in ${badgeKey}`, () => {
      const badge = constants[badgeKey];
      for (const val of constants[enumKey]) {
        expect(Object.keys(badge)).toContain(val);
      }
    });

    it(`no extra keys in ${badgeKey} beyond ${enumKey}`, () => {
      const badge = constants[badgeKey];
      for (const key of Object.keys(badge)) {
        expect(constants[enumKey]).toContain(key);
      }
    });
  }

  it('IS_ACTIVE_BADGE covers exactly the two is_active values (0 and 1)', () => {
    const keys = Object.keys(constants.IS_ACTIVE_BADGE);
    expect(keys).toEqual(expect.arrayContaining(['0', '1']));
    expect(keys.length).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // 2. Audit allowlists: exact union of all emitted audit values.
  // ---------------------------------------------------------------------------
  function collectEmitted(patterns) {
    const srcDir = path.join(__dirname, '..', 'src');
    const emitted = new Set();
    function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.name.endsWith('.js')) {
          const content = fs.readFileSync(fullPath, 'utf8');
          for (const re of patterns) {
            for (const m of content.matchAll(re)) {
              emitted.add(m[1]);
            }
          }
        }
      }
    }
    walk(srcDir);
    return emitted;
  }

  it('ALLOWED_ACTIONS exactly matches all emitted audit actions', () => {
    const emitted = collectEmitted([
      /req\.audit\(\s*'([^']+)'/g,
      /action:\s*'([^']+)'/g
    ]);
    for (const action of emitted) {
      expect(constants.ALLOWED_ACTIONS).toContain(action);
    }
    for (const action of constants.ALLOWED_ACTIONS) {
      expect(emitted).toContain(action);
    }
  });

  it('ALLOWED_ENTITY_TYPES exactly matches all emitted audit entity types', () => {
    const emitted = collectEmitted([
      /entity:\s*'([^']+)'/g,
      /req\.audit\([^,]+,\s*'([^']+)'/g
    ]);
    for (const entity of emitted) {
      expect(constants.ALLOWED_ENTITY_TYPES).toContain(entity);
    }
    for (const entity of constants.ALLOWED_ENTITY_TYPES) {
      expect(emitted).toContain(entity);
    }
  });

  // ---------------------------------------------------------------------------
  // 3. Every export of constants.js and utils.js is referenced in src/ or tests/.
  // ---------------------------------------------------------------------------
  function walkText(dir, ext, out) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkText(fullPath, ext, out);
      } else if (fullPath.endsWith(ext)) {
        out.push(fs.readFileSync(fullPath, 'utf8'));
      }
    }
    return out;
  }

  it('every exported constant is referenced in src/ or tests/', () => {
    const hay = [...walkText(path.join(__dirname, '..', 'src'), '.js', []),
      ...walkText(path.join(__dirname), '.js', [])].join('\n');
    for (const key of Object.keys(constants)) {
      expect(hay).toContain(key);
    }
  });

  it('every exported utility is referenced in src/ or tests/', () => {
    const hay = [...walkText(path.join(__dirname, '..', 'src'), '.js', []),
      ...walkText(path.join(__dirname), '.js', [])].join('\n');
    for (const key of Object.keys(utils)) {
      if (key.startsWith('_')) {
        continue;
      }
      const re = new RegExp('\\b' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
      expect(hay).toMatch(re);
    }
  });

  // ---------------------------------------------------------------------------
  // 4. resetCachedStatements contract: all 15 core modules export it as a
  //    non-throwing function.
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
  // 5. No dangerous patterns in src/, views/, or public/.
  // ---------------------------------------------------------------------------
  it('no eval / new Function / innerHTML / document.write / javascript: URLs', () => {
    const dangerous = [/eval\s*\(/, /new\s+Function\s*\(/, /innerHTML/, /document\.write/, /javascript:/];
    const files = [...walkText(path.join(__dirname, '..', 'src'), '.js', []),
      ...walkText(path.join(__dirname, '..', 'views'), '.ejs', []),
      ...walkText(path.join(__dirname, '..', 'public'), '.js', [])];
    for (const content of files) {
      for (const re of dangerous) {
        expect(content).not.toMatch(re);
      }
    }
  });

  // ---------------------------------------------------------------------------
  // 6. Redirect and form-action safety.
  // ---------------------------------------------------------------------------
  it('all res.redirect() targets are same-origin pathnames', () => {
    for (const content of walkText(path.join(__dirname, '..', 'src'), '.js', [])) {
      for (const m of content.matchAll(/res\.redirect\(\s*['"]([^'"]+)['"]/g)) {
        const target = m[1];
        expect(target).not.toMatch(/^https?:\/\//);
        expect(target).not.toMatch(/^\/\//);
      }
    }
  });

  it('all form action URLs in EJS templates are relative', () => {
    for (const content of walkText(path.join(__dirname, '..', 'views'), '.ejs', [])) {
      for (const m of content.matchAll(/action="([^"]*)"/g)) {
        expect(m[1]).not.toMatch(/^https?:\/\//);
        expect(m[1]).not.toMatch(/^\/\//);
      }
    }
  });

  // ---------------------------------------------------------------------------
  // 7. HPP guards on every module that defines write routes.
  // ---------------------------------------------------------------------------
  it('all modules with POST/PUT/DELETE routes carry rejectHppArrays guards', () => {
    const routesDir = path.join(__dirname, '..', 'src', 'routes');
    for (const file of fs.readdirSync(routesDir).filter(f => f.endsWith('.js'))) {
      const content = fs.readFileSync(path.join(routesDir, file), 'utf8');
      if (/router\.(post|put|delete)\(/.test(content)) {
        expect(content).toContain('rejectHppArrays');
      }
    }
  });

  // ---------------------------------------------------------------------------
  // 8. Every process.env.* reference in src/ is documented in .env.example.
  // ---------------------------------------------------------------------------
  it('all source env vars are documented in .env.example', () => {
    const hay = walkText(path.join(__dirname, '..', 'src'), '.js', []).join('\n');
    const envVars = [...new Set([...hay.matchAll(/process\.env\.(\w+)/g)].map(m => m[1]))]
      .filter(v => !['cwd', 'env'].includes(v));
    const envExample = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
    for (const v of envVars) {
      expect(envExample).toMatch(new RegExp('\\b' + v + '\\b'));
    }
    // Count is pinned so adding an undocumented env var fails the build.
    expect(envVars.length).toBe(17);
  });

  // ---------------------------------------------------------------------------
  // 9. Unescaped EJS output is limited to include() and renderedContent.
  // ---------------------------------------------------------------------------
  it('all unescaped EJS outputs are include() calls or renderedContent', () => {
    for (const content of walkText(path.join(__dirname, '..', 'views'), '.ejs', [])) {
      for (const m of content.matchAll(/<%- ([^%]+) %>/g)) {
        const expr = m[1].trim();
        expect(['include', 'article.renderedContent'].some(allowed => expr === allowed || expr.startsWith('include(')))
          .toBe(true);
      }
    }
  });

  // ---------------------------------------------------------------------------
  // 10. try/catch structural balance across all source files.
  // ---------------------------------------------------------------------------
  it('all source files have balanced try/catch blocks', () => {
    for (const content of walkText(path.join(__dirname, '..', 'src'), '.js', [])) {
      const tries = (content.match(/\btry\s*\{/g) || []).length;
      const catches = (content.match(/(?<!\.)\bcatch\s*(\{|\()/g) || []).length;
      expect(tries).toBe(catches);
    }
  });

  // ---------------------------------------------------------------------------
  // 11. createAuditLogPruner uses the documented logger surface:
  //     logger.info on successful prunes, logger.error + logger.warn on
  //     first-run failures. Pinned after the JSDoc fix (the documented
  //     contract previously listed `log` which the code never calls).
  // ---------------------------------------------------------------------------
  it('createAuditLogPruner calls logger.info/error/warn exactly as documented', () => {
    const successful = jest.fn(() => 42);
    const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn() };
    const runPrune = utils.createAuditLogPruner(successful, { days: 365, logger });
    runPrune();
    expect(successful).toHaveBeenCalledWith(365);
    expect(logger.info).toHaveBeenCalledWith('Pruned 42 audit log entries older than 365 days');
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();

    const failing = jest.fn(() => {
      throw new Error('locked');
    });
    const failingLogger = { info: jest.fn(), error: jest.fn(), warn: jest.fn() };
    const runFailing = utils.createAuditLogPruner(failing, { days: 365, logger: failingLogger });
    runFailing();
    expect(failingLogger.error).toHaveBeenCalled();
    expect(failingLogger.warn).toHaveBeenCalledTimes(1);
    // Second failure no longer warns about the "initial" run.
    runFailing();
    expect(failingLogger.warn).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // 12. Changes create route defaults status to 'scheduled' when absent
  //     (pass 346 regression pin) and validates present enums fail-closed.
  // ---------------------------------------------------------------------------
  it('changes create defaults absent/empty status to the first enum value', () => {
    const changesSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'changes.js'), 'utf8');
    expect(changesSrc).toMatch(/const safeStatus = status \|\| 'scheduled';/);
    // The update route preserves the stored value on absent/empty status.
    expect(changesSrc).toMatch(/effectiveStatus = status \|\| existingChange\.status;/);
  });

  // ---------------------------------------------------------------------------
  // 13. Projects delete short-circuits on not-found inside its transaction
  //     (pass 346 regression pin) — mirrors every other entity delete route.
  // ---------------------------------------------------------------------------
  it('projects delete short-circuits on not-found before child deletions', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'projects.js'), 'utf8');
    const txn = src.match(/const deleteProject = db\.transaction\(\(\) => \{([\s\S]*?)\}\);/);
    expect(txn).not.toBeNull();
    // The not-found early return must precede the child-deletion statements.
    const earlyReturnIdx = txn[1].indexOf('return { changes: 0, name: null };');
    const deleteTasksIdx = txn[1].indexOf('_deleteProjectTasksStmt.run(id);');
    expect(earlyReturnIdx).toBeGreaterThan(-1);
    expect(deleteTasksIdx).toBeGreaterThan(earlyReturnIdx);
  });
});
