const { describe, it, expect } = require('@jest/globals');
const fs = require('fs');
const path = require('path');

describe('code review 208 — self-role-change denial audits access_denied', () => {
  it('staff.js PUT /:id audits access_denied when admin changes own role', () => {
    jest.resetModules();
    jest.mock('../src/middleware/auth', () => ({
      requireAuth: (req, res, next) => next(),
      requireAdminOrManager: (req, res, next) => next(),
      requireAdmin: (req, res, next) => next()
    }));
    jest.mock('../src/middleware/audit', () => ({
      auditMiddleware: (req, res, next) => {
        req.audit = jest.fn(); next();
      }
    }));
    jest.mock('../src/routes/dashboard', () => ({ invalidateDashboardCache: jest.fn() }));
    const staff = require('../src/routes/staff');
    const layer = staff.stack.find(l => l.route && l.route.methods.put && l.route.path === '/:id');
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    const flashStore = { success: [], error: [], info: [] };
    const audit = jest.fn();
    const req = {
      session: { user: { id: 1, role: 'admin' } },
      audit,
      flash: (type, msg) => {
        flashStore[type].push(msg);
      },
      body: { email: 'a@b.co', first_name: 'A', last_name: 'B', role: 'manager', department: '', phone: '' },
      params: { id: '1' }
    };
    const res = {
      headersSent: false,
      redirectCalls: [],
      redirect: jest.fn((url) => {
        res.redirectCalls.push(url); return res;
      })
    };
    handler(req, res, () => {});
    expect(res.redirectCalls).toEqual(['/staff']);
    expect(flashStore.error).toContain('You cannot change your own role.');
    // The self-role-change denial now leaves an audit trail, matching the
    // privileged-role and admin-protection denial paths in the same handler.
    expect(audit).toHaveBeenCalledWith('access_denied', 'user', 1, 'Unauthorized self-role-change attempt');
  });

  it('staff.js source pin: self-role-change denial path includes req.audit call', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'routes', 'staff.js'),
      'utf8'
    );
    // The self-role-change guard should carry an access_denied audit line.
    expect(src).toMatch(/self-role-change attempt/);
    // It must follow the guard check (not the privileged-role guard above it).
    const lines = src.split('\n');
    let foundSelfRoleGuard = false;
    let foundAuditAfterSelfRole = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes('Number(id) === Number(req.session.user.id)') &&
          line.includes('safeRole !== req.session.user.role')) {
        foundSelfRoleGuard = true;
      }
      if (foundSelfRoleGuard && line.includes('access_denied') &&
          line.includes('self-role-change attempt')) {
        foundAuditAfterSelfRole = true;
      }
    }
    expect(foundSelfRoleGuard).toBe(true);
    expect(foundAuditAfterSelfRole).toBe(true);
  });
});
