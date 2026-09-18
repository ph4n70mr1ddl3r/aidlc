const { describe, it, expect } = require('@jest/globals');
const fs = require('fs');
const path = require('path');

describe('code review 214 — audit entity type completeness', () => {
  it('reports.js audit entity types are all in ALLOWED_ENTITY_TYPES', () => {
    const { ALLOWED_ENTITY_TYPES } = require('../src/constants');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'routes', 'reports.js'),
      'utf8'
    );
    // Extract all entity types used in req.audit() calls
    const matches = src.matchAll(/req\.audit\(\s*'([^']*)',\s*'([^']*)'/g);
    const entityTypes = [...new Set([...matches].map(m => m[2]))];
    for (const entity of entityTypes) {
      expect(ALLOWED_ENTITY_TYPES).toContain(entity);
    }
  });

  it('constants.js ALLOWED_ENTITY_TYPES includes report', () => {
    const { ALLOWED_ENTITY_TYPES } = require('../src/constants');
    expect(ALLOWED_ENTITY_TYPES).toContain('report');
  });

  it('all route modules use only valid audit entity types', () => {
    const { ALLOWED_ENTITY_TYPES, ALLOWED_ACTIONS } = require('../src/constants');
    const routesDir = path.join(__dirname, '..', 'src', 'routes');
    const files = fs.readdirSync(routesDir).filter(f => f.endsWith('.js'));
    for (const file of files) {
      const src = fs.readFileSync(path.join(routesDir, file), 'utf8');
      const lines = src.split('\n');
      for (const line of lines) {
        const m = line.match(/req\.audit\(\s*'([^']*)',\s*'([^']*)'/);
        if (m) {
          const [, action, entity] = m;
          expect(ALLOWED_ACTIONS).toContain(action);
          expect(ALLOWED_ENTITY_TYPES).toContain(entity);
        }
      }
    }
  });
});
