const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || './data/itmanager.db';

// Ensure data directory exists
const dir = path.dirname(DB_PATH);
fs.mkdirSync(dir, { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// Wait up to 5 seconds if the database is locked by another writer
db.pragma('busy_timeout = 5000');
// NORMAL is safe with WAL and much faster than FULL
db.pragma('synchronous = NORMAL');

// ---------------------------------------------------------------------------
// Initialize schema (only run once even if module is required multiple times)
// ---------------------------------------------------------------------------
let schemaInitialized = false;

function initSchema() {
  if (schemaInitialized) return;
  schemaInitialized = true;

  db.exec(`
    -- ========================
    -- USERS / AUTH
    -- ========================
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
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- ========================
    -- ASSETS
    -- ========================
    CREATE TABLE IF NOT EXISTS assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_tag TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL CHECK(category IN (
        'laptop','desktop','server','monitor','printer','network','phone',
        'tablet','software','peripheral','other'
      )),
      manufacturer TEXT,
      model TEXT,
      serial_number TEXT,
      status TEXT NOT NULL DEFAULT 'in_storage' CHECK(status IN (
        'in_use','in_storage','in_repair','disposed','reserved'
      )),
      condition_rating TEXT DEFAULT 'good' CHECK(condition_rating IN ('new','good','fair','poor','broken')),
      purchase_date TEXT,
      purchase_price REAL,
      warranty_expiry TEXT,
      assigned_to INTEGER,
      location TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (assigned_to) REFERENCES users(id)
    );

    -- ========================
    -- SOFTWARE LICENSES
    -- ========================
    CREATE TABLE IF NOT EXISTS licenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      software_name TEXT NOT NULL,
      vendor TEXT,
      license_key TEXT,
      license_type TEXT CHECK(license_type IN ('perpetual','subscription','volume','oem','academic')),
      total_seats INTEGER DEFAULT 1,
      used_seats INTEGER DEFAULT 0,
      purchase_date TEXT,
      expiry_date TEXT,
      cost REAL,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- ========================
    -- TICKETS
    -- ========================
    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_number TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      category TEXT NOT NULL CHECK(category IN (
        'hardware','software','network','access','email','security','other'
      )),
      priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('critical','high','medium','low')),
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN (
        'open','in_progress','waiting','resolved','closed'
      )),
      requester_name TEXT NOT NULL,
      requester_email TEXT NOT NULL,
      requester_department TEXT,
      requester_phone TEXT,
      assigned_to INTEGER,
      asset_id INTEGER,
      due_date TEXT,
      resolved_at TEXT,
      resolution_notes TEXT,
      satisfaction_rating INTEGER CHECK(satisfaction_rating BETWEEN 1 AND 5),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (assigned_to) REFERENCES users(id),
      FOREIGN KEY (asset_id) REFERENCES assets(id)
    );

    -- ========================
    -- TICKET COMMENTS
    -- ========================
    CREATE TABLE IF NOT EXISTS ticket_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      comment TEXT NOT NULL,
      is_internal INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- ========================
    -- PROJECTS
    -- ========================
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'planning' CHECK(status IN (
        'planning','in_progress','on_hold','completed','cancelled'
      )),
      priority TEXT DEFAULT 'medium' CHECK(priority IN ('critical','high','medium','low')),
      start_date TEXT,
      end_date TEXT,
      budget REAL DEFAULT 0,
      spent REAL DEFAULT 0,
      progress INTEGER DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
      owner_id INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (owner_id) REFERENCES users(id)
    );

    -- ========================
    -- PROJECT TASKS
    -- ========================
    CREATE TABLE IF NOT EXISTS project_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','in_progress','review','done')),
      priority TEXT DEFAULT 'medium' CHECK(priority IN ('high','medium','low')),
      assigned_to INTEGER,
      due_date TEXT,
      completed_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (assigned_to) REFERENCES users(id)
    );

    -- ========================
    -- PROJECT MEMBERS
    -- ========================
    CREATE TABLE IF NOT EXISTS project_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      role TEXT DEFAULT 'member' CHECK(role IN ('lead','member','stakeholder')),
      joined_at TEXT DEFAULT (datetime('now')),
      UNIQUE(project_id, user_id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- ========================
    -- VENDORS
    -- ========================
    CREATE TABLE IF NOT EXISTS vendors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      contact_person TEXT,
      email TEXT,
      phone TEXT,
      address TEXT,
      website TEXT,
      category TEXT CHECK(category IS NULL OR category IN (
        'hardware','cloud','security','network','maintenance','software','consulting','telecom','other'
      )),
      contract_start TEXT,
      contract_end TEXT,
      notes TEXT,
      rating INTEGER CHECK(rating BETWEEN 1 AND 5),
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- ========================
    -- KNOWLEDGE BASE
    -- ========================
    CREATE TABLE IF NOT EXISTS knowledge_articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      category TEXT NOT NULL CHECK(category IN (
        'how_to','troubleshooting','policy','faq','sop','other'
      )),
      tags TEXT,
      author_id INTEGER,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','archived')),
      views INTEGER DEFAULT 0,
      is_featured INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (author_id) REFERENCES users(id)
    );

    -- ========================
    -- MAINTENANCE / CHANGE LOG
    -- ========================
    CREATE TABLE IF NOT EXISTS change_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      change_type TEXT NOT NULL CHECK(change_type IN (
        'maintenance','upgrade','incident','security','configuration'
      )),
      status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN (
        'scheduled','in_progress','completed','failed','cancelled'
      )),
      priority TEXT DEFAULT 'medium' CHECK(priority IN ('critical','high','medium','low')),
      scheduled_start TEXT,
      scheduled_end TEXT,
      actual_start TEXT,
      actual_end TEXT,
      impact TEXT,
      assigned_to INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (assigned_to) REFERENCES users(id)
    );

    -- ========================
    -- AUDIT LOG
    -- ========================
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id INTEGER,
      details TEXT,
      ip_address TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- ========================
    -- TICKET COUNTER (for atomic ticket number generation)
    -- ========================
    CREATE TABLE IF NOT EXISTS ticket_counter (
      counter_date TEXT PRIMARY KEY,
      next_seq INTEGER NOT NULL DEFAULT 1
    );

    -- ========================
    -- INDEXES
    -- ========================
    CREATE INDEX IF NOT EXISTS idx_assets_tag ON assets(asset_tag);
    CREATE INDEX IF NOT EXISTS idx_assets_status ON assets(status);
    CREATE INDEX IF NOT EXISTS idx_tickets_number ON tickets(ticket_number);
    CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
    CREATE INDEX IF NOT EXISTS idx_tickets_priority ON tickets(priority);
    CREATE INDEX IF NOT EXISTS idx_tickets_assigned ON tickets(assigned_to);
    CREATE INDEX IF NOT EXISTS idx_tickets_created ON tickets(created_at);
    CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
    CREATE INDEX IF NOT EXISTS idx_kb_status ON knowledge_articles(status);
    CREATE INDEX IF NOT EXISTS idx_kb_category ON knowledge_articles(category);
    CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_tickets_asset ON tickets(asset_id);
    CREATE INDEX IF NOT EXISTS idx_assets_assigned ON assets(assigned_to);
    CREATE INDEX IF NOT EXISTS idx_changes_scheduled ON change_log(scheduled_start);
    CREATE INDEX IF NOT EXISTS idx_changes_status ON change_log(status);
    CREATE INDEX IF NOT EXISTS idx_licenses_expiry ON licenses(expiry_date);
    CREATE INDEX IF NOT EXISTS idx_tickets_resolved ON tickets(resolved_at);
    CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);
    CREATE INDEX IF NOT EXISTS idx_assets_warranty ON assets(warranty_expiry);
    CREATE INDEX IF NOT EXISTS idx_vendors_active ON vendors(is_active);
    CREATE INDEX IF NOT EXISTS idx_project_tasks_status ON project_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_project_tasks_assigned ON project_tasks(assigned_to);
    CREATE INDEX IF NOT EXISTS idx_project_tasks_project ON project_tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_ticket_comments_ticket_created ON ticket_comments(ticket_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_project_members_project ON project_members(project_id);
    CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_licenses_software ON licenses(software_name);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_serial ON assets(serial_number) WHERE serial_number IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_tickets_requester_email ON tickets(requester_email);
    CREATE INDEX IF NOT EXISTS idx_kb_author ON knowledge_articles(author_id);
    CREATE INDEX IF NOT EXISTS idx_kb_featured ON knowledge_articles(is_featured) WHERE is_featured = 1;
    CREATE INDEX IF NOT EXISTS idx_changes_assigned ON change_log(assigned_to);
    CREATE INDEX IF NOT EXISTS idx_changes_priority ON change_log(priority);
    CREATE INDEX IF NOT EXISTS idx_changes_type ON change_log(change_type);
    CREATE INDEX IF NOT EXISTS idx_vendors_category ON vendors(category);
    CREATE INDEX IF NOT EXISTS idx_licenses_vendor ON licenses(vendor);
    CREATE INDEX IF NOT EXISTS idx_ticket_comments_user ON ticket_comments(user_id);
    CREATE INDEX IF NOT EXISTS idx_assets_category ON assets(category);
    CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects(updated_at);
    CREATE INDEX IF NOT EXISTS idx_changes_updated ON change_log(updated_at);
    CREATE INDEX IF NOT EXISTS idx_kb_updated ON knowledge_articles(updated_at);
  `);
}

initSchema();

module.exports = db;
