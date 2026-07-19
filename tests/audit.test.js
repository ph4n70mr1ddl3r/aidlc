const { describe, it, expect, beforeAll, afterAll } = require('@jest/globals');
const Database = require('better-sqlite3');

// Test the real audit middleware against a real (in-memory) SQLite database so
// we exercise the actual prepared statement and details-coercion logic.
describe('audit middleware', () => {
  let db;
  let audit;

  beforeAll(() => {
    // Unmock better-sqlite3 so we get a real DB (app.test.js mocks it globally
    // for the app module, but this file does not import the app).
    jest.resetModules();
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id INTEGER,
        details TEXT,
        ip_address TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
    // Inject the prepared statement used by middleware/audit.js
    jest.doMock('../src/models/database', () => db);
    audit = require('../src/middleware/audit').audit;
  });

  afterAll(() => {
    db.close();
  });

  it('coerces a non-string details value to a string without crashing', () => {
    expect(() => audit({ req: null, action: 'read', entity: 'ticket', entityId: 1, details: { foo: 'bar' } })).not.toThrow();
    const row = db.prepare('SELECT details FROM audit_log ORDER BY id DESC LIMIT 1').get();
    expect(row.details).toBe('[object Object]');
  });

  it('coerces a numeric details value to a string', () => {
    audit({ req: null, action: 'read', entity: 'ticket', entityId: 2, details: 42 });
    const row = db.prepare('SELECT details FROM audit_log WHERE entity_id = 2 ORDER BY id DESC LIMIT 1').get();
    expect(row.details).toBe('42');
  });

  it('truncates over-length string details', () => {
    const long = 'x'.repeat(5000);
    audit({ req: null, action: 'read', entity: 'ticket', entityId: 3, details: long });
    const row = db.prepare('SELECT details FROM audit_log WHERE entity_id = 3 ORDER BY id DESC LIMIT 1').get();
    expect(row.details.length).toBeLessThanOrEqual(4000);
  });

  it('stores null for missing details', () => {
    audit({ req: null, action: 'read', entity: 'ticket', entityId: 4 });
    const row = db.prepare('SELECT details FROM audit_log WHERE entity_id = 4 ORDER BY id DESC LIMIT 1').get();
    expect(row.details).toBeNull();
  });

  it('preserves a legitimate entity_id of 0 (no falsy coercion)', () => {
    audit({ req: null, action: 'delete', entity: 'asset', entityId: 0, details: 'edge' });
    const row = db.prepare('SELECT entity_id FROM audit_log WHERE entity_id = 0 AND details = \'edge\' ORDER BY id DESC LIMIT 1').get();
    expect(row.entity_id).toBe(0);
  });

  it('logs the audit_log self-trail access (entity type now allowed)', () => {
    audit({ req: { session: { user: { id: 1 } }, ip: '127.0.0.1' }, action: 'read', entity: 'audit_log', entityId: null, details: 'Viewed audit log' });
    const row = db.prepare('SELECT entity_type, details FROM audit_log WHERE entity_type = \'audit_log\' ORDER BY id DESC LIMIT 1').get();
    expect(row.entity_type).toBe('audit_log');
    expect(row.details).toBe('Viewed audit log');
  });
});
