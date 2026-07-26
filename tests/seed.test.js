const { describe, it, expect } = require('@jest/globals');
const Database = require('better-sqlite3');

// Schema SQL extracted from src/models/database.js so the seed test can create
// an isolated in-memory database without depending on module loading side effects.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff' CHECK(role IN ('admin','manager','staff')),
  department TEXT DEFAULT 'IT',
  phone TEXT,
  avatar TEXT,
  is_active INTEGER DEFAULT 1,
  last_login TEXT,
  password_changed_at TEXT DEFAULT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_tag TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('laptop','desktop','server','monitor','printer','network','phone','tablet','software','peripheral','other')),
  manufacturer TEXT, model TEXT, serial_number TEXT,
  status TEXT NOT NULL DEFAULT 'in_storage' CHECK(status IN ('in_use','in_storage','in_repair','disposed','reserved')),
  condition_rating TEXT DEFAULT 'good' CHECK(condition_rating IN ('new','good','fair','poor','broken')),
  purchase_date TEXT, purchase_price REAL, warranty_expiry TEXT, assigned_to INTEGER, location TEXT, notes TEXT,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (assigned_to) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS licenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  software_name TEXT NOT NULL, vendor TEXT, license_key TEXT, license_type TEXT NOT NULL CHECK(license_type IN ('perpetual','subscription','volume','oem','academic')),
  total_seats INTEGER DEFAULT 0, used_seats INTEGER DEFAULT 0, purchase_date TEXT, expiry_date TEXT, cost REAL, notes TEXT,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_number TEXT UNIQUE NOT NULL, title TEXT NOT NULL, description TEXT,
  category TEXT NOT NULL CHECK(category IN ('hardware','software','network','access','email','security','other')),
  priority TEXT NOT NULL CHECK(priority IN ('critical','high','medium','low')),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','waiting','resolved','closed')),
  requester_name TEXT, requester_email TEXT, requester_department TEXT,
  assigned_to INTEGER, asset_id INTEGER, due_date TEXT,
  resolution_notes TEXT, resolved_at TEXT, satisfaction_rating INTEGER,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (assigned_to) REFERENCES users(id), FOREIGN KEY (asset_id) REFERENCES assets(id)
);
CREATE TABLE IF NOT EXISTS ticket_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL, user_id INTEGER, comment TEXT NOT NULL, is_internal INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE, FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, description TEXT,
  status TEXT NOT NULL DEFAULT 'planning' CHECK(status IN ('planning','in_progress','on_hold','completed','cancelled')),
  priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('critical','high','medium','low')),
  start_date TEXT, end_date TEXT, budget REAL DEFAULT 0, spent REAL DEFAULT 0, progress INTEGER DEFAULT 0, owner_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (owner_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS project_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL, title TEXT NOT NULL, description TEXT,
  status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','in_progress','review','done')),
  priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('high','medium','low')),
  assigned_to INTEGER, due_date TEXT, completed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE, FOREIGN KEY (assigned_to) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS project_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('lead','member','stakeholder')),
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE, FOREIGN KEY (user_id) REFERENCES users(id),
  UNIQUE(project_id, user_id)
);
CREATE TABLE IF NOT EXISTS vendors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, contact_person TEXT, email TEXT, phone TEXT, website TEXT,
  category TEXT NOT NULL CHECK(category IN ('hardware','cloud','security','network','maintenance','software','consulting','telecom','other')),
  contract_start TEXT, contract_end TEXT, rating INTEGER, notes TEXT, is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS knowledge_articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL, content TEXT NOT NULL, rendered_content TEXT, category TEXT NOT NULL CHECK(category IN ('how_to','troubleshooting','policy','faq','sop','other')),
  tags TEXT, author_id INTEGER, status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','archived')),
  is_featured INTEGER DEFAULT 0, view_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (author_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS change_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL, description TEXT,
  change_type TEXT NOT NULL CHECK(change_type IN ('maintenance','upgrade','incident','security','configuration')),
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','in_progress','completed','failed','cancelled')),
  priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('critical','high','medium','low')),
  scheduled_start TEXT, scheduled_end TEXT, actual_start TEXT, actual_end TEXT, impact TEXT, assigned_to INTEGER, notes TEXT,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (assigned_to) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  details TEXT,
  ip_address TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS ticket_counter (counter_date TEXT PRIMARY KEY, next_seq INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS asset_counter (counter_key TEXT PRIMARY KEY, next_seq INTEGER NOT NULL DEFAULT 1);
`;

describe('seed.js runSeed', () => {
  it('sets asset_counter next_seq to number of seeded assets (no AST-013 skip)', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA_SQL);

    const { runSeed } = require('../src/seed');
    runSeed(db, 'Admin123!', 'Staff123!');

    const counter = db.prepare("SELECT next_seq FROM asset_counter WHERE counter_key = 'asset_tag'").get();
    expect(counter).toBeTruthy();
    // 12 assets seeded → next_seq set to 12. On first create after seed the
    // ON CONFLICT clause increments from 12 to 13 → AST-013 (correct).
    expect(counter.next_seq).toBe(12);
    db.close();
  });

  it('creates expected record counts', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA_SQL);

    const { runSeed } = require('../src/seed');
    runSeed(db, 'Admin123!', 'Staff123!');

    const count = (table) => db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get().c;
    expect(count('users')).toBe(6);
    expect(count('assets')).toBe(12);
    expect(count('licenses')).toBe(7);
    expect(count('tickets')).toBe(10);
    expect(count('ticket_comments')).toBe(5);
    expect(count('projects')).toBe(5);
    expect(count('project_tasks')).toBe(9);
    expect(count('project_members')).toBe(11);
    expect(count('vendors')).toBe(5);
    expect(count('knowledge_articles')).toBe(6);
    expect(count('change_log')).toBe(5);
    db.close();
  });

  it('last seeded asset is AST-012, next counter gives AST-013', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA_SQL);

    const { runSeed } = require('../src/seed');
    runSeed(db, 'Admin123!', 'Staff123!');

    const lastAsset = db.prepare('SELECT asset_tag FROM assets ORDER BY id DESC LIMIT 1').get();
    expect(lastAsset.asset_tag).toBe('AST-012');

    // Simulate the actual counter logic from assets.js:
    const nextSeq = db.prepare("UPDATE asset_counter SET next_seq = next_seq + 1 WHERE counter_key = 'asset_tag' RETURNING next_seq").get();
    expect(nextSeq.next_seq).toBe(13);
    db.close();
  });

  it('hashes user passwords with bcrypt', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA_SQL);

    const { runSeed } = require('../src/seed');
    runSeed(db, 'Admin123!', 'Staff123!');

    const bcrypt = require('bcryptjs');
    const user = db.prepare("SELECT password FROM users WHERE username = 'admin'").get();
    expect(user.password).toBeTruthy();
    expect(user.password.startsWith('$2a$')).toBe(true);
    expect(bcrypt.compareSync('Admin123!', user.password)).toBe(true);
    db.close();
  });
});
