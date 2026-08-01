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

// Set dev secrets before requiring app.js to suppress the harmless dev-mode
// console.warn that fires when SESSION_SECRET / CSRF_SECRET are unset.
process.env.SESSION_SECRET = 'test-session-secret-do-not-use-in-production-32chars!!';
process.env.CSRF_SECRET = 'test-csrf-secret-do-not-use-in-production-32chars!!';

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
  let originalNodeEnv;

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('should normalize NODE_ENV to lowercase after app module is loaded', () => {
    // app.js normalizes NODE_ENV at require-time (trim + toLowerCase);
    // after loading, it must be a defined, lowercase value.
    expect(process.env.NODE_ENV).toBeDefined();
    expect(process.env.NODE_ENV).toBe(process.env.NODE_ENV.toLowerCase());
  });

  it('should preserve NODE_ENV value through app module normalization', () => {
    // Jest sets NODE_ENV to 'test'; the app module reads and normalizes it
    // (trim + toLowerCase) at require time. The value should survive unchanged.
    expect(process.env.NODE_ENV).toBe('test');
  });
});
