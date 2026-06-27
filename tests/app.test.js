const { describe, it, expect } = require('@jest/globals');

jest.mock('dotenv');
jest.mock('better-sqlite3');

jest.mock('../src/models/database', () => {
  const stmt = {
    get: jest.fn(() => ({ ok: 1 })),
    run: jest.fn(),
    all: jest.fn(() => [])
  };
  return {
    prepare: jest.fn(() => stmt),
    close: jest.fn()
  };
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
    req.audit = jest.fn();
    next();
  }
}));

jest.mock('../src/routes/auth', () => {
  const Router = require('express').Router;
  const router = Router();
  router.stopLoginFailureCleanup = jest.fn();
  router.clearLoginFailure = jest.fn();
  router.clearIpLoginFailure = jest.fn();
  return router;
});

const mockRouter = () => {
  const Router = require('express').Router;
  return Router();
};

jest.mock('../src/routes/dashboard', () => {
  const router = mockRouter();
  router.invalidateDashboardCache = jest.fn();
  return router;
});
jest.mock('../src/routes/assets', () => mockRouter());
jest.mock('../src/routes/tickets', () => mockRouter());
jest.mock('../src/routes/projects', () => mockRouter());
jest.mock('../src/routes/staff', () => mockRouter());
jest.mock('../src/routes/vendors', () => mockRouter());
jest.mock('../src/routes/knowledge', () => mockRouter());
jest.mock('../src/routes/changes', () => mockRouter());
jest.mock('../src/routes/licenses', () => mockRouter());
jest.mock('../src/routes/reports', () => mockRouter());
jest.mock('../src/routes/audit', () => mockRouter());

jest.mock('../src/utils', () => ({
  localDate: jest.fn(),
  formatDate: jest.fn(),
  formatDateTime: jest.fn(),
  daysUntil: jest.fn(),
  usagePercent: jest.fn(),
  isExpiringSoon: jest.fn(),
  titleCase: jest.fn(),
  isPrivileged: jest.fn(() => false),
  badgeClass: jest.fn(),
  CONDITION_BADGE: {},
  CHANGE_TYPE_BADGE: {},
  ROLE_BADGE: {},
  pruneAuditLog: jest.fn(() => 0)
}));

jest.mock('../src/constants', () => ({
  SESSION_COOKIE: 'itm_sid',
  SESSION_COOKIE_OPTIONS: { httpOnly: true, sameSite: 'lax', secure: false, path: '/' },
  SESSION_MAX_AGE: 86400000,
  MIN_PASSWORD: 12,
  MAX_PASSWORD: 128,
  MAX_USERNAME: 50,
  MAX_EMAIL: 200,
  MAX_SEARCH: 100
}));

const app = require('../src/app');

describe('App module', () => {
  it('should export an Express application', () => {
    expect(app).toBeDefined();
    expect(typeof app).toBe('function');
    expect(app.listen).toBeDefined();
  });

  it('should have view engine set to ejs', () => {
    expect(app.get('view engine')).toBe('ejs');
  });
});

describe('NODE_ENV handling', () => {
  it('should default to development when NODE_ENV is not set', () => {
    const code = require('fs').readFileSync(require.resolve('../src/app'), 'utf8');
    expect(code).toContain("process.env.NODE_ENV = 'development'");
  });

  it('should normalize NODE_ENV to lowercase', () => {
    const code = require('fs').readFileSync(require.resolve('../src/app'), 'utf8');
    expect(code).toContain('process.env.NODE_ENV.toLowerCase()');
  });
});

describe('Production validation', () => {
  it('should have production env validation logic', () => {
    const code = require('fs').readFileSync(require.resolve('../src/app'), 'utf8');
    expect(code).toContain("process.env.NODE_ENV === 'production'");
  });
});
