const { describe, it, expect, afterEach } = require('@jest/globals');

// Regression tests for review pass 358:
//
// (1) auth.js — the per-account/per-IP login-failure count was pinned at
//     MAX_LOGIN_FAILURES while locked and never reset when the 15-minute
//     lockout window expired (the periodic purge only deletes the entry on its
//     next 10-minute tick). A single failed attempt after expiry re-locked the
//     account/IP immediately, so one request per window could keep an account
//     permanently locked. Fix: checkLockout() lazily resets the count when the
//     lockout window has expired.
//
// (2) Env numeric parsing — PRUNE_AUDIT_DAYS / PRUNE_AUDIT_INTERVAL_MS /
//     DASHBOARD_TTL_MS / PAGE_SIZE / SESSION_IDLE|ABSOLUTE_TIMEOUT_SECONDS used
//     bare parseInt(), which prefix-parses operator typos: "6months" became a
//     6-day retention, "90s" a 90ms prune interval, "8hours" an 8-second
//     session lifetime — all silently. Fix: utils.parseEnvInt() (anchored
//     /^\d+$/ like the PORT parser) fail-closes every site to its documented
//     default, with warnings for set-but-invalid PRUNE values.
//
// (3) assets.js — a duplicate serial_number threw the same
//     SQLITE_CONSTRAINT_UNIQUE code as a duplicate asset_tag but flashed the
//     misleading "tag already exists" message (create + edit).
//
// (4) tickets.js — comment audit entries now distinguish internal notes, and
//     an absent priority reports "Priority is required" instead of
//     "Invalid Priority".
//
// (5) Paginated list ORDER BYs now carry a unique `id` tiebreaker so
//     LIMIT/OFFSET paging is stable under second-resolution timestamp ties.

// Stateful db mock: prepare() dispatches on SQL fragment, so each statement
// gets its own jest.fn-backed handle.
const state = { k: 0 };
const mocks = {
  // The ticket-number counter (INSERT ... RETURNING next_seq) and the ticket
  // INSERT itself, so the create route can run to completion.
  ticketCounter: { get: jest.fn(() => ({ next_seq: 1 })) },
  ticketInsert: { run: jest.fn(() => ({ changes: 1, lastInsertRowid: 7 })) }
};

jest.mock('../src/models/database', () => {
  const mkStmt = (key) => ({
    get: (...args) => (state[key] ? state[key].get(...args) : (mocks[key] && mocks[key].get ? mocks[key].get(...args) : null)),
    all: (...args) => (mocks[key] && mocks[key].all ? mocks[key].all(...args) : []),
    run: (...args) => (mocks[key] && mocks[key].run ? mocks[key].run(...args) : { changes: 0 })
  });
  return {
    prepare: jest.fn((sql) => {
      if (sql.includes('FROM users WHERE username = ? AND is_active = 1')) {
        return mkStmt('loginUser');
      }
      if (sql.includes('asset_counter')) {
        return mkStmt('assetCounter');
      }
      if (sql.includes('SELECT 1 FROM users')) {
        return mkStmt('activeUser');
      }
      if (sql.includes('INSERT INTO assets')) {
        return mkStmt('assetInsert');
      }
      if (sql.includes('UPDATE assets SET')) {
        return mkStmt('assetUpdate');
      }
      if (sql.includes('FROM assets WHERE id = ?')) {
        return mkStmt('assetById');
      }
      if (sql.includes('INSERT INTO ticket_comments')) {
        return mkStmt('commentInsert');
      }
      if (sql.includes('INSERT INTO ticket_counter')) {
        return mkStmt('ticketCounter');
      }
      if (sql.includes('INSERT INTO tickets')) {
        return mkStmt('ticketInsert');
      }
      if (sql.includes('UPDATE tickets SET updated_at')) {
        return mkStmt('commentTouch');
      }
      if (sql.includes('SELECT id, assigned_to FROM tickets')) {
        return mkStmt('commentTicket');
      }
      return mkStmt('other-' + (state.k += 1));
    }),
    exec: jest.fn(),
    pragma: jest.fn(),
    transaction: jest.fn((fn) => fn),
    close: jest.fn()
  };
});

