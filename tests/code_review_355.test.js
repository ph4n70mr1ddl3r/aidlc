const { describe, it, expect, beforeEach } = require('@jest/globals');

// Regression: PUT /profile previously wrote `phone = ?` unconditionally, so a
// partial submission that OMITTED the phone field persisted NULL and silently
// wiped the stored number. Every other update route (staff.js, vendors.js,
// assets.js, projects.js, tickets.js, licenses.js) resolves optional fields via
// resolveOptionalField, where an ABSENT field preserves the stored value and an
// explicit EMPTY string clears it. This pins the profile route to that
// convention so a future refactor cannot re-introduce the silent wipe.

let mockStmt;
jest.mock('../src/models/database', () => {
  mockStmt = { get: jest.fn(() => null), all: jest.fn(() => []), run: jest.fn(() => ({ changes: 1, lastInsertRowid: 1 })) };
  return { prepare: jest.fn(() => mockStmt), exec: jest.fn(), pragma: jest.fn(), transaction: jest.fn((fn) => fn), close: jest.fn() };
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

const { lastHandlerFor } = require('./helpers');
const authRouter = require('../src/routes/auth');

const STORED_PHONE = '555-0101';

async function runProfileUpdate(phone) {
  const h = lastHandlerFor(authRouter, 'put', '/profile');
  let redirectedTo = null;
  const body = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@company.com' };
  if (phone !== undefined) {
    body.phone = phone;
  }
  const req = {
    body,
    params: {},
    method: 'PUT',
    session: {
      user: { id: 1, role: 'admin', password_changed_at: null },
      regenerate: (cb) => cb(null)
    },
    flash: () => {}
  };
  const res = {
    redirect: (to) => {
      redirectedTo = to;
    },
    render: () => {},
    status: () => res,
    json: () => {}
  };
  await h(req, res, () => {});
  await new Promise((resolve) => setImmediate(resolve));
  // The profile UPDATE statement's .run() receives positional args:
  // (first_name, last_name, email, phone, user_id)
  const runCall = mockStmt.run.mock.calls[mockStmt.run.mock.calls.length - 1];
  return { redirectedTo, phone: runCall[3] };
}

describe('code review 355 — PUT /profile preserves the stored phone on partial submission', () => {
  beforeEach(() => {
    mockStmt.get.mockReset();
    mockStmt.get.mockReturnValue({
      id: 1, username: 'ada', email: 'ada@company.com', first_name: 'Ada',
      last_name: 'Lovelace', role: 'admin', department: 'IT', phone: STORED_PHONE,
      avatar: null, is_active: 1, last_login: null, password_changed_at: null,
      created_at: '2024-01-01', updated_at: '2024-01-01'
    });
    mockStmt.run.mockClear();
    mockStmt.run.mockReturnValue({ changes: 1, lastInsertRowid: 1 });
  });

  it('preserves the stored phone when the field is ABSENT (partial PUT)', async () => {
    const { phone } = await runProfileUpdate(undefined);
    expect(phone).toBe(STORED_PHONE);
  });

  it('clears the stored phone when the field is an explicit empty string', async () => {
    const { phone } = await runProfileUpdate('');
    expect(phone).toBeNull();
  });

  it('replaces the stored phone when a new value is submitted', async () => {
    const { phone } = await runProfileUpdate('555-0199');
    expect(phone).toBe('555-0199');
  });

  it('source uses resolveOptionalField for the profile phone (convention pin)', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'routes', 'auth.js'), 'utf8');
    expect(src).toMatch(/resolveOptionalField\(req\.body\.phone,\s*phone \|\| null,\s*MAX_PHONE/);
  });
});
