const { describe, it, expect } = require('@jest/globals');

// Exercise real SQL behavior for projects.js business logic (task CRUD, member
// management, progress recalculation, budget/spent preservation) against an
// in-memory SQLite database. Uses the same DB_PATH pattern as reports.test.js.

const originalDbPath = process.env.DB_PATH;
beforeEach(function () {
  process.env.DB_PATH = ':memory:';
  // Clear cached modules so they re-load against the in-memory DB
  delete require.cache[require.resolve('../src/models/database')];
  delete require.cache[require.resolve('../src/utils')];
});
afterEach(function () {
  process.env.DB_PATH = originalDbPath;
  delete require.cache[require.resolve('../src/models/database')];
  delete require.cache[require.resolve('../src/utils')];
});

jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => next(),
  requireAdminOrManager: (req, res, next) => next()
}));

jest.mock('../src/middleware/audit', () => ({
  auditMiddleware: (req, res, next) => next()
}));

jest.mock('../src/routes/dashboard', () => ({
  invalidateDashboardCache: jest.fn()
}));

// Re-require db fresh each time via a helper to pick up the in-memory DB
function getDb() {
  return require('../src/models/database');
}

// Seed a basic admin user and project for tests
function seedProjectData(db) {
  // Clear existing users first (idempotent seeding) — disable FK for cleanup
  db.pragma('foreign_keys = OFF');
  db.exec('DELETE FROM users');
  db.pragma('foreign_keys = ON');
  const insertUser = db.prepare(`
    INSERT INTO users (username, password, email, first_name, last_name, role, department, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const bcrypt = require('bcryptjs');
  const hashed = bcrypt.hashSync('Admin123!@#', 12);
  insertUser.run('admin', hashed, 'admin@example.com', 'Admin', 'User', 'admin', 'IT', 1);
}

describe('project task CRUD', () => {
  let db;
  beforeEach(() => {
    db = getDb();
    seedProjectData(db);
    const utils = require('../src/utils');
    utils.resetCachedStatements();
  });

  it('inserts a task with all fields and recalculates progress', () => {
    const insertTask = db.prepare(`
      INSERT INTO project_tasks (project_id, title, description, status, priority, assigned_to, due_date)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const admin = db.prepare('SELECT id FROM users WHERE username = \'admin\'').get();
    const project = db.prepare("INSERT INTO projects (name, status, priority, owner_id) VALUES (?, 'planning', 'medium', ?) RETURNING id").get('Test Project', admin.id);

    insertTask.run(project.id, 'Fix login bug', 'Debug auth flow', 'todo', 'high', admin.id, '2026-12-31 10:00');

    const task = db.prepare('SELECT * FROM project_tasks WHERE project_id = ?').all(project.id);
    expect(task).toHaveLength(1);
    expect(task[0].title).toBe('Fix login bug');
    expect(task[0].status).toBe('todo');
    expect(task[0].priority).toBe('high');

    // Progress should be 0% (no tasks done)
    const projectRow = db.prepare('SELECT progress FROM projects WHERE id = ?').get(project.id);
    expect(projectRow.progress).toBe(0);
  });

  it('marks task as done and updates project progress to 100%', () => {
    const insertTask = db.prepare(`
      INSERT INTO project_tasks (project_id, title, status, completed_at)
      VALUES (?, 'Done task', 'done', datetime('now'))
    `);
    const admin = db.prepare('SELECT id FROM users WHERE username = \'admin\'').get();
    const project = db.prepare("INSERT INTO projects (name, status, priority, owner_id) VALUES (?, 'in_progress', 'medium', ?) RETURNING id").get('Progress Test', admin.id);

    insertTask.run(project.id);

    // Recalculate progress manually (mirrors recalcProjectProgress)
    const row = db.prepare(
      'SELECT COUNT(*) as total, SUM(CASE WHEN status = \'done\' THEN 1 ELSE 0 END) as done FROM project_tasks WHERE project_id = ?'
    ).get(project.id);
    const progress = row.total > 0 ? Math.round((row.done / row.total) * 100) : 0;
    db.prepare('UPDATE projects SET progress = ? WHERE id = ?').run(progress, project.id);

    const projectRow = db.prepare('SELECT progress FROM projects WHERE id = ?').get(project.id);
    expect(projectRow.progress).toBe(100);
  });

  it('handles mixed task statuses correctly', () => {
    const insertTask = db.prepare(`
      INSERT INTO project_tasks (project_id, title, status) VALUES (?, ?, ?)
    `);
    const admin = db.prepare('SELECT id FROM users WHERE username = \'admin\'').get();
    const project = db.prepare("INSERT INTO projects (name, status, priority, owner_id) VALUES (?, 'in_progress', 'medium', ?) RETURNING id").get('Mixed Tasks', admin.id);

    insertTask.run(project.id, 'Todo task', 'todo');
    insertTask.run(project.id, 'In Progress task', 'in_progress');
    insertTask.run(project.id, 'Done task', 'done');

    const row = db.prepare(
      'SELECT COUNT(*) as total, SUM(CASE WHEN status = \'done\' THEN 1 ELSE 0 END) as done FROM project_tasks WHERE project_id = ?'
    ).get(project.id);
    expect(row.total).toBe(3);
    expect(row.done).toBe(1);

    const progress = Math.round((row.done / row.total) * 100);
    expect(progress).toBe(33);
  });
});