jest.mock('../src/middleware/audit', () => ({
  audit: jest.fn(),
  auditMiddleware: (req, _res, next) => next()
}));

const _bcrypt = require('bcryptjs');
jest.mock('bcryptjs', () => ({
  compare: jest.fn(() => Promise.resolve(false)),
  hash: jest.fn(() => Promise.resolve('hash')),
  hashSync: jest.fn(() => 'dummy-hash')
}));

const { lastHandlerFor } = require('./helpers');
const auditFn = () => jest.requireMock('../src/middleware/audit').audit;
const utils = require('../src/utils');

// ---------------------------------------------------------------------------
// (1) Lockout expiry — lazy counter reset
// ---------------------------------------------------------------------------
describe('code review 358 — lockout counter resets when the window expires', () => {
  const authRouter = require('../src/routes/auth');
  const loginHandler = lastHandlerFor(authRouter, 'post', '/login');

  async function runLogin(body, ip) {
    let redirectedTo = null;
    const flashCalls = [];
    const req = {
      body,
      params: {},
      method: 'POST',
      ip,
      session: { regenerate: (cb) => cb() },
      flash: (type, msg) => flashCalls.push([type, msg])
    };
    const res = { redirect: (to) => {
      redirectedTo = to;
    }, render: () => {}, status: () => res, json: () => {} };
    await loginHandler(req, res, () => {});
    await new Promise((resolve) => setImmediate(resolve));
    return { redirectedTo, flashCalls };
  }

  function blockedAudits() {
    return auditFn().mock.calls.filter((c) => c[0].action === 'login_blocked');
  }

  function failedAudits() {
    return auditFn().mock.calls.filter((c) => c[0].action === 'login_failed');
  }

  afterEach(() => {
    auditFn().mockClear();
  });

  it('allows a fresh window after expiry instead of re-locking on the first failure', async () => {
    const stamp = Date.now();
    const username = 'lockexp-' + stamp;
    const ip = '203.0.113.185';
    // 5 failures → lock; 6th attempt is blocked by the account lockout.
    for (let i = 0; i < 5; i++) {
      await runLogin({ username, password: 'wrong' }, ip);
    }
    await runLogin({ username, password: 'wrong' }, ip);
    expect(blockedAudits().length).toBe(1);

    // Advance past the 15-minute lockout window.
    const realNow = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => realNow + 16 * 60 * 1000);

    // The first post-expiry failure must NOT re-lock the account: it is
    // recorded as a fresh failure (login_failed), with no login_blocked audit.
    await runLogin({ username, password: 'wrong' }, ip);
    expect(blockedAudits().length).toBe(1);
    // The attempt really went through the credential path (bcrypt compared).
    expect(failedAudits().filter((c) => c[0].details.includes(username.toLowerCase())).length).toBeGreaterThan(0);

    // Restore the wall clock; a full fresh 5-failure window is now required.
    const spy = jest.spyOn(Date, 'now');
    spy.mockRestore();
    for (let i = 0; i < 4; i++) {
      await runLogin({ username, password: 'wrong' }, ip);
    }
    expect(blockedAudits().length).toBe(1);
    // The 5th post-expiry failure re-locks; the next attempt is blocked.
    await runLogin({ username, password: 'wrong' }, ip);
    expect(blockedAudits().length).toBe(2);
  });

  it('resets the per-IP counter the same way (IP lockout does not loop forever)', async () => {
    const stamp = Date.now();
    const ip = '203.0.113.186';
    // Distinct usernames: only the IP accumulates the 5 shared failures.
    for (let i = 0; i < 5; i++) {
      await runLogin({ username: `ipexp${i}-${stamp}`, password: 'wrong' }, ip);
    }
    await runLogin({ username: `ipexpfinal-${stamp}`, password: 'wrong' }, ip);
    expect(blockedAudits().length).toBe(1);

    const realNow = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => realNow + 16 * 60 * 1000);
    // Post-expiry: the IP budget starts over — this attempt is recorded as a
    // failure, not blocked.
    const postExpiryUser = `ipexpafter-${stamp}`;
    await runLogin({ username: postExpiryUser, password: 'wrong' }, ip);
    expect(blockedAudits().length).toBe(1);

    const spy = jest.spyOn(Date, 'now');
    spy.mockRestore();
    // Fresh window: 4 more failures keep the IP below the threshold...
    for (let i = 0; i < 4; i++) {
      await runLogin({ username: `${postExpiryUser}-${i}`, password: 'wrong' }, ip);
    }
    expect(blockedAudits().length).toBe(1);
    // ...the 5th re-locks; the next attempt from the same IP is blocked.
    await runLogin({ username: `${postExpiryUser}-x`, password: 'wrong' }, ip);
    expect(blockedAudits().length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// (2) Strict env integer parsing
// ---------------------------------------------------------------------------
describe('code review 358 — parseEnvInt is anchored like the PORT parser', () => {
  it('accepts canonical integer strings and rejects prefix-parseable garbage', () => {
    expect(utils.parseEnvInt('25')).toBe(25);
    expect(utils.parseEnvInt('0')).toBe(0);
    expect(utils.parseEnvInt('86400000')).toBe(86400000);
    // Bare parseInt would return 6 / 90 / 8 for these operator typos:
    expect(utils.parseEnvInt('6months')).toBeNaN();
    expect(utils.parseEnvInt('90s')).toBeNaN();
    expect(utils.parseEnvInt('8hours')).toBeNaN();
    expect(utils.parseEnvInt('50abc')).toBeNaN();
    // Non-canonical / non-string values fail closed.
    expect(utils.parseEnvInt('')).toBeNaN();
    expect(utils.parseEnvInt(undefined)).toBeNaN();
    expect(utils.parseEnvInt(null)).toBeNaN();
    expect(utils.parseEnvInt('-5')).toBeNaN();
    expect(utils.parseEnvInt(' 25')).toBeNaN();
  });

  it('derives PAGE_SIZE from the anchored parse (invalid value warns and falls back)', () => {
    const original = process.env.PAGE_SIZE;
    console.warn.mockClear();
    try {
      // "6months" previously prefix-parsed to a page size of 6 with no warning.
      process.env.PAGE_SIZE = '6months';
      utils.resetPageSize();
      expect(console.warn.mock.calls.some((c) => String(c[0]).includes('Invalid PAGE_SIZE "6months"'))).toBe(true);
      const { limit } = utils.paginate({ query: {} });
      expect(limit).toBe(25);
    } finally {
      if (original === undefined) {
        delete process.env.PAGE_SIZE;
      } else {
        process.env.PAGE_SIZE = original;
      }
      console.warn.mockClear();
      utils.resetPageSize();
    }
  });

  it('PRUNE_AUDIT_DAYS / PRUNE_AUDIT_INTERVAL_MS warn and fail closed at app load', () => {
    jest.mock('dotenv', () => ({ config: jest.fn() }));
    const originalDays = process.env.PRUNE_AUDIT_DAYS;
    const originalInterval = process.env.PRUNE_AUDIT_INTERVAL_MS;
    console.warn.mockClear();
    let fresh;
    try {
      process.env.PRUNE_AUDIT_DAYS = '1year';
      process.env.PRUNE_AUDIT_INTERVAL_MS = '90s';
      jest.isolateModules(() => {
        fresh = require('../src/app');
      });
      const warnText = console.warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warnText).toContain('Invalid PRUNE_AUDIT_DAYS "1year"');
      expect(warnText).toContain('Audit pruning stays disabled');
      expect(warnText).toContain('Invalid PRUNE_AUDIT_INTERVAL_MS "90s"');
      expect(fresh).toBeDefined();
    } finally {
      if (originalDays === undefined) {
        delete process.env.PRUNE_AUDIT_DAYS;
      } else {
        process.env.PRUNE_AUDIT_DAYS = originalDays;
      }
      if (originalInterval === undefined) {
        delete process.env.PRUNE_AUDIT_INTERVAL_MS;
      } else {
        process.env.PRUNE_AUDIT_INTERVAL_MS = originalInterval;
      }
      console.warn.mockClear();
    }
  });

  it('app loads cleanly with valid PRUNE values (no invocation warnings)', () => {
    const originalDays = process.env.PRUNE_AUDIT_DAYS;
    const originalInterval = process.env.PRUNE_AUDIT_INTERVAL_MS;
    try {
      process.env.PRUNE_AUDIT_DAYS = '365';
      process.env.PRUNE_AUDIT_INTERVAL_MS = '86400000';
      let fresh;
      jest.isolateModules(() => {
        fresh = require('../src/app');
      });
      expect(fresh).toBeDefined();
    } finally {
      if (originalDays === undefined) {
        delete process.env.PRUNE_AUDIT_DAYS;
      } else {
        process.env.PRUNE_AUDIT_DAYS = originalDays;
      }
      if (originalInterval === undefined) {
        delete process.env.PRUNE_AUDIT_INTERVAL_MS;
      } else {
        process.env.PRUNE_AUDIT_INTERVAL_MS = originalInterval;
      }
    }
  });

  it('source pins every numeric env read to parseEnvInt (no bare parseInt on env values)', () => {
    const fs = require('fs');
    const path = require('path');
    const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
    const dashboardSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'dashboard.js'), 'utf8');
    expect(appSrc).toContain('const pruneDays = utilsModule.parseEnvInt(process.env.PRUNE_AUDIT_DAYS)');
    expect(appSrc).toContain('const _parsedPruneInterval = utilsModule.parseEnvInt(process.env.PRUNE_AUDIT_INTERVAL_MS)');
    // The session-timeout parser routes through the anchored helper.
    expect(appSrc).toMatch(/function _parsePositiveSeconds\(raw, fallback\) \{[\s\S]*?parseEnvInt\(raw\)/);
    expect(dashboardSrc).toContain('const _parsedDTTL = parseEnvInt(process.env.DASHBOARD_TTL_MS)');
  });
});

// ---------------------------------------------------------------------------
// (3) Assets — accurate UNIQUE-constraint flash messages
// ---------------------------------------------------------------------------
describe('code review 358 — duplicate serial_number reports the serial message', () => {
  const assetsRouter = require('../src/routes/assets');

  function makeReqRes(overrides) {
    const req = Object.assign({
      params: {},
      body: {},
      flash: jest.fn(),
      audit: jest.fn(),
      session: { user: { id: 1, role: 'admin' } }
    }, overrides);
    const res = { redirect: jest.fn(), render: jest.fn(), status: jest.fn(() => res), json: jest.fn() };
    return { req, res };
  }

  it('create: duplicate serial_number flashes the serial message', () => {
    mocks.assetCounter = { get: () => ({ next_seq: 30 }) };
    mocks.assetInsert = {
      run: () => {
        throw Object.assign(new Error('UNIQUE constraint failed: assets.serial_number'), { code: 'SQLITE_CONSTRAINT_UNIQUE' });
      }
    };
    const handler = lastHandlerFor(assetsRouter, 'post', '/');
    const { req, res } = makeReqRes({ body: { name: 'Loaner Laptop', category: 'laptop', serial_number: 'DUP-001' } });

    handler(req, res);

    expect(req.flash).toHaveBeenCalledWith('error', 'An asset with this serial number already exists');
    expect(res.redirect).toHaveBeenCalledWith('/assets/new');
  });

  it('create: duplicate asset_tag keeps the tag message', () => {
    mocks.assetCounter = { get: () => ({ next_seq: 30 }) };
    mocks.assetInsert = {
      run: () => {
        throw Object.assign(new Error('UNIQUE constraint failed: assets.asset_tag'), { code: 'SQLITE_CONSTRAINT_UNIQUE' });
      }
    };
    const handler = lastHandlerFor(assetsRouter, 'post', '/');
    const { req, res } = makeReqRes({ body: { name: 'Loaner Laptop', category: 'laptop' } });

    handler(req, res);

    expect(req.flash).toHaveBeenCalledWith('error', 'An asset with this tag already exists');
    expect(res.redirect).toHaveBeenCalledWith('/assets/new');
  });

  it('edit: duplicate serial_number flashes the serial message', () => {
    mocks.assetById = { get: () => ({ id: 3, asset_tag: 'AST-003', name: 'Old', category: 'laptop', serial_number: null }) };
    mocks.assetUpdate = {
      run: () => {
        throw Object.assign(new Error('UNIQUE constraint failed: assets.serial_number'), { code: 'SQLITE_CONSTRAINT_UNIQUE' });
      }
    };
    const handler = lastHandlerFor(assetsRouter, 'put', '/:id');
    const { req, res } = makeReqRes({
      params: { id: '3' },
      body: { asset_tag: 'AST-003', name: 'Updated', category: 'laptop', serial_number: 'DUP-002' }
    });

    handler(req, res);

    expect(req.flash).toHaveBeenCalledWith('error', 'An asset with this serial number already exists');
    expect(res.redirect).toHaveBeenCalledWith('/assets/3/edit');
  });
});

// ---------------------------------------------------------------------------
// (4) Tickets — internal-comment audit marker + required-priority message
// ---------------------------------------------------------------------------
describe('code review 358 — comment audit distinguishes internal notes', () => {
  const ticketsRouter = require('../src/routes/tickets');

  function commentReq(body, user) {
    return {
      params: { id: '9' },
      body,
      ip: '203.0.113.200',
      flash: jest.fn(),
      audit: jest.fn(),
      session: { user: user || { id: 1, role: 'admin', username: 'admin' } }
    };
  }

  it('admin internal note audits "Added comment (internal)"', () => {
    mocks.commentTicket = { get: () => ({ id: 9, assigned_to: null }) };
    mocks.activeUser = { get: () => ({ 1: 1 }) };
    mocks.commentInsert = { run: jest.fn() };
    mocks.commentTouch = { run: () => ({ changes: 1 }) };
    const handler = lastHandlerFor(ticketsRouter, 'post', '/:id/comments');
    const req = commentReq({ comment: 'internal note', is_internal: 'on' }, { id: 1, role: 'admin', username: 'admin' });
    const res = { redirect: jest.fn() };

    handler(req, res);

    expect(mocks.commentInsert.run).toHaveBeenCalledWith(9, 1, 'internal note', 1);
    expect(req.audit).toHaveBeenCalledWith('comment', 'ticket', 9, 'Added comment (internal)');
  });

  it('public comment audits plain "Added comment"', () => {
    mocks.commentTicket = { get: () => ({ id: 9, assigned_to: null }) };
    mocks.activeUser = { get: () => ({ 1: 1 }) };
    mocks.commentInsert = { run: jest.fn() };
    mocks.commentTouch = { run: () => ({ changes: 1 }) };
    const handler = lastHandlerFor(ticketsRouter, 'post', '/:id/comments');
    const req = commentReq({ comment: 'public note' });
    const res = { redirect: jest.fn() };

    handler(req, res);

    expect(mocks.commentInsert.run).toHaveBeenCalledWith(9, 1, 'public note', 0);
    expect(req.audit).toHaveBeenCalledWith('comment', 'ticket', 9, 'Added comment');
  });
});

describe('code review 358 — absent priority takes the documented default', () => {
  const ticketsRouter = require('../src/routes/tickets');

  it('create with a missing priority applies the schema default instead of refusing', () => {
    // Pass 358 first made the wording "Priority is required" (the field was
    // still REQUIRED). Pass 379 then applied the app-wide create-route
    // contract the README documents — "an absent field still takes the
    // documented default" — so the ticket route now resolves the priority
    // through the same resolveEnumField() helper as its sibling `status` and
    // as every other entity's create route. `tickets.priority` is NOT NULL
    // DEFAULT 'medium', so an absent priority takes 'medium' and a
    // present-but-invalid one is still rejected.
    const handler = lastHandlerFor(ticketsRouter, 'post', '/');
    const req = {
      params: {},
      body: {
        title: 'Printer on fire',
        category: 'hardware',
        requester_name: 'Ada Lovelace',
        requester_email: 'ada@company.com'
      },
      flash: jest.fn(),
      audit: jest.fn(),
      session: { user: { id: 1, role: 'staff' } }
    };
    const res = { redirect: jest.fn() };

    mocks.ticketInsert.run.mockClear();

    handler(req, res);

    expect(req.flash).not.toHaveBeenCalledWith('error', expect.anything());
    expect(mocks.ticketInsert.run).toHaveBeenCalled();
    // The stored priority is the documented default.
    const insertArgs = mocks.ticketInsert.run.mock.calls[mocks.ticketInsert.run.mock.calls.length - 1];
    expect(insertArgs[4]).toBe('medium');
  });

  it('a present-but-empty priority is still rejected', () => {
    const handler = lastHandlerFor(ticketsRouter, 'post', '/');
    const req = {
      params: {},
      body: {
        title: 'Printer on fire',
        category: 'hardware',
        requester_name: 'Ada Lovelace',
        requester_email: 'ada@company.com',
        priority: ''
      },
      flash: jest.fn(),
      audit: jest.fn(),
      session: { user: { id: 1, role: 'staff' } }
    };
    const res = { redirect: jest.fn() };

    handler(req, res);

    expect(req.flash).toHaveBeenCalledWith('error', 'Invalid Priority');
    expect(res.redirect).toHaveBeenCalledWith('/tickets/new');
  });

  it('a present-but-invalid priority still reports "Invalid Priority"', () => {
    const handler = lastHandlerFor(ticketsRouter, 'post', '/');
    const req = {
      params: {},
      body: {
        title: 'Printer on fire',
        category: 'hardware',
        requester_name: 'Ada Lovelace',
        requester_email: 'ada@company.com',
        priority: 'urgent'
      },
      flash: jest.fn(),
      audit: jest.fn(),
      session: { user: { id: 1, role: 'staff' } }
    };
    const res = { redirect: jest.fn() };

    handler(req, res);

    expect(req.flash).toHaveBeenCalledWith('error', 'Invalid Priority');
    expect(res.redirect).toHaveBeenCalledWith('/tickets/new');
  });
});

// ---------------------------------------------------------------------------
// (5) Pagination — every paginated list ORDER BY ends in a unique id tiebreaker
// ---------------------------------------------------------------------------
describe('code review 358 — ORDER BY tiebreakers on paginated lists', () => {
  const fs = require('fs');
  const path = require('path');
  const readSrc = (p) => fs.readFileSync(path.join(__dirname, '..', 'src', p.replace(/^src\//, '')), 'utf8');

  it('SORT_MAP sort options for tickets/assets/projects/audit carry an id tiebreaker', () => {
    for (const file of ['src/routes/tickets.js', 'src/routes/assets.js', 'src/routes/projects.js', 'src/routes/audit.js']) {
      const src = readSrc(file);
      const block = src.slice(src.indexOf('const SORT_MAP'), src.indexOf('});', src.indexOf('const SORT_MAP')));
      for (const line of block.split('\n')) {
        if (!/^\s*\w+: '/.test(line)) {
          continue;
        }
        expect(`${file}: ${line.trim()}`).toMatch(/, (a|p|t)\.id (ASC|DESC)'/);
      }
    }
  });

  it('literal paginated queries carry the tiebreaker too', () => {
    const changes = readSrc('src/routes/changes.js');
    const knowledge = readSrc('src/routes/knowledge.js');
    const licenses = readSrc('src/routes/licenses.js');
    const vendors = readSrc('src/routes/vendors.js');
    const staff = readSrc('src/routes/staff.js');
    expect(changes).toContain('ORDER BY c.scheduled_start DESC, c.id DESC');
    expect(knowledge).toContain('ORDER BY k.updated_at DESC, k.id DESC');
    expect(licenses).toContain('ORDER BY l.software_name ASC, l.id ASC');
    expect(vendors).toContain('ORDER BY v.name ASC, v.id ASC');
    expect(staff).toContain('ORDER BY u.first_name ASC, u.id ASC');
  });
});
