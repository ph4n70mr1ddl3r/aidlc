const { describe, it, expect } = require('@jest/globals');
const Database = require('better-sqlite3');
const path = require('path');

// Read schema SQL directly from database.js to avoid duplication.
// The initSchema() function in database.js contains all CREATE TABLE statements
// as a single multi-line string. We extract it by reading the source file.
function readSchemaSQL() {
  const appPath = path.join(__dirname, '..', 'src', 'models', 'database.js');
  const src = require('fs').readFileSync(appPath, 'utf8');
  // Extract the SQL string between the backticks of db.exec(`...`)
  const match = src.match(/db\.exec\(\s*`([\s\S]*?)`\s*\)/);
  if (!match) {
    throw new Error('Could not find initSchema SQL in database.js');
  }
  return match[1];
}

// Lazy-load schema so it's only parsed once per test run
let _schemaSQL = null;
function getSchemaSQL() {
  if (!_schemaSQL) {
    _schemaSQL = readSchemaSQL();
  }
  return _schemaSQL;
}

describe('seed.js runSeed', () => {
  it('sets asset_counter next_seq to number of seeded assets (no AST-013 skip)', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(getSchemaSQL());

    const { runSeed } = require('../src/seed');
    runSeed(db, 'AdminPassword123!', 'StaffPassword123!');

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
    db.exec(getSchemaSQL());

    const { runSeed } = require('../src/seed');
    runSeed(db, 'AdminPassword123!', 'StaffPassword123!');

    const count = (table) => db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get().c;
    expect(count('users')).toBe(6);
    expect(count('assets')).toBe(12);
    expect(count('licenses')).toBe(7);
    expect(count('tickets')).toBe(10);
    expect(count('ticket_comments')).toBe(5);
    expect(count('projects')).toBe(5);
    // 9 task-list entries + 1 done task for project 5 ('completed', 1/1 = 100)
    // so its seeded progress matches recalcProjectProgress.
    expect(count('project_tasks')).toBe(10);
    expect(count('project_members')).toBe(11);
    expect(count('vendors')).toBe(5);
    expect(count('knowledge_articles')).toBe(6);
    expect(count('change_log')).toBe(5);
    db.close();
  });

  it('seeds scheduled changes in the future so dashboard Upcoming Changes stays populated', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(getSchemaSQL());

    const { runSeed } = require('../src/seed');
    const before = Date.now();
    runSeed(db, 'AdminPassword123!', 'StaffPassword123!');

    // Scheduled changes are anchored relative to seed time (not hardcoded
    // absolute dates, which drift into the past and empty the dashboard panel).
    const scheduled = db.prepare("SELECT scheduled_start FROM change_log WHERE status = 'scheduled'").all();
    expect(scheduled.length).toBe(3);
    for (const row of scheduled) {
      const d = new Date(row.scheduled_start.replace(' ', 'T') + 'Z');
      expect(d.getTime()).toBeGreaterThan(before);
    }
    db.close();
  });

  it('last seeded asset is AST-012, next counter gives AST-013', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(getSchemaSQL());

    const { runSeed } = require('../src/seed');
    runSeed(db, 'AdminPassword123!', 'StaffPassword123!');

    const lastAsset = db.prepare('SELECT asset_tag FROM assets ORDER BY id DESC LIMIT 1').get();
    expect(lastAsset.asset_tag).toBe('AST-012');

    // The asset-tag counter is seeded to the LAST issued sequence (AST-012 =
    // 12); assets.js generates the next tag via INSERT ... ON CONFLICT ...
    // next_seq + 1 RETURNING, so a create after seeding yields AST-013. Assert
    // the seeded counter row directly instead of replaying the counter SQL
    // here — that would duplicate the implementation and mutate the counter
    // mid-test.
    const counter = db.prepare("SELECT next_seq FROM asset_counter WHERE counter_key = 'asset_tag'").get();
    expect(counter.next_seq).toBe(12);
    expect(counter.next_seq).toBe(Number(lastAsset.asset_tag.replace(/^AST-/, '')));
    db.close();
  });

  it('hashes user passwords with bcrypt', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(getSchemaSQL());

    const { runSeed } = require('../src/seed');
    runSeed(db, 'AdminPassword123!', 'StaffPassword123!');

    const bcrypt = require('bcryptjs');
    const user = db.prepare("SELECT password FROM users WHERE username = 'admin'").get();
    expect(user.password).toBeTruthy();
    expect(user.password).toMatch(/^\$2[aby]\$/);
    expect(bcrypt.compareSync('AdminPassword123!', user.password)).toBe(true);
    db.close();
  });

  it('seeds only values the application itself accepts (enums in constants.js, money/seat caps respected)', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(getSchemaSQL());

    const { runSeed } = require('../src/seed');
    runSeed(db, 'AdminPassword123!', 'StaffPassword123!');

    // A seed value outside a documented enum (or above a documented cap) is
    // accepted by the seeder but rejected by the matching write route, so the
    // seeded rows become un-editable. Pin the seed data to the same allowlists
    // and caps the routes enforce (src/constants.js).
    const constants = require('../src/constants');
    const inEnum = (rows, column, allow) => rows.every((r) => allow.includes(r[column]));

    expect(inEnum(db.prepare('SELECT role, department FROM users').all(), 'role', constants.USER_ROLES)).toBe(true);
    expect(inEnum(db.prepare('SELECT status, condition_rating FROM assets').all(), 'status', constants.ASSET_STATUSES)).toBe(true);
    expect(inEnum(db.prepare('SELECT status, condition_rating FROM assets').all(), 'condition_rating', constants.ASSET_CONDITIONS)).toBe(true);
    const categories = new Set(db.prepare('SELECT DISTINCT category FROM assets').all().map((r) => r.category));
    for (const c of categories) {
      expect(constants.ASSET_CATEGORIES.includes(c)).toBe(true);
    }
    expect(inEnum(db.prepare('SELECT status, priority FROM tickets').all(), 'status', constants.TICKET_STATUSES)).toBe(true);
    expect(inEnum(db.prepare('SELECT status, priority FROM tickets').all(), 'priority', constants.TICKET_PRIORITIES)).toBe(true);
    expect(inEnum(db.prepare('SELECT category FROM tickets').all(), 'category', constants.TICKET_CATEGORIES)).toBe(true);
    expect(inEnum(db.prepare('SELECT status, priority FROM projects').all(), 'status', constants.PROJECT_STATUSES)).toBe(true);
    expect(inEnum(db.prepare('SELECT status, priority FROM projects').all(), 'priority', constants.PROJECT_PRIORITIES)).toBe(true);
    expect(inEnum(db.prepare('SELECT status, priority FROM project_tasks').all(), 'status', constants.TASK_STATUSES)).toBe(true);
    expect(inEnum(db.prepare('SELECT status, priority FROM project_tasks').all(), 'priority', constants.TASK_PRIORITIES)).toBe(true);
    expect(inEnum(db.prepare('SELECT role FROM project_members').all(), 'role', constants.MEMBER_ROLES)).toBe(true);
    expect(inEnum(db.prepare('SELECT status, change_type, priority FROM change_log').all(), 'status', constants.CHANGE_STATUSES)).toBe(true);
    expect(inEnum(db.prepare('SELECT status, change_type, priority FROM change_log').all(), 'change_type', constants.CHANGE_TYPES)).toBe(true);
    expect(inEnum(db.prepare('SELECT status, change_type, priority FROM change_log').all(), 'priority', constants.CHANGE_PRIORITIES)).toBe(true);
    expect(inEnum(db.prepare('SELECT license_type FROM licenses').all(), 'license_type', [...constants.LICENSE_TYPES, null])).toBe(true);
    expect(inEnum(db.prepare('SELECT category FROM vendors').all(), 'category', [...constants.VENDOR_CATEGORIES, null])).toBe(true);

    // Numeric caps: the seeder must stay within the limits the forms declare
    // (MAX_MONEY_AMOUNT / MAX_SEAT_COUNT) or the route would refuse the value.
    const money = [
      ...db.prepare('SELECT purchase_price FROM assets').all().map((r) => r.purchase_price),
      ...db.prepare('SELECT cost FROM licenses').all().map((r) => r.cost),
      ...db.prepare('SELECT budget, spent FROM projects').all().flatMap((r) => [r.budget, r.spent])
    ].filter((v) => v != null);
    expect(money.length).toBeGreaterThan(0);
    for (const v of money) {
      expect(v).toBeLessThanOrEqual(constants.MAX_MONEY_AMOUNT);
    }
    for (const row of db.prepare('SELECT total_seats, used_seats FROM licenses').all()) {
      expect(row.total_seats).toBeLessThanOrEqual(constants.MAX_SEAT_COUNT);
      expect(row.used_seats).toBeLessThanOrEqual(constants.MAX_SEAT_COUNT);
    }
    db.close();
  });

  it('refuses to seed under a case/whitespace NODE_ENV variant of production', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(getSchemaSQL());

    const { runSeed } = require('../src/seed');
    const original = process.env.NODE_ENV;
    try {
      // app.js normalizes NODE_ENV via trim().toLowerCase(); the runSeed guard
      // must do the same so "Production " (or "PRODUCTION") cannot bypass it.
      process.env.NODE_ENV = 'Production ';
      expect(() => runSeed(db, 'AdminPassword123!', 'StaffPassword123!')).toThrow(/Seeding in production is disabled/);
      // Nothing may be written when the guard fires.
      expect(db.prepare('SELECT COUNT(*) as c FROM users').get().c).toBe(0);
    } finally {
      if (original === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = original;
      }
    }
    db.close();
  });
});
