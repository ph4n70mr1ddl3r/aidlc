/**
 * Pass 368 — counter-collision regression tests, run against a REAL
 * in-memory SQLite database (not the shared jest mock) so the transaction
 * semantics that caused the bug are actually exercised.
 *
 * The bug: the asset-tag / ticket-number counter increment lived in the SAME
 * transaction as the INSERT. A UNIQUE violation therefore rolled the counter
 * increment back as well, so the next attempt regenerated the exact same
 * colliding value. Asset creation (and ticket creation) were permanently
 * wedged: every retry produced the identical failure until an administrator
 * renamed the conflicting row by hand.
 *
 * The fix retries inside the transaction, so each attempt consumes another
 * counter value and the loop walks past the taken value(s).
 */
process.env.DB_PATH = ':memory:';

const { describe, it, expect, beforeAll, beforeEach } = require('@jest/globals');
const { lastHandlerFor } = require('./helpers');

// The dashboard module caches query results and pulls in the full reporting
// surface; the cache invalidator is the only part the route modules use.
jest.mock('../src/routes/dashboard', () => {
  const Router = require('express').Router;
  const router = Router();
  router.invalidateDashboardCache = jest.fn();
  return router;
});

const db = require('../src/models/database');
const assetsRouter = require('../src/routes/assets');
const ticketsRouter = require('../src/routes/tickets');

const ADMIN = { id: 1, role: 'admin', is_active: 1, username: 'admin', password_changed_at: null };

function todayUtcStamp() {
  const now = new Date();
  return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
}

function runHandler(handler, { method = 'POST', body = {}, params = {}, sessionUser = ADMIN } = {}) {
  const redirectCalls = [];
  const flashCalls = [];
  const auditCalls = [];
  const req = {
    body, params, method,
    session: { user: sessionUser },
    flash: (type, msg) => flashCalls.push([type, msg]),
    audit: (...args) => auditCalls.push(args)
  };
  const res = {
    redirect: (to) => {
      redirectCalls.push(to);
    },
    render: () => {}, status: () => res, json: () => {}, end: () => {}
  };
  handler(req, res, () => {});
  return { redirectCalls, flashCalls, auditCalls };
}

beforeAll(() => {
  // A real session user so requireAuth/requireAdminOrManager would pass if the
  // route middleware ever ran (the handler is invoked directly here).
  db.prepare(`
    INSERT INTO users (id, username, email, first_name, last_name, role, password, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(ADMIN.id, ADMIN.username, 'admin@example.com', 'Ada', 'Admin', ADMIN.role, 'x', ADMIN.is_active);
});

beforeEach(() => {
  db.exec('DELETE FROM assets; DELETE FROM tickets; DELETE FROM asset_counter; DELETE FROM ticket_counter;');
});

describe('asset tag counter survives a tag collision (pass 368)', () => {
  const createAsset = lastHandlerFor(assetsRouter, 'post', '/');

  it('creates the asset with the next free tag when the counter value is already taken', () => {
    // An admin renamed an existing asset to the tag the counter is about to
    // hand out — the exact production trigger for the wedge.
    db.prepare('INSERT INTO assets (asset_tag, name, category) VALUES (?, ?, ?)')
      .run('AST-001', 'Existing', 'laptop');

    const { redirectCalls, flashCalls } = runHandler(createAsset, {
      body: { name: 'New Laptop', category: 'laptop' }
    });

    expect(flashCalls).toContainEqual(['success', 'Asset AST-002 created successfully.']);
    expect(redirectCalls).toEqual(['/assets']);

    const rows = db.prepare('SELECT asset_tag FROM assets ORDER BY id').all();
    expect(rows.map(r => r.asset_tag)).toEqual(['AST-001', 'AST-002']);

    // The counter committed the consumed sequence value, so the next create
    // continues from AST-003 rather than regenerating the colliding tag.
    expect(db.prepare('SELECT next_seq FROM asset_counter WHERE counter_key = ?').get('asset_tag'))
      .toEqual({ next_seq: 2 });
  });

  it('still uses AST-001 when there is no collision', () => {
    const { flashCalls } = runHandler(createAsset, {
      body: { name: 'First Laptop', category: 'laptop' }
    });
    expect(flashCalls).toContainEqual(['success', 'Asset AST-001 created successfully.']);
    expect(db.prepare('SELECT asset_tag FROM assets').all()).toEqual([{ asset_tag: 'AST-001' }]);
  });

  it('does NOT retry a serial_number collision and reports it accurately', () => {
    // The serial_number partial unique index is a DIFFERENT constraint — the
    // retry loop must not burn counter values on it, and the catch block must
    // report the serial (not the tag) as the cause.
    db.prepare('INSERT INTO assets (asset_tag, name, category, serial_number) VALUES (?, ?, ?, ?)')
      .run('AST-050', 'Existing', 'laptop', 'SN-DUPLICATE');

    const { flashCalls } = runHandler(createAsset, {
      body: { name: 'New Laptop', category: 'laptop', serial_number: 'SN-DUPLICATE' }
    });

    expect(flashCalls).toContainEqual(['error', 'An asset with this serial number already exists']);
    expect(db.prepare('SELECT COUNT(*) AS n FROM assets').get()).toEqual({ n: 1 });
    // The failed transaction rolled the counter back — no sequence value was
    // consumed by the rejected attempt.
    expect(db.prepare('SELECT COUNT(*) AS n FROM asset_counter').get()).toEqual({ n: 0 });
  });
});

describe('ticket number counter survives a number collision (pass 368)', () => {
  const createTicket = lastHandlerFor(ticketsRouter, 'post', '/');

  const body = {
    title: 'Printer offline',
    category: 'hardware',
    priority: 'medium',
    requester_name: 'Requester',
    requester_email: 'requester@example.com'
  };

  it('creates the ticket with the next free number when the counter value is already taken', () => {
    const today = todayUtcStamp();
    db.prepare(`
      INSERT INTO tickets (ticket_number, title, category, priority, requester_name, requester_email)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(`TK-${today}-001`, 'Existing', 'hardware', 'medium', 'Someone', 'someone@example.com');

    const { redirectCalls, flashCalls } = runHandler(createTicket, { body });

    expect(flashCalls).toContainEqual(['success', `Ticket TK-${today}-002 created successfully.`]);
    expect(redirectCalls).toEqual(['/tickets']);

    const rows = db.prepare('SELECT ticket_number FROM tickets ORDER BY id').all();
    expect(rows.map(r => r.ticket_number)).toEqual([`TK-${today}-001`, `TK-${today}-002`]);
  });

  it('still uses TK-<today>-001 when there is no collision', () => {
    const today = todayUtcStamp();
    const { flashCalls } = runHandler(createTicket, { body });
    expect(flashCalls).toContainEqual(['success', `Ticket TK-${today}-001 created successfully.`]);
    expect(db.prepare('SELECT ticket_number FROM tickets').all()).toEqual([{ ticket_number: `TK-${today}-001` }]);
  });
});