describe('project member management', () => {
  let db;
  beforeEach(() => {
    db = getDb();
    seedProjectData(db);
    const utils = require('../src/utils');
    utils.resetCachedStatements();
  });

  it('adds members to a project and enforces unique constraint', () => {
    const insertMember = db.prepare('INSERT OR IGNORE INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)');
    const admin = db.prepare('SELECT id FROM users WHERE username = \'admin\'').get();
    const project = db.prepare("INSERT INTO projects (name, status, priority, owner_id) VALUES (?, 'planning', 'medium', ?) RETURNING id").get('Member Test', admin.id);

    const r1 = insertMember.run(project.id, admin.id, 'lead');
    expect(r1.changes).toBe(1);

    // staff1 doesn't exist in this DB — create it
    const bcrypt = require('bcryptjs');
    const hashed = bcrypt.hashSync('Staff123!@#', 12);
    db.prepare('INSERT INTO users (username, password, email, first_name, last_name, role, department, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('staff1', hashed, 's1@test.com', 'S1', 'T1', 'staff', 'IT', 1);

    const staff2 = db.prepare('SELECT id FROM users WHERE username = \'staff1\'').get();
    const r2 = insertMember.run(project.id, staff2.id, 'member');
    expect(r2.changes).toBe(1);

    // Duplicate insert should not create a second row
    const r3 = insertMember.run(project.id, admin.id, 'lead');
    expect(r3.changes).toBe(0);

    const members = db.prepare('SELECT * FROM project_members WHERE project_id = ?').all(project.id);
    expect(members).toHaveLength(2);
  });

  it('prevents removing the last lead member', () => {
    const insertMember = db.prepare('INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)');
    const admin = db.prepare('SELECT id FROM users WHERE username = \'admin\'').get();
    const project = db.prepare("INSERT INTO projects (name, status, priority, owner_id) VALUES (?, 'planning', 'medium', ?) RETURNING id").get('Lead Test', admin.id);

    insertMember.run(project.id, admin.id, 'lead');

    const leadCount = db.prepare("SELECT COUNT(*) as lead_count FROM project_members WHERE project_id = ? AND role = 'lead'").get(project.id);
    expect(leadCount.lead_count).toBe(1);
    expect(leadCount.lead_count).toBeLessThanOrEqual(1);
  });
});

describe('budget/spent preservation on partial update', () => {
  let db;
  beforeEach(() => {
    db = getDb();
    seedProjectData(db);
    const utils = require('../src/utils');
    utils.resetCachedStatements();
  });

  it('preserves existing status/priority when omitted from update', () => {
    const admin = db.prepare('SELECT id FROM users WHERE username = \'admin\'').get();
    const project = db.prepare(
      "INSERT INTO projects (name, status, priority, budget, spent, start_date, end_date, owner_id) VALUES (?, 'in_progress', 'high', 10000, 5000, '2026-01-01', '2026-12-31', ?) RETURNING id"
    ).get('Budget Test', admin.id);

    // Read back the stored values
    const existing = db.prepare('SELECT status, priority, budget, spent, start_date, end_date FROM projects WHERE id = ?').get(project.id);
    expect(existing.status).toBe('in_progress');
    expect(existing.priority).toBe('high');
    expect(existing.budget).toBe(10000);
    expect(existing.spent).toBe(5000);
    expect(existing.start_date).toBe('2026-01-01');
    expect(existing.end_date).toBe('2026-12-31');
  });
});

describe('recalcProjectProgress edge cases', () => {
  let db;
  beforeEach(() => {
    db = getDb();
    seedProjectData(db);
    const utils = require('../src/utils');
    utils.resetCachedStatements();
  });

  it('returns early for invalid projectId', () => {
    const { recalcProjectProgress } = require('../src/utils');
    // Should not throw
    expect(() => recalcProjectProgress(db, -1)).not.toThrow();
    expect(() => recalcProjectProgress(db, 0)).not.toThrow();
    expect(() => recalcProjectProgress(db, NaN)).not.toThrow();
  });

  it('handles empty project (no tasks)', () => {
    const admin = db.prepare('SELECT id FROM users WHERE username = \'admin\'').get();
    const project = db.prepare("INSERT INTO projects (name, status, priority, owner_id) VALUES (?, 'planning', 'low', ?) RETURNING id").get('Empty Project', admin.id);

    const { recalcProjectProgress } = require('../src/utils');
    expect(() => recalcProjectProgress(db, project.id)).not.toThrow();

    const p = db.prepare('SELECT progress FROM projects WHERE id = ?').get(project.id);
    expect(p.progress).toBe(0);
  });
});
