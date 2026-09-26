const { describe, it, expect } = require('@jest/globals');
const fs = require('fs');
const path = require('path');
const constants = require('../src/constants');

describe('code review 220 — hardening plateau verification', () => {
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
  //    does not throw. Pinned separately from reset_cached_statements.test.js
  //    to keep it scoped to this review cycle's cross-module audit.
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
});
