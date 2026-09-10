const { describe, it, expect } = require('@jest/globals');
const { lastHandlerFor } = require('./helpers');

// Regression tests for review cycle 194: two consistency defects closed on the
// 193rd-pass codebase — (1) _commentExistsStmt in tickets.js still selected the
// unused assigned_to column (a dead-column drift from the described cycle-179
// fix that was never actually applied), and (2) auth.js used "Invalid Username
// Or Password" instead of the app-wide "Invalid <Credential>" title-case
// convention. Both are pinned so future drift cannot reintroduce them.
describe('code review 194 — comment-exists dead column + auth error-message consistency', () => {
  describe('_commentExistsStmt has no unused assigned_to column', () => {
    it('source contains only id in the SELECT clause', () => {
      const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'routes', 'tickets.js'), 'utf8');
      // The statement is a single-line template literal; match it including
      // the surrounding quotes rather than relying on backtick interpolation.
      const match = src.match(/const _commentExistsStmt = db\.prepare\('([^']+)'\)/);
      expect(match).toBeDefined();
      const sql = match[1];
      expect(sql).toMatch(/\bSELECT\s+id\b/);
      expect(sql).not.toMatch(/\bassigned_to\b/);
    });
  });

  describe('auth login error messages follow the Invalid <Credential> convention', () => {
    it('source does not contain the old spaced-conjunction message', () => {
      const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'routes', 'auth.js'), 'utf8');
      expect(src).not.toContain('Invalid Username Or Password');
    });

    it('source uses the consistent Invalid Login Credentials message', () => {
      const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'routes', 'auth.js'), 'utf8');
      const count = (src.match(/Invalid Login Credentials/g) || []).length;
      expect(count).toBeGreaterThanOrEqual(3);
    });

    it('rejects a wrong password with the consistent error message', async () => {
      jest.isolateModules(async () => {
        const bcrypt = require('bcryptjs');
        const compareSpy = jest.spyOn(bcrypt, 'compare').mockResolvedValue(false);

        const db = jest.requireMock('../src/models/database');
        db.prepare.mockImplementation((sql) => {
          if (sql.includes('FROM users WHERE username')) {
            return { get: () => ({ id: 1, username: 'admin', password: '$2a$12$fake', is_active: 1, role: 'admin' }) };
          }
          return { get: () => null, all: () => [], run: () => ({ changes: 1 }) };
        });

        let redirectedTo = null;
        const flashCalls = [];
        const req = {
          body: { username: 'admin', password: 'wrongpassword' },
          params: {},
          method: 'POST',
          ip: '203.0.113.5',
          session: { regenerate: (cb) => cb() },
          flash: (type, msg) => flashCalls.push([type, msg])
        };
        const res = {
          redirect: (to) => {
            redirectedTo = to;
          },
          render: () => {},
          status: () => res,
          json: () => {}
        };
        const authRouter = require('../src/routes/auth');
        const handler = lastHandlerFor(authRouter, 'post', '/login');
        await handler(req, res, () => {});
        // asyncHandler's wrapper does not return the inner async handler's promise,
        // so awaiting the wrapper alone resumes before the handler finishes (its
        // continuation is queued as a microtask). Flush the microtask queue so
        // post-await redirects/flashes are observable.
        await new Promise((resolve) => setImmediate(resolve));
        expect(redirectedTo).toBe('/login');
        expect(flashCalls.some(([t, m]) => t === 'error' && m === 'Invalid Login Credentials')).toBe(true);
        compareSpy.mockRestore();
      });
    });
  });
});
