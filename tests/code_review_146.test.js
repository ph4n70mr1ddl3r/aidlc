const { describe, it, expect } = require('@jest/globals');
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');
const utils = require('../src/utils');
const constants = require('../src/constants');

// Regression tests for the 146th review pass: the 404 and error pages rendered
// an unconditional "Go to Dashboard" CTA. For an anonymous visitor (expired
// session, stale bookmark, or a failure thrown BEFORE the res.locals middleware
// ran — e.g. a body-parser 413/400), the link bounced through / to /login while
// claiming to go to the dashboard. Both pages now gate the CTA on the viewer:
// "Go to Dashboard" when signed in, "Go to Login" otherwise. `user` must be
// guarded with typeof — on the pre-middleware error path the local is genuinely
// undefined (not null), which would throw a ReferenceError at render time.

/**
 * Mirror of baseLocals() in templates.test.js, but with user OMITTED so each
 * test decides whether to inject one (or leave it undefined to simulate a
 * request that errored before res.locals was populated).
 */
function anonLocals() {
  return {
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

describe('code review 146: auth-gated CTA on 404/error pages', () => {
  const pages = ['404.ejs', 'error.ejs'];

  describe.each(pages)('%s', (page) => {
    it('renders "Go to Dashboard" for a signed-in visitor', () => {
      const html = render(page, {
        ...anonLocals(),
        user: { id: 1, first_name: 'Ada', last_name: 'Lovelace', role: 'admin' }
      });
      expect(html).toContain('Go to Dashboard');
      expect(html).toContain('href="/dashboard"');
      expect(html).not.toContain('Go to Login');
      expect(html).not.toContain('href="/login"');
    });

    it('renders "Go to Login" when user is explicitly null (anonymous)', () => {
      const html = render(page, { ...anonLocals(), user: null });
      expect(html).toContain('Go to Login');
      expect(html).toContain('href="/login"');
      expect(html).not.toContain('Go to Dashboard');
      expect(html).not.toContain('href="/dashboard"');
    });

    it('renders without crashing when user is undefined (pre-res.locals error path)', () => {
      // The global error handler can render these pages for failures thrown
      // BEFORE the res.locals middleware ran; `user` is then genuinely
      // undefined. An unguarded reference would throw a ReferenceError inside
      // the error handler itself.
      const html = render(page, anonLocals());
      expect(html).toContain('Go to Login');
      expect(html).not.toContain('Go to Dashboard');
    });

    it('never renders both CTAs at once', () => {
      const signedIn = render(page, {
        ...anonLocals(),
        user: { id: 1, first_name: 'A', last_name: 'B', role: 'staff' }
      });
      expect(signedIn).toMatch(/Go to Dashboard/);
      expect(signedIn).not.toMatch(/Go to Login/);
    });
  });
});
