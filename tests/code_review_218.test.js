const { describe, it, expect } = require('@jest/globals');
const fs = require('fs');
const path = require('path');
const constants = require('../src/constants');

describe('code review 218 — ACTION_BADGE consistency', () => {
  it('constants.js exports ACTION_BADGE', () => {
    expect(constants.ACTION_BADGE).toBeDefined();
    expect(Array.isArray(constants.ACTION_BADGE) === false).toBe(true);
    expect(typeof constants.ACTION_BADGE).toBe('object');
  });

  it('ACTION_BADGE maps security-relevant actions to critical and create to low', () => {
    const { ACTION_BADGE } = constants;
    expect(ACTION_BADGE.delete).toBe('critical');
    expect(ACTION_BADGE.login_failed).toBe('critical');
    expect(ACTION_BADGE.login_blocked).toBe('critical');
    expect(ACTION_BADGE.login_rate_limited).toBe('critical');
    expect(ACTION_BADGE.access_denied).toBe('critical');
    expect(ACTION_BADGE.create).toBe('low');
  });

  it('audit/index.ejs uses badgeClass with CONSTANTS.ACTION_BADGE', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'views', 'pages', 'audit', 'index.ejs'),
      'utf8'
    );
    expect(src).toMatch(/badgeClass\(e\.action \|\| 'unknown', CONSTANTS\.ACTION_BADGE\)/);
    // The old inline ternary must be gone.
    expect(src).not.toMatch(/\['delete', 'login_failed', 'login_blocked', 'login_rate_limited', 'access_denied'\]\.includes\(e\.action\)/);
  });

  it('app.js passes ACTION_BADGE through TEMPLATE_CONSTANTS and res.locals', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'app.js'),
      'utf8'
    );
    expect(src).toContain("ACTION_BADGE: constantsModule.ACTION_BADGE");
    expect(src).toContain("res.locals.ACTION_BADGE = ACTION_BADGE;");
  });
});
