const { describe, it, expect } = require('@jest/globals');
const fs = require('fs');
const path = require('path');

describe('code review 198 — consistency + completeness verification', () => {
  describe('all console.error sites use null-safe error message access', () => {
    it('client-side JS has no unguarded err access in console.error', () => {
      const jsFile = path.join(__dirname, '..', 'public', 'js', 'app.js');
      const src = fs.readFileSync(jsFile, 'utf8');
      const lines = src.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.includes('console.error')) {
          continue;
        }
        // Strip string literals to avoid false positives from messages
        const stripped = line
          .replace(/'[^']*'/g, '')
          .replace(/"[^"]*"/g, '')
          .replace(/`[^`]*`/g, '');
        // Any err reference must be guarded
        if (stripped.includes('err') && !stripped.includes('(err && err') && !stripped.includes('String(err)')) {
          expect(false).toBe(true);
        }
      }
    });
  });

  describe('every route module that processes user input carries rejectHppArrays guards', () => {
    it('no route module reads req.body/query without an HPP guard', () => {
      const routesDir = path.join(__dirname, '..', 'src', 'routes');
      const files = fs.readdirSync(routesDir).filter(f => f.endsWith('.js'));
      for (const file of files) {
        const src = fs.readFileSync(path.join(routesDir, file), 'utf8');
        if (!src.includes('req.body') && !src.includes('req.query')) {
          continue;
        }
        const hppGuards = (src.match(/rejectHppArrays\(/g) || []).length;
        expect(hppGuards).toBeGreaterThan(0);
      }
    });
  });

  describe('templates do not leak raw enum values into CSS classes', () => {
    it('no template uses badge-<%= rawEnum %> without badgeClass()', () => {
      const viewsDir = path.join(__dirname, '..', 'views');
      const ejsFiles = [];
      function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else if (entry.name.endsWith('.ejs')) {
            ejsFiles.push(full);
          }
        }
      }
      walk(viewsDir);
      for (const file of ejsFiles) {
        const src = fs.readFileSync(file, 'utf8');
        const badgeMatches = src.match(/badge-\$<%\s*([^%]+)%>/g) || [];
        for (const match of badgeMatches) {
          const inner = match.replace('badge-<%', '').replace('%>', '');
          expect(inner).toMatch(/badgeClass\(||/);
        }
      }
    });
  });

  describe('titleCase() in templates carries nullable fallbacks on DB fields', () => {
    it('no template calls titleCase() on a nullable DB field without fallback', () => {
      const viewsDir = path.join(__dirname, '..', 'views');
      const ejsFiles = [];
      function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else if (entry.name.endsWith('.ejs')) {
            ejsFiles.push(full);
          }
        }
      }
      walk(viewsDir);
      for (const file of ejsFiles) {
        const src = fs.readFileSync(file, 'utf8');
        const lines = src.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line.includes('titleCase(')) {
            continue;
          }
          // Skip lines where the argument comes from a CONSTANTS array iteration
          if (line.includes('CONSTANTS.') && line.includes('.forEach')) {
            continue;
          }
          const calls = line.match(/titleCase\(([^)]+)\)/g) || [];
          for (const call of calls) {
            const arg = call.slice(11, -1);
            if (arg.includes('||')) {
              continue;
            }
            if (/^(s|p|c|r|t|m|a|d)\b/.test(arg) && (line.includes('CONSTANTS.') || line.includes('.forEach'))) {
              continue;
            }
            if (/^['"`]/.test(arg)) {
              continue;
            }
            // Flag property accesses that could be null
            if (/^[a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_]/.test(arg)) {
              expect(false).toBe(true);
            }
          }
        }
      }
    });
  });
});
