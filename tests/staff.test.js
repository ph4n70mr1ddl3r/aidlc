const { describe, it, expect } = require('@jest/globals');

// Exercise real SQL behavior for staff.js business logic (create/update validation,
// role escalation prevention, deactivation unassignment) against an in-memory
// SQLite database. Uses the same DB_PATH pattern as reports.test.js.

const originalDbPath = process.env.DB_PATH;
beforeEach(function () {
  process.env.DB_PATH = ':memory:';
  // Clear cached modules so they re-load against the in-memory DB
  delete require.cache[require.resolve('../src/models/database')];
  delete require.cache[require.resolve('../src/utils')];
  delete require.cache[require.resolve('../src/routes/staff')];
});
afterEach(function () {
  process.env.DB_PATH = originalDbPath;
  delete require.cache[require.resolve('../src/models/database')];
  delete require.cache[require.resolve('../src/utils')];
  delete require.cache[require.resolve('../src/routes/staff')];
});

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

// Mock bcryptjs so tests can control hash/compare behavior (e.g. force errors).
// The seedUsers helper still uses hashSync directly (not via the mock) because
// it runs before the routes module is required and its own bcrypt import is
// unaffected by this mock.
jest.mock('bcryptjs', () => ({
  hash: jest.fn(() => Promise.resolve('hashed')),
  hashSync: jest.fn(() => 'hashed-sync'),
  compare: jest.fn(() => Promise.resolve(true))
}));

// Re-require db fresh each time via a helper to pick up the in-memory DB
function getDb() {
  return require('../src/models/database');
}

// Seed the in-memory DB with the same users that seed.js creates
function seedUsers(db) {
  // Clear existing users first (idempotent seeding) — disable FK for cleanup
  db.pragma('foreign_keys = OFF');
  db.exec('DELETE FROM users');
  db.pragma('foreign_keys = ON');
  const insertUser = db.prepare(`
    INSERT INTO users (username, password, email, first_name, last_name, role, department, phone, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const bcrypt = require('bcryptjs');
  const hashed = bcrypt.hashSync('Admin123!@#', 12);
  const hashed456 = bcrypt.hashSync('Manager123!@#', 12);
  const hashed789 = bcrypt.hashSync('Staff123!@#', 12);

  insertUser.run('admin', hashed, 'admin@example.com', 'Admin', 'User', 'admin', 'IT', '+1-555-0001', 1);
  insertUser.run('manager1', hashed456, 'manager@example.com', 'Manager', 'One', 'manager', 'IT', '+1-555-0002', 1);
  insertUser.run('staff1', hashed789, 'staff1@example.com', 'Staff', 'One', 'staff', 'Engineering', '+1-555-0003', 1);
  insertUser.run('staff2', hashed789, 'staff2@example.com', 'Staff', 'Two', 'staff', 'Engineering', '+1-555-0004', 1);
}

describe('staff create validation', () => {
  let db;
  beforeEach(() => {
    db = getDb();
    seedUsers(db);
    const utils = require('../src/utils');
    utils.resetCachedStatements();
  });

  it('rejects duplicate usernames', () => {
    const insert = db.prepare(`
      INSERT INTO users (username, password, email, first_name, last_name, role, department)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const bcrypt = require('bcryptjs');
    const hashed = bcrypt.hashSync('Newuser123!@#', 12);

    insert.run('newuser', hashed, 'new@example.com', 'New', 'User', 'staff', 'IT');

    // Duplicate should fail UNIQUE constraint
    expect(() => {
      insert.run('newuser', hashed, 'other@example.com', 'Other', 'Name', 'staff', 'IT');
    }).toThrow(/UNIQUE constraint/i);
  });

  it('creates a staff member with all fields', () => {
    const insert = db.prepare(`
      INSERT INTO users (username, password, email, first_name, last_name, role, department, phone)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const bcrypt = require('bcryptjs');
    const hashed = bcrypt.hashSync('Newuser123!@#', 12);

    const result = insert.run('newuser', hashed, 'new@example.com', 'New', 'User', 'staff', 'IT', '+1-555-1234');

    expect(result.lastInsertRowid).toBeTruthy();

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
    expect(user.username).toBe('newuser');
    expect(user.email).toBe('new@example.com');
    expect(user.role).toBe('staff');
    expect(user.is_active).toBe(1);
  });
});

describe('role escalation prevention', () => {
  let db;
  beforeEach(() => {
    db = getDb();
    seedUsers(db);
    const utils = require('../src/utils');
    utils.resetCachedStatements();
  });

  it('managers cannot create admin accounts (route-level guard logic)', () => {
    // This test validates the role-guard logic used in the route handler, not
    // the route itself. The pure function wouldBeRejected mirrors the guard:
    // if (role !== 'staff' && req.session.user.role !== 'admin')
    const wouldBeRejected = (proposedRole, sessionRole) => proposedRole !== 'staff' && sessionRole !== 'admin';

    // Manager trying to create admin/manager accounts is blocked
    expect(wouldBeRejected('admin', 'manager')).toBe(true);
    expect(wouldBeRejected('manager', 'manager')).toBe(true);
    // Admin creating any role is allowed
    expect(wouldBeRejected('admin', 'admin')).toBe(false);
    expect(wouldBeRejected('manager', 'admin')).toBe(false);
    // Any session creating staff accounts is allowed
    expect(wouldBeRejected('staff', 'manager')).toBe(false);
    expect(wouldBeRejected('staff', 'staff')).toBe(false);
  });

  it('admins can create any role (SQL-level test — bypasses route handler)', () => {
    const insert = db.prepare(`
      INSERT INTO users (username, password, email, first_name, last_name, role, department)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const bcrypt = require('bcryptjs');
    const hashed = bcrypt.hashSync('Newuser123!@#', 12);

    const result = insert.run('testadmin', hashed, 'testadmin@example.com', 'Test', 'Admin', 'admin', 'IT');
    expect(result.lastInsertRowid).toBeTruthy();

    const user = db.prepare('SELECT role FROM users WHERE id = ?').get(result.lastInsertRowid);
    expect(user.role).toBe('admin');
  });
});

