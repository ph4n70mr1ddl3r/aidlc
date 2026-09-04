const { describe, it, expect } = require('@jest/globals');
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');
const utils = require('../src/utils');
const constants = require('../src/constants');

// Regression tests for the 166th review pass. Defects closed:
// (1) database.js DB_PATH relative values were CWD-relative (second-DB risk);
// (2) safeId truncated floats (3.5 -> 3) while isPresentInvalidId rejects them;
// (3) parseBooleanFlag ignored JSON true/1 with success;
// (4) jest.setup locale pin dropped formatting options;
// (5) PAGE_SIZE clamp + SESSION_IDLE floor were silent (no warn);
// (6) projects/show.ejs exposed budget to non-privileged owners (index gates);
// (7) projects/show.ejs task hint impossible for staff + missing members empty-state;
// (8) tickets edit/update/quick-status ACCESS_DENIED redirected to detail (double denial);
// (9) knowledge edit/update ACCESS_DENIED redirected to detail (delete goes to list);
// (10) staff show checked access before existence (access_denied for missing id);
// (11) auth profile flash periods ("Current password is required", etc.);
// (12) middleware corrupt-uid redirect missed ?reason=session_expired;
// (13) nav flash icons + bulk decorative icons missing aria-hidden;
// (14) sidebar toggle missing aria-expanded/controls + Escape;
// (15) knowledge featured star/check missing accessible name;
// (16) dashboard workload + licenses usage progressbar labels lacked context;
// (17) licenses/show key display missing aria-live;
// (18) reports/assets double badgeClass + red-for-unknown;
// (19) badge fallbacks for nullable category/condition/type;
// (20) checkbox labels missing for/id;
// (21) reports/assets + dashboard workload missing empty-state hints.

function baseLocals() {
  return {
    user: { id: 1, first_name: 'Ada', last_name: 'Lovelace', role: 'admin', email: 'ada@company.com' },
    flash: { success: [], error: [], info: [] },
    currentPage: '/x',
    csrfToken: 'test-csrf-token',
    localDate: utils.localDate,
    formatDate: utils.formatDate,
    formatDateTime: utils.formatDateTime,
    daysUntil: utils.daysUntil,
    usagePercent: utils.usagePercent,
    isExpiringSoon: utils.isExpiringSoon,
    escapeHtml: utils.escapeHtml,
    isValidEmail: utils.isValidEmail,
    titleCase: utils.titleCase,
    isPrivileged: utils.isPrivileged,
    badgeClass: utils.badgeClass,
    CONDITION_BADGE: constants.CONDITION_BADGE,
    CHANGE_TYPE_BADGE: constants.CHANGE_TYPE_BADGE,
    ROLE_BADGE: constants.ROLE_BADGE,
    MEMBER_ROLE_BADGE: constants.MEMBER_ROLE_BADGE,
    KB_CATEGORY_BADGE: constants.KB_CATEGORY_BADGE,
    LICENSE_TYPE_BADGE: constants.LICENSE_TYPE_BADGE,
    CONSTANTS: constants
  };
}

function render(pageRel, locals) {
  const file = path.join(__dirname, '..', 'views', 'pages', pageRel);
  return ejs.render(fs.readFileSync(file, 'utf8'), locals, { filename: file });
}

