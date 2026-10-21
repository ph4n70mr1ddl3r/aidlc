const { describe, it, expect, beforeEach } = require('@jest/globals');
const { lastHandlerFor } = require('./helpers');

jest.mock('better-sqlite3');
jest.mock('../src/models/database', () => {
  const stmt = { get: jest.fn(() => null), all: jest.fn(() => []), run: jest.fn(() => ({ changes: 1, lastInsertRowid: 1 })) };
  return { prepare: jest.fn(() => stmt), exec: jest.fn(), pragma: jest.fn(), transaction: jest.fn((fn) => fn), close: jest.fn() };
});
jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => next(),
  requireAdminOrManager: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
  canAccessResource: jest.fn(() => true)
}));
jest.mock('../src/middleware/audit', () => ({
  audit: jest.fn(),
  auditMiddleware: (req, res, next) => {
    req.audit = jest.fn(); next();
  }
}));
jest.mock('../src/routes/dashboard', () => {
  const Router = require('express').Router;
  const router = Router();
  router.invalidateDashboardCache = jest.fn();
  return router;
});

function runPut(handler, body, params = { id: '1' }, sessionUser = { id: 1, role: 'admin' }) {
  const redirectCalls = [];
  const flashCalls = [];
  const req = { body, params, method: 'PUT', session: { user: sessionUser }, flash: (type, msg) => flashCalls.push([type, msg]), audit: jest.fn() };
  const res = {
    redirect: (to) => {
      redirectCalls.push(to);
    },
    render: () => {}, status: () => res, json: () => {}, end: () => {}
  };
  handler(req, res, () => {});
  return { redirectCalls, flashCalls };
}

function dbRunParams() {
  const db = jest.requireMock('../src/models/database');
  const calls = db.prepare().run.mock.calls;
  return calls[calls.length - 1];
}

describe('tickets update — requester_email absent-preserve (pass 364)', () => {
  const ticketsRouter = require('../src/routes/tickets');
  const CURRENT = {
    id: 1, status: 'open', category: 'hardware', priority: 'high',
    assigned_to: 1, asset_id: null, due_date: null,
    description: 'd', resolution_notes: null,
    requester_name: 'Bob', requester_email: 'bob@x.com',
    requester_department: 'IT', requester_phone: '555-123-4567'
  };

  beforeEach(() => {
    const db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    stmt.run.mockClear();
    stmt.get.mockReturnValue({ ...CURRENT });
  });

  it('preserves the stored requester_email when the field is absent on a partial PUT', () => {
    const h = lastHandlerFor(ticketsRouter, 'put', '/:id');
    const { redirectCalls, flashCalls } = runPut(h, {
      title: 'Renamed', category: 'hardware', priority: 'high', status: 'open'
    });
    expect(redirectCalls).toHaveLength(1);
    expect(flashCalls.some(([t]) => t === 'success')).toBe(true);
    // UPDATE param order: ..., requester_name(9), requester_email(10)
    expect(dbRunParams()[10]).toBe('bob@x.com');
  });

  it('rejects a present non-string requester_email (fail-closed)', () => {
    const h = lastHandlerFor(ticketsRouter, 'put', '/:id');
    const { redirectCalls, flashCalls } = runPut(h, {
      title: 'Renamed', category: 'hardware', priority: 'high', status: 'open',
      requester_email: 42
    });
    expect(redirectCalls).toHaveLength(1);
    expect(flashCalls.some(([t, m]) => t === 'error' && m === 'Invalid request parameters')).toBe(true);
  });

  it('still rejects an explicit empty requester_email (required field)', () => {
    const h = lastHandlerFor(ticketsRouter, 'put', '/:id');
    const { redirectCalls, flashCalls } = runPut(h, {
      title: 'Renamed', category: 'hardware', priority: 'high', status: 'open',
      requester_email: ''
    });
    expect(redirectCalls).toHaveLength(1);
    expect(flashCalls.some(([t, m]) => t === 'error' && m === 'Requester email is required')).toBe(true);
  });
});
