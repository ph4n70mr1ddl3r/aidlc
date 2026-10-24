const { describe, it, expect, afterEach } = require('@jest/globals');
const fs = require('fs');
const path = require('path');

// App-wide env-parsing warnings (review pass 385):
//
// (1) SESSION_ABSOLUTE_TIMEOUT_SECONDS — a set-but-invalid value
//     ("8hours", "0", "abc") used to fall back to the 28800-second default
//     with no warning at all, unlike every other numeric env site (PAGE_SIZE,
//     PRUNE_*, DASHBOARD_TTL_MS) which warns on a set-but-invalid value.
//     Now a set-but-invalid value warns and still fails closed to the default.
//
// (2) DASHBOARD_TTL_MS — a set-but-out-of-range value (below 1000 or above
//     3600000) is clamped; the clamp is now announced with a warning instead
//     of hiding the typo.

const APP_PATH = path.join(__dirname, '..', 'src', 'app.js');
const DASH_PATH = path.join(__dirname, '..', 'src', 'routes', 'dashboard.js');

function sourceContains(file, fragment) {
  return fs.readFileSync(file, 'utf8').includes(fragment);
}

function requireFreshApp() {
  let app;
  jest.isolateModules(() => {
    // Fresh session secrets so the secret-validation block does not warn.
    process.env.SESSION_SECRET = 'test-session-secret-0123456789abcdef';
    process.env.CSRF_SECRET = 'test-csrf-secret-0123456789abcdef1234';
    app = require('../src/app');
  });
  return app;
}

describe('env numeric warnings (review 385)', () => {
  afterEach(() => {
    delete process.env.SESSION_ABSOLUTE_TIMEOUT_SECONDS;
    delete process.env.DASHBOARD_TTL_MS;
    console.warn.mockRestore();
  });

  it('warns and fails closed when SESSION_ABSOLUTE_TIMEOUT_SECONDS is set but not a positive integer of seconds', () => {
    console.warn = jest.fn();
    for (const bad of ['8hours', '0', 'abc']) {
      console.warn.mockClear();
      process.env.SESSION_ABSOLUTE_TIMEOUT_SECONDS = bad;
      expect(requireFreshApp()).toBeDefined();
      const warnText = console.warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warnText).toContain(`SESSION_ABSOLUTE_TIMEOUT_SECONDS "${bad}"`);
      expect(warnText).toContain('using the 28800 (8 h) default');
    }
  });

  it('does not warn for an unset or a valid SESSION_ABSOLUTE_TIMEOUT_SECONDS', () => {
    console.warn = jest.fn();
    delete process.env.SESSION_ABSOLUTE_TIMEOUT_SECONDS;
    expect(requireFreshApp()).toBeDefined();
    let warnText = console.warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warnText).not.toContain('SESSION_ABSOLUTE_TIMEOUT_SECONDS');
    console.warn.mockClear();
    process.env.SESSION_ABSOLUTE_TIMEOUT_SECONDS = '3600';
    expect(requireFreshApp()).toBeDefined();
    warnText = console.warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warnText).not.toContain('SESSION_ABSOLUTE_TIMEOUT_SECONDS');
  });

  it('pins the source-level warning contract: set-but-invalid absolute timeout warns; the idle below-floor warning is unchanged', () => {
    expect(sourceContains(APP_PATH, 'WARNING: SESSION_ABSOLUTE_TIMEOUT_SECONDS')).toBe(true);
    expect(sourceContains(APP_PATH, 'using the 28800 (8 h) default')).toBe(true);
    expect(sourceContains(APP_PATH, 'below the 60s lastAccess write-throttle floor')).toBe(true);
  });

  it('warns when a set DASHBOARD_TTL_MS falls outside the 1000-3600000ms clamp range', () => {
    console.warn = jest.fn();
    jest.isolateModules(() => {
      require('../src/routes/dashboard');
    });
    expect(console.warn).not.toHaveBeenCalled(); // unset env — no noise
    for (const [bad, frag] of [['500', 'clamped'], ['9999999', 'clamped']]) {
      console.warn.mockClear();
      process.env.DASHBOARD_TTL_MS = bad;
      jest.isolateModules(() => {
        require('../src/routes/dashboard');
      });
      const warnText = console.warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warnText).toContain(`DASHBOARD_TTL_MS "${bad}"`);
      expect(warnText).toContain(frag);
    }
  });

  it('does not warn for an unset or in-range DASHBOARD_TTL_MS', () => {
    console.warn = jest.fn();
    delete process.env.DASHBOARD_TTL_MS;
    jest.isolateModules(() => {
      require('../src/routes/dashboard');
    });
    expect(console.warn).not.toHaveBeenCalled();
    console.warn.mockClear();
    process.env.DASHBOARD_TTL_MS = '60000';
    jest.isolateModules(() => {
      require('../src/routes/dashboard');
    });
    const warnText = console.warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warnText).not.toContain('DASHBOARD_TTL_MS');
  });

  it('pins the source-level clamp-and-warn contract in dashboard.js', () => {
    expect(sourceContains(DASH_PATH, 'is outside the 1000-3600000ms range — clamped.')).toBe(true);
  });
});
