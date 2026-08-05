const { describe, it, expect, beforeEach } = require('@jest/globals');

// The auth middleware's role-sync check (row.role !== session role → session is
// updated) requires the mocked DB row's role to match the session user's role,
// so the mock reads the current test's expected role from a scoped variable.
let mockRowRole = 'staff';
jest.mock('../src/models/database', () => {
  const stmt = {
    get: jest.fn((uid) => ({ id: uid, is_active: 1, role: mockRowRole, password_changed_at: null })),
    run: jest.fn(),
    all: jest.fn(() => [])
  };
  return { prepare: jest.fn(() => stmt), exec: jest.fn(), pragma: jest.fn(), transaction: jest.fn((fn) => fn), close: jest.fn() };
});

const { requireRole, resetCachedStatements } = require('../src/middleware/auth');
const { resetCachedStatements: resetAuditStatements } = require('../src/middleware/audit');

describe('requireRole — access_denied audit trail (regression)', () => {
  // The 56th pass added req.audit('access_denied', ...) to the knowledge.js
  // authorization guards, but the central requireRole gate — the path hit by a
  // staff account probing any admin/manager-only route — silently dropped the
  // attempt with no audit trail. A compromised account probing privileged
  // endpoints must leave the same trace as every other authorization failure.

  beforeEach(() => {
    resetCachedStatements();
    resetAuditStatements();
    const db = jest.requireMock('../src/models/database');
    db.prepare.mockClear();
    db.prepare().run.mockClear();
  });

  it('records an access_denied audit entry when the role is not allowed', () => {
    mockRowRole = 'staff';
    const req = {
      session: { user: { id: 9, role: 'staff' } },
      method: 'GET',
      originalUrl: '/audit',
      flash: jest.fn()
    };
    const res = { redirect: jest.fn() };
    const next = jest.fn();
    requireRole('admin')(req, res, next);

    const db = jest.requireMock('../src/models/database');
    const stmt = db.prepare();
    expect(stmt.run).toHaveBeenCalled();
    // run(uid, action, entity, safeEntityId, safeDetails, ip) — the call's
    // args array IS the parameter list.
    const args = stmt.run.mock.calls[0];
    expect(args[0]).toBe(9); // user_id
    expect(args[1]).toBe('access_denied'); // action
    expect(args[2]).toBe('user'); // entity
    expect(res.redirect).toHaveBeenCalledWith('/');
    expect(next).not.toHaveBeenCalled();
  });

  it('does not audit and passes through when the role is allowed', () => {
    mockRowRole = 'admin';
    const req = {
      session: { user: { id: 9, role: 'admin' } },
      method: 'GET',
      originalUrl: '/audit',
      flash: jest.fn()
    };
    const res = { redirect: jest.fn() };
    const next = jest.fn();
    requireRole('admin')(req, res, next);

    const db = jest.requireMock('../src/models/database');
    expect(db.prepare().run).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });
});