function readSrc(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

describe('code review 166: consistency/completeness/correctness', () => {
  describe('database.js DB_PATH anchored to repo root', () => {
    it('resolves relative DB_PATH against the repo root', () => {
      const src = readSrc('src/models/database.js');
      expect(src).toContain('path.isAbsolute');
      expect(src).toContain(':memory:');
    });
  });

  describe('safeId rejects non-integer numbers', () => {
    it('returns null for floats', () => {
      expect(utils.safeId(3.5)).toBeNull();
      expect(utils.safeId(0.5)).toBeNull();
      expect(utils.safeId(456)).toBe(456);
    });
  });

  describe('parseBooleanFlag accepts JSON booleans/numbers', () => {
    it('maps true/1 to 1 when allowed', () => {
      expect(utils.parseBooleanFlag(true, true)).toBe(1);
      expect(utils.parseBooleanFlag(1, true)).toBe(1);
      expect(utils.parseBooleanFlag(false, true)).toBe(0);
      expect(utils.parseBooleanFlag(0, true)).toBe(0);
      expect(utils.parseBooleanFlag(true, false)).toBe(0);
    });
  });

  describe('jest.setup forwards Intl options', () => {
    it('passes options through to the native constructor', () => {
      const src = readSrc('jest.setup.js');
      expect(src).toContain('new NativeNumberFormat(\'en-US\', options)');
      expect(src).toContain('new NativeDateTimeFormat(\'en-US\', options)');
    });
  });

  describe('clamp/floor warnings', () => {
    it('warns when PAGE_SIZE is clamped', () => {
      expect(readSrc('src/utils.js')).toContain('exceeds max');
    });
    it('warns when idle timeout is raised to the 60s floor', () => {
      expect(readSrc('src/app.js')).toContain('write-throttle floor — raised to 60');
    });
  });

  describe('projects/show budget gated to privileged', () => {
    it('gates budget behind isPrivileged like index', () => {
      expect(readSrc('views/pages/projects/show.ejs')).toContain('isPrivileged(user) && project.budget');
    });
    it('does not render budget for staff owners', () => {
      const html = render('projects/show.ejs', {
        ...baseLocals(),
        user: { id: 2, first_name: 'S', last_name: 'T', role: 'staff' },
        project: { id: 1, name: 'P', status: 'planning', priority: 'medium', progress: 10, budget: 1000, spent: 100, owner_name: 'X' },
        tasks: [],
        members: []
      });
      expect(html).not.toContain('$1,000');
    });
  });

  describe('projects/show empty states', () => {
    it('shows a reachable task hint for staff', () => {
      const staffHtml = render('projects/show.ejs', {
        ...baseLocals(),
        user: { id: 2, first_name: 'S', last_name: 'T', role: 'staff' },
        project: { id: 1, name: 'P', status: 'planning', priority: 'medium', progress: 0 },
        tasks: [],
        members: []
      });
      expect(staffHtml).toContain('No tasks yet.');
      expect(staffHtml).not.toContain('No tasks yet. Add one above.');
      const adminHtml = render('projects/show.ejs', {
        ...baseLocals(),
        project: { id: 1, name: 'P', status: 'planning', priority: 'medium', progress: 0 },
        tasks: [],
        members: []
      });
      expect(adminHtml).toContain('No tasks yet. Add one above.');
    });
    it('renders a members empty-state', () => {
      expect(readSrc('views/pages/projects/show.ejs')).toContain('No team members yet.');
    });
  });

  describe('tickets/knowledge denial redirects go to the list', () => {
    it('tickets edit denial goes to /tickets', () => {
      const src = readSrc('src/routes/tickets.js');
      expect(src).toContain('Unauthorized edit attempt on ticket');
      // All three ACCESS_DENIED handlers must target the list (show would re-deny).
      const denied = src.split('ACCESS_DENIED').length - 1;
      expect(denied).toBeGreaterThanOrEqual(3);
      expect(src).not.toMatch(/Unauthorized edit attempt on ticket[\s\S]{0,200}return res\.redirect\(`\/tickets\/\$\{id\}`\)/);
    });
    it('knowledge edit/update denials go to /knowledge', () => {
      const src = readSrc('src/routes/knowledge.js');
      // Denial flashes must redirect to the list (show would re-deny for
      // non-owners on non-published articles). The sole remaining detail
      // redirect is the post-update success path (`Updated article`).
      expect(src).toContain('Unauthorized edit attempt on article');
      const detailRedirects = src.split('return res.redirect(`/knowledge/${id}`)').length - 1;
      expect(detailRedirects).toBe(1);
      expect(src).toContain('Updated article');
    });
  });

  describe('staff show fetch-first', () => {
    it('fetches before the privilege check and says "this staff member"', () => {
      const src = readSrc('src/routes/staff.js');
      expect(src).toContain('You do not have permission to view this staff member.');
      expect(src.indexOf('_showStaffStmt.get(id)')).toBeLessThan(src.indexOf('view this staff member'));
    });
  });

  describe('auth flash periods + middleware reason', () => {
    it('ends required-sentences with periods', () => {
      const src = readSrc('src/routes/auth.js');
      expect(src).toContain('Current password is required.');
      expect(src).toContain('New password is required.');
      expect(src).toContain('Password confirmation is required.');
    });
    it('corrupt uid redirects with reason=session_expired', () => {
      expect(readSrc('src/middleware/auth.js')).toContain('/login?reason=session_expired');
    });
  });

  describe('a11y: icons, sidebar, featured, progress labels, live region', () => {
    it('hides all decorative icons from AT', () => {
      const missing = [];
      const walk = (dir) => {
        for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, f.name);
          if (f.isDirectory()) {
            walk(p);
          } else if (f.name.endsWith('.ejs')) {
            const t = fs.readFileSync(p, 'utf8');
            const re = /<i class="(?:fas|far) [^"]*"[^>]*>/g;
            let m;
            while ((m = re.exec(t)) !== null) {
              if (!m[0].includes('aria-hidden')) {
                missing.push(`${p}: ${m[0]}`);
              }
            }
          }
        }
      };
      walk(path.join(__dirname, '..', 'views'));
      expect(missing).toEqual([]);
    });
    it('exposes sidebar toggle state + Escape', () => {
      expect(readSrc('views/partials/nav.ejs')).toContain('aria-expanded="false"');
      expect(readSrc('views/partials/nav.ejs')).toContain('aria-controls="sidebar"');
      expect(readSrc('public/js/app.js')).toContain('aria-expanded');
      expect(readSrc('public/js/app.js')).toContain('Escape');
    });
    it('gives the featured markers an accessible name', () => {
      const src = readSrc('views/pages/knowledge/index.ejs');
      expect(src).toContain('sr-only');
      expect(src).toContain('(featured)');
    });
    it('labels workload/usage bars with their subject', () => {
      expect(readSrc('views/pages/dashboard.ejs')).toContain('s.name %>: <%=');
      expect(readSrc('views/pages/licenses/index.ejs')).toContain('l.software_name %>: <%=');
    });
    it('announces license-key errors politely', () => {
      expect(readSrc('views/pages/licenses/show.ejs')).toContain('aria-live="polite"');
    });
    it('adds sr-only CSS + button focus-visible', () => {
      const css = readSrc('public/css/app.css');
      expect(css).toContain('.sr-only');
      expect(css).toContain('button:focus-visible');
    });
  });

  describe('reports/assets badge + empty states', () => {
    it('computes badgeClass once with a good fallback', () => {
      const src = readSrc('views/pages/reports/assets.ejs');
      expect(src).toContain('badgeClass(c.condition_rating || \'good\'');
      expect(src).not.toContain('badgeClass(c.condition_rating, CONDITION_BADGE) === \'low\' ? \'green\' : badgeClass');
    });
    it('renders empty hints for every section', () => {
      const src = readSrc('views/pages/reports/assets.ejs');
      expect(src).toContain('No data for this period');
      expect(readSrc('views/pages/dashboard.ejs')).toContain('No workload data');
    });
    it('falls back for nullable badge values', () => {
      expect(readSrc('views/pages/assets/index.ejs')).toContain('condition_rating || \'good\'');
      expect(readSrc('views/pages/knowledge/index.ejs')).toContain('a.category || \'other\'');
      expect(readSrc('views/pages/changes/index.ejs')).toContain('change_type || \'maintenance\'');
      expect(readSrc('views/pages/licenses/index.ejs')).toContain('license_type || \'perpetual\'');
    });
  });

  describe('checkbox labels carry for/id', () => {
    it('associates clear_key, is_featured, is_internal', () => {
      expect(readSrc('views/pages/licenses/form.ejs')).toContain('for="clear_key"');
      expect(readSrc('views/pages/knowledge/form.ejs')).toContain('for="is_featured"');
      expect(readSrc('views/pages/tickets/show.ejs')).toContain('for="is_internal"');
    });
  });

  describe('docs', () => {
    it('documents DB_PATH anchoring + idle fallback + PAGE_SIZE clamp warn', () => {
      const readme = readSrc('README.md');
      expect(readme).toContain('resolve against the repo root');
      expect(readme).toContain('invalid values fall back to `900`');
      expect(readme).toContain('clamped to `100` with a warning');
      expect(readSrc('.env.example')).toContain('resolve against the repo root');
    });
  });
});