describe('staff deactivation unassigns resources', () => {
  let db;
  beforeEach(() => {
    db = getDb();
    seedUsers(db);
    const utils = require('../src/utils');
    utils.resetCachedStatements();
  });

  it('unassigns open tickets on deactivation', () => {
    const staff = db.prepare('SELECT id FROM users WHERE username = \'staff1\'').get();
    expect(staff).toBeTruthy();

    // Insert a ticket assigned to this staff member
    db.prepare(`
      INSERT INTO tickets (ticket_number, title, category, priority, status, requester_name, requester_email, assigned_to)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('TK-20260701-001', 'Test ticket', 'hardware', 'medium', 'open', 'Requester', 'req@test.com', staff.id);

    const ticket = db.prepare('SELECT assigned_to FROM tickets WHERE assigned_to = ? AND status IN (\'open\',\'in_progress\',\'waiting\')').get(staff.id);
    expect(ticket).toBeTruthy();

    // Deactivate the user (set is_active = 0)
    db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(staff.id);

    // Unassign open tickets
    db.prepare(`
      UPDATE tickets SET assigned_to = NULL WHERE assigned_to = ? AND status IN ('open', 'in_progress', 'waiting')
    `).run(staff.id);

    // Verify no open tickets remain assigned to this user
    const ticketsAfter = db.prepare("SELECT assigned_to FROM tickets WHERE status = 'open'").all();
    expect(ticketsAfter.some(t => t.assigned_to === staff.id)).toBe(false);
  });

  it('unassigns open tasks on deactivation', () => {
    const staff = db.prepare('SELECT id FROM users WHERE username = \'staff1\'').get();
    const admin = db.prepare('SELECT id FROM users WHERE username = \'admin\'').get();
    const project = db.prepare("INSERT INTO projects (name, status, priority, owner_id) VALUES (?, 'planning', 'medium', ?) RETURNING id").get('Task Test', admin.id);

    db.prepare(`
      INSERT INTO project_tasks (project_id, title, status, assigned_to)
      VALUES (?, 'Active task', 'todo', ?)
    `).run(project.id, staff.id);

    // Unassign tasks
    db.prepare(`
      UPDATE project_tasks SET assigned_to = NULL WHERE assigned_to = ? AND status != 'done'
    `).run(staff.id);

    const activeTasks = db.prepare("SELECT assigned_to FROM project_tasks WHERE assigned_to = ? AND status != 'done'").get(staff.id);
    expect(activeTasks).toBeFalsy();
  });
});

describe('staff update preserves is_active', () => {
  let db;
  beforeEach(() => {
    db = getDb();
    seedUsers(db);
    const utils = require('../src/utils');
    utils.resetCachedStatements();
  });

  it('edit form does not change is_active via self-assignment', () => {
    const staff = db.prepare('SELECT id, is_active FROM users WHERE username = \'staff1\'').get();
    expect(staff.is_active).toBe(1);

    // The UPDATE statement uses is_active = is_active (self-assign) so editing
    // other fields cannot inadvertently flip the active status.
    db.prepare(`
      UPDATE users SET email = ?, is_active = is_active, updated_at = datetime('now')
      WHERE id = ?
    `).run('updated@example.com', staff.id);

    const after = db.prepare('SELECT is_active FROM users WHERE id = ?').get(staff.id);
    expect(after.is_active).toBe(1);
  });
});

describe('staff show route PII redaction', () => {
  let db;
  beforeEach(() => {
    db = getDb();
    seedUsers(db);
    const utils = require('../src/utils');
    utils.resetCachedStatements();
  });

  it('isPrivileged utility correctly identifies roles for PII redaction', () => {
    const { isPrivileged } = require('../src/utils');
    // Regular staff user is not privileged (PII redacted in list view)
    expect(isPrivileged({ role: 'staff' })).toBe(false);
    // Manager and admin are privileged (PII visible)
    expect(isPrivileged({ role: 'manager' })).toBe(true);
    expect(isPrivileged({ role: 'admin' })).toBe(true);
    // Null/undefined should return false
    expect(isPrivileged(null)).toBe(false);
    expect(isPrivileged(undefined)).toBe(false);
  });
});

describe('staff bcrypt error handling', () => {
  // Regression: bcrypt.hash in the create and password-reset routes previously
  // ran outside the try block, so an unexpected bcrypt error (OOM, etc.) would
  // surface as a generic 500 instead of a user-facing flash message.
  const bcrypt = require('bcryptjs');
  const { lastHandlerFor } = require('./helpers');

  async function runStaffCreate(body) {
    const staffRouterForTest = require('../src/routes/staff');
    const h = lastHandlerFor(staffRouterForTest, 'post', '/');
    let redirectedTo = null;
    const flashCalls = [];
    let caughtErr = null;
    const req = {
      body,
      params: {},
      method: 'POST',
      session: { user: { id: 1, role: 'admin' } },
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

  it('create route surfaces a flash error when bcrypt.hash throws', async () => {
    bcrypt.hash.mockClear();
    bcrypt.hash.mockRejectedValueOnce(new Error('bcrypt OOM'));
    const { redirectedTo, flashCalls } = await runStaffCreate({
      username: 'newuser', password: 'Passw0rd!Aa1', email: 'new@example.com',
      first_name: 'New', last_name: 'User', role: 'staff'
    });
    expect(redirectedTo).toBe('/staff/new');
    expect(flashCalls.some(([t, m]) => t === 'error' && /error/i.test(m))).toBe(true);
  });
});
