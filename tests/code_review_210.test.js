const { describe, it, expect } = require('@jest/globals');
const fs = require('fs');
const path = require('path');
const { lastHandlerFor } = require('./helpers');

// Module-level mocks (hoisted by Jest)
jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => next(),
  requireAdminOrManager: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next()
}));
jest.mock('../src/middleware/audit', () => ({
  auditMiddleware: (req, res, next) => next()
}));
jest.mock('../src/routes/dashboard', () => ({
  invalidateDashboardCache: jest.fn()
}));
jest.mock('../src/routes/auth', () => ({
  clearLoginFailure: jest.fn(),
  clearIpLoginFailure: jest.fn()
}));
jest.mock('bcryptjs', () => ({
  hash: jest.fn(() => Promise.resolve('hashed')),
  hashSync: jest.fn(() => 'hashed-sync'),
  compare: jest.fn(() => Promise.resolve(true))
}));

const originalDbPath = process.env.DB_PATH;
beforeEach(function () {
  process.env.DB_PATH = ':memory:';
  delete require.cache[require.resolve('../src/models/database')];
  delete require.cache[require.resolve('../src/utils')];
  delete require.cache[require.resolve('../src/routes/staff')];
  delete require.cache[require.resolve('../src/routes/auth')];
  delete require.cache[require.resolve('../src/routes/dashboard')];
});
afterEach(function () {
  process.env.DB_PATH = originalDbPath;
  delete require.cache[require.resolve('../src/models/database')];
  delete require.cache[require.resolve('../src/utils')];
  delete require.cache[require.resolve('../src/routes/staff')];
  delete require.cache[require.resolve('../src/routes/auth')];
  delete require.cache[require.resolve('../src/routes/dashboard')];
});

function getDb() {
  return require('../src/models/database');
}

function seedUsers(db) {
  db.pragma('foreign_keys = OFF');
  db.exec('DELETE FROM users');
  db.pragma('foreign_keys = ON');
  const insertUser = db.prepare(`
    INSERT INTO users (username, password, email, first_name, last_name, role, department, phone, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const bcrypt = require('bcryptjs');
  const hashed = bcrypt.hashSync('Admin123!@#', 12);
  const hashed456 = bcrypt.hashSync('Staff123!@#', 12);
  insertUser.run('admin', hashed, 'admin@co.com', 'Admin', 'User', 'admin', 'IT', '+1-555-0001', 1);
  insertUser.run('target', hashed456, 'target@co.com', 'Target', 'User', 'staff', 'IT', '+1-555-0002', 1);
}

async function runStaffResetPassword(id, body) {
  const staffRouterForTest = require('../src/routes/staff');
  const h = lastHandlerFor(staffRouterForTest, 'put', '/:id/reset-password');
  let redirectedTo = null;
  const flashCalls = [];
  let caughtErr = null;
  const req = {
    body,
    params: { id: String(id) },
    method: 'PUT',
    session: { user: { id: 1, role: 'admin' } },
    audit: jest.fn(),
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
  await h(req, res, (err) => {
    caughtErr = err;
  });
  await new Promise((resolve) => setImmediate(resolve));
  return { redirectedTo, flashCalls, caughtErr };
}

describe('code review 210 — staff password reset invalidates dashboard cache', () => {
  it('calls invalidateDashboardCache on successful password reset', async () => {
    const db = getDb();
    try {
      db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, email TEXT NOT NULL, first_name TEXT NOT NULL, last_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT \'staff\', department TEXT, phone TEXT, avatar TEXT, is_active INTEGER NOT NULL DEFAULT 1, last_login TEXT, password_changed_at TEXT, created_at TEXT DEFAULT (datetime(\'now\')), updated_at TEXT DEFAULT (datetime(\'now\')))');
    } catch { /* already exists */ }
    seedUsers(db);

    const bcrypt = require('bcryptjs');
    bcrypt.compare.mockClear();
    bcrypt.compare.mockReturnValue(Promise.resolve(true));

    const { redirectedTo, flashCalls } = await runStaffResetPassword(2, {
      new_password: 'NewP@ssw0rd!Aa1',
      current_password: 'Staff123!@#'
    });

    expect(redirectedTo).toBe('/staff/2');
    expect(flashCalls.some(([t, m]) => t === 'success' && /reset successfully/i.test(m))).toBe(true);

    const { invalidateDashboardCache } = require('../src/routes/dashboard');
    expect(invalidateDashboardCache).toHaveBeenCalledTimes(1);
  });

  it('staff.js source pin: invalidateDashboardCache call follows the password UPDATE', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'routes', 'staff.js'),
      'utf8'
    );
    // The invalidateDashboardCache call must appear after the password reset
    // SQL execution and the audit entry, confirming it fires only on success.
    const lines = src.split('\n');
    let foundPasswordResetStmt = false;
    let foundAuditAfterReset = false;
    let foundInvalidateAfterAudit = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes('_passwordResetStmt.run(hashed, id)')) {
        foundPasswordResetStmt = true;
      }
      if (foundPasswordResetStmt && line.includes("req.audit('update', 'user', id")) {
        foundAuditAfterReset = true;
      }
      if (foundAuditAfterReset && line.includes('invalidateDashboardCache()')) {
        foundInvalidateAfterAudit = true;
      }
    }
    expect(foundPasswordResetStmt).toBe(true);
    expect(foundAuditAfterReset).toBe(true);
    expect(foundInvalidateAfterAudit).toBe(true);
  });
});
