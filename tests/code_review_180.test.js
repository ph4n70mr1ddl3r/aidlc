const { describe, it, expect } = require('@jest/globals');
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');
const utils = require('../src/utils');
const constants = require('../src/constants');

function baseLocals() {
  return {
    user: { id: 1, first_name: 'Ada', last_name: 'Lovelace', role: 'admin', email: 'ada@company.com' },
    flash: { success: [], error: [], info: [] },
    currentPage: '/x',
    csrfToken: 'test-csrf-token',
    localDate: utils.localDate,
    formatDate: utils.formatDate,
    formatDateTime: utils.formatDateTime,
    daysUntil: utils.daysUntil,
    usagePercent: utils.usagePercent,
    isExpiringSoon: utils.isExpiringSoon,
    escapeHtml: utils.escapeHtml,
    isValidEmail: utils.isValidEmail,
    titleCase: utils.titleCase,
    isPrivileged: utils.isPrivileged,
    badgeClass: utils.badgeClass,
    CONDITION_BADGE: constants.CONDITION_BADGE,
    CHANGE_TYPE_BADGE: constants.CHANGE_TYPE_BADGE,
    ROLE_BADGE: constants.ROLE_BADGE,
    MEMBER_ROLE_BADGE: constants.MEMBER_ROLE_BADGE,
    KB_CATEGORY_BADGE: constants.KB_CATEGORY_BADGE,
    LICENSE_TYPE_BADGE: constants.LICENSE_TYPE_BADGE,
    CONSTANTS: constants
  };
}

function render(pageRel, locals) {
  const file = path.join(__dirname, '..', 'views', 'pages', pageRel);
  return ejs.render(fs.readFileSync(file, 'utf8'), locals, { filename: file });
}

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

function emptyDashboard() {
  return {
    ticketStats: { open: 0, in_progress: 0, waiting: 0, resolved: 0, closed: 0, critical_open: 0 },
    assetStats: { total: 0, in_use: 0, in_storage: 0, in_repair: 0, reserved: 0 },
    projectStats: { total: 0, in_progress: 0, planning: 0, completed: 0, on_hold: 0 },
    staffCount: { total: 0 },
    myTickets: [],
    recentTickets: [],
    expiringWarranties: [],
    expiringWarrantiesCount: 0,
    upcomingChanges: [],
    ticketsByCategory: [],
    staffWorkload: [],
    licenseAlerts: [],
    licenseAlertsCount: 0
  };
}

describe('code review 180: template fallback consistency + route redirect fix + audit detail enrichment', () => {
  describe('dashboard.ejs — nullable enum fallbacks', () => {
    it('renders valid badges when ticket priority is null in my tickets', () => {
      const locals = {
        ...emptyDashboard(),
        ...baseLocals(),
        myTickets: [{ id: 1, ticket_number: 'TK-001', title: 'Test', category: null, priority: null, status: null, created_at: '2024-01-01 10:00' }]
      };
      const html = render('dashboard.ejs', locals);
      expect(html).toContain('badge-medium');
      expect(html).not.toContain('badge-null');
      expect(html).toContain('badge-open');
    });

    it('renders valid category/priority/status when null in recent tickets', () => {
      const locals = {
        ...emptyDashboard(),
        ...baseLocals(),
        recentTickets: [{ id: 1, ticket_number: 'TK-002', title: 'Test', category: null, priority: null, status: null, created_at: '2024-01-01 10:00', assigned_to: 1, assigned_name: 'Ada Lovelace' }]
      };
      const html = render('dashboard.ejs', locals);
      expect(html).toContain('<td class="text-sm">Other</td>');
      expect(html).toContain('badge-medium');
      expect(html).toContain('badge-open');
    });

    it('renders valid category when null in tickets by category', () => {
      const locals = {
        ...emptyDashboard(),
        ...baseLocals(),
        ticketsByCategory: [{ category: null, count: 5 }]
      };
      const html = render('dashboard.ejs', locals);
      expect(html).toContain('>Other</div>');
    });
  });

  describe('staff/show.ejs — nullable enum fallbacks', () => {
    it('renders valid badges when assigned ticket priority/status are null', () => {
      const locals = {
        ...baseLocals(),
        title: 'Staff',
        staffUser: { id: 1, first_name: 'Ada', last_name: 'Lovelace', role: 'staff', department: 'IT', phone: null, email: 'ada@co.com', is_active: 1, last_login: null },
        assignedTickets: [{ id: 1, ticket_number: 'TK-001', title: 'Test', status: null, priority: null, created_at: null }],
        assignedTasks: [],
        assignedAssets: [],
        projectMemberships: []
      };
      const html = render('staff/show.ejs', locals);
      expect(html).toContain('badge-medium');
      expect(html).toContain('badge-open');
      expect(html).not.toContain('badge-null');
    });

    it('renders valid status when assigned asset status is null', () => {
      const locals = {
        ...baseLocals(),
        title: 'Staff',
        staffUser: { id: 1, first_name: 'Ada', last_name: 'Lovelace', role: 'staff', department: 'IT', phone: null, email: 'ada@co.com', is_active: 1, last_login: null },
        assignedTickets: [],
        assignedTasks: [],
        assignedAssets: [{ id: 1, asset_tag: 'AST-001', name: 'Laptop', category: 'laptop', status: null }],
        projectMemberships: []
      };
      const html = render('staff/show.ejs', locals);
      expect(html).toContain('badge-in_storage');
      expect(html).not.toContain('badge-null');
    });
  });

  describe('reports/tickets.ejs — nullable enum fallbacks', () => {
    it('renders valid category label when null in by-category report', () => {
      const locals = {
        ...baseLocals(),
        title: 'Ticket Analytics',
        ticketsByDay: [],
        byCategory: [{ category: null, count: 5 }],
        byPriority: [],
        avgResolution: {},
        slaStats: { total_resolved: 0, within_1d: 0, within_3d: 0, within_7d: 0 },
        topResolvers: [],
        period: 30
      };
      const html = render('reports/tickets.ejs', locals);
      expect(html).toContain('>Other<');
    });

    it('renders valid priority label when null in by-priority report', () => {
      const locals = {
        ...baseLocals(),
        title: 'Ticket Analytics',
        ticketsByDay: [],
        byCategory: [],
        byPriority: [{ priority: null, count: 5 }],
        avgResolution: {},
        slaStats: { total_resolved: 0, within_1d: 0, within_3d: 0, within_7d: 0 },
        topResolvers: [],
        period: 30
      };
      const html = render('reports/tickets.ejs', locals);
      expect(html).toContain('>Medium<');
    });

    it('time-series progress bar aria-label uses descriptive format', () => {
      const src = read('views/pages/reports/tickets.ejs');
      expect(src).toContain('aria-label="Tickets on <%= formatDate(d.date) %>: <%= d.count %>"');
    });
  });

  describe('reports/assets.ejs — nullable enum fallbacks', () => {
    it('renders valid category label when null', () => {
      const locals = {
        ...baseLocals(),
        title: 'Asset Report',
        byCategory: [{ category: null, count: 3, total_value: null }],
        byStatus: [],
        byCondition: [],
        warrantyCount: 0,
        warrantyExpiring: [],
        ageDistribution: [],
        totalValue: {}
      };
      const html = render('reports/assets.ejs', locals);
      expect(html).toContain('>Other<');
    });

    it('renders valid status label when null', () => {
      const locals = {
        ...baseLocals(),
        title: 'Asset Report',
        byCategory: [],
        byStatus: [{ status: null, count: 3 }],
        byCondition: [],
        warrantyCount: 0,
        warrantyExpiring: [],
        ageDistribution: [],
        totalValue: {}
      };
      const html = render('reports/assets.ejs', locals);
      expect(html).toContain('>In Storage<');
    });
  });

  describe('knowledge/index.ejs — nullable status fallback', () => {
    it('renders valid status badge when article status is null', () => {
      const locals = {
        ...baseLocals(),
        title: 'KB',
        articles: [{ id: 1, title: 'Test', category: 'how_to', status: null, views: 0, is_featured: 0, updated_at: null, author_name: 'Ada' }],
        total: 1,
        filters: {}
      };
      const html = render('knowledge/index.ejs', locals);
      expect(html).toContain('badge-draft');
      expect(html).toContain('>Draft<');
      expect(html).not.toContain('badge-null');
    });
  });

  describe('knowledge/show.ejs — nullable status fallback', () => {
    it('renders valid status badge when article status is null', () => {
      const locals = {
        ...baseLocals(),
        title: 'Article',
        article: { id: 1, title: 'Test', category: 'how_to', status: null, views: 0, is_featured: 0, updated_at: null, author_name: 'Ada', tags: null, renderedContent: 'content' }
      };
      const html = render('knowledge/show.ejs', locals);
      expect(html).toContain('badge-draft');
      expect(html).not.toContain('badge-null');
    });
  });

  describe('tickets/index.ejs — nullable enum fallbacks', () => {
    it('renders valid badges when category/priority/status are null', () => {
      const locals = {
        ...baseLocals(),
        title: 'Tickets',
        tickets: [{ id: 1, ticket_number: 'TK-001', title: 'Test', category: null, priority: null, status: null, requester_name: 'Bob', assigned_to: 1, assigned_name: 'Ada', created_at: '2024-01-01 10:00' }],
        total: 1,
        filters: {},
        staff: []
      };
      const html = render('tickets/index.ejs', locals);
      expect(html).toContain('badge-medium');
      expect(html).toContain('badge-open');
      expect(html).toContain('>Other<');
      expect(html).not.toContain('badge-null');
    });
  });

  describe('tickets/show.ejs — nullable enum fallbacks', () => {
    it('renders valid status badge in quick-status section when null', () => {
      const locals = {
        ...baseLocals(),
        title: 'Ticket',
        ticket: { id: 1, ticket_number: 'TK-001', title: 'Test', description: null, category: null, priority: null, status: null, requester_name: 'Bob', requester_email: 'bob@co.com', requester_department: null, requester_phone: null, assigned_to: 1, asset_id: null, due_date: null, resolved_at: null, resolution_notes: null, satisfaction_rating: null, created_at: '2024-01-01', updated_at: '2024-01-01', assigned_name: 'Ada', asset_name: null, asset_tag: null },
        comments: [],
        isEdit: false
      };
      const html = render('tickets/show.ejs', locals);
      expect(html).toContain('badge-open');
      expect(html).not.toContain('badge-null');
    });

    it('renders valid priority/category/status in properties sidebar when null', () => {
      const locals = {
        ...baseLocals(),
        title: 'Ticket',
        ticket: { id: 1, ticket_number: 'TK-001', title: 'Test', description: null, category: null, priority: null, status: null, requester_name: 'Bob', requester_email: 'bob@co.com', requester_department: null, requester_phone: null, assigned_to: 1, asset_id: null, due_date: null, resolved_at: null, resolution_notes: null, satisfaction_rating: null, created_at: '2024-01-01', updated_at: '2024-01-01', assigned_name: 'Ada', asset_name: null, asset_tag: null },
        comments: [],
        isEdit: false
      };
      const html = render('tickets/show.ejs', locals);
      expect(html).toContain('badge-medium');
      expect(html).toContain('>Other<');
      expect(html).toContain('badge-open');
      expect(html).not.toContain('badge-null');
    });
  });

  describe('changes/index.ejs — nullable enum fallbacks', () => {
    it('renders valid badges when priority/status are null', () => {
      const locals = {
        ...baseLocals(),
        title: 'Changes',
        changes: [{ id: 1, title: 'Test', change_type: 'maintenance', priority: null, status: null, scheduled_start: null, assigned_name: null }],
        total: 1,
        filters: {},
        staff: []
      };
      const html = render('changes/index.ejs', locals);
      expect(html).toContain('badge-medium');
      expect(html).toContain('badge-scheduled');
      expect(html).not.toContain('badge-null');
    });
  });

  describe('changes/show.ejs — nullable enum fallbacks', () => {
    it('renders valid badges when status/priority are null', () => {
      const locals = {
        ...baseLocals(),
        title: 'Change',
        change: { id: 1, title: 'Test', change_type: 'maintenance', status: null, priority: null, scheduled_start: null, scheduled_end: null, actual_start: null, actual_end: null, impact: null, description: null, assigned_name: null }
      };
      const html = render('changes/show.ejs', locals);
      expect(html).toContain('badge-scheduled');
      expect(html).toContain('badge-medium');
      expect(html).not.toContain('badge-null');
    });
  });

  describe('assets/index.ejs — nullable enum fallbacks', () => {
    it('renders valid badges when category/status are null', () => {
      const locals = {
        ...baseLocals(),
        title: 'Assets',
        assets: [{ id: 1, asset_tag: 'AST-001', name: 'Laptop', manufacturer: null, category: null, status: null, condition_rating: 'good', assigned_to: null, assigned_name: null, location: null }],
        total: 1,
        filters: {},
        staff: []
      };
      const html = render('assets/index.ejs', locals);
      expect(html).toContain('>Other<');
      expect(html).toContain('badge-in_storage');
      expect(html).not.toContain('badge-null');
    });

    it('does not render a leading space when manufacturer is null', () => {
      const locals = {
        ...baseLocals(),
        title: 'Assets',
        assets: [{ id: 1, asset_tag: 'AST-001', name: 'Laptop', manufacturer: null, category: 'laptop', status: 'in_storage', condition_rating: 'good', assigned_to: null, assigned_name: null, location: null }],
        total: 1,
        filters: {},
        staff: []
      };
      const html = render('assets/index.ejs', locals);
      expect(html).toContain('<td>Laptop</td>');
      expect(html).not.toContain('<td> Laptop</td>');
    });
  });

  describe('assets/show.ejs — nullable enum fallbacks', () => {
    it('renders valid badges when category/status are null', () => {
      const locals = {
        ...baseLocals(),
        title: 'Asset',
        asset: { id: 1, asset_tag: 'AST-001', name: 'Laptop', category: null, manufacturer: null, model: null, serial_number: null, status: null, condition_rating: null, purchase_date: null, purchase_price: null, warranty_expiry: null, assigned_to: null, assigned_name: null, assigned_email: null, location: null, notes: null },
        relatedTickets: []
      };
      const html = render('assets/show.ejs', locals);
      expect(html).toContain('>Other<');
      expect(html).toContain('badge-in_storage');
      expect(html).toContain('badge-low');
      expect(html).not.toContain('badge-null');
    });

    it('renders valid badges when related ticket priority/status are null', () => {
      const locals = {
        ...baseLocals(),
        title: 'Asset',
        asset: { id: 1, asset_tag: 'AST-001', name: 'Laptop', category: 'laptop', status: 'in_storage', condition_rating: 'good', assigned_to: null, assigned_name: null, assigned_email: null, location: null, notes: null },
        relatedTickets: [{ id: 1, ticket_number: 'TK-001', title: 'Test', priority: null, status: null }]
      };
      const html = render('assets/show.ejs', locals);
      expect(html).toContain('badge-medium');
      expect(html).toContain('badge-open');
      expect(html).not.toContain('badge-null');
    });
  });

  describe('projects/index.ejs — nullable status fallback', () => {
    it('renders valid status badge when project status is null', () => {
      const locals = {
        ...baseLocals(),
        title: 'Projects',
        projects: [{ id: 1, name: 'Test Project', status: null, priority: 'medium', description: null, progress: 0, owner_id: 1, owner_name: 'Ada', done_count: 0, task_count: 0, start_date: null, end_date: null, budget: null, spent: null }],
        total: 1,
        filters: {}
      };
      const html = render('projects/index.ejs', locals);
      expect(html).toContain('badge-planning');
      expect(html).not.toContain('badge-null');
    });
  });

  describe('projects/show.ejs — nullable enum fallbacks', () => {
    it('renders valid badges when project status/priority are null', () => {
      const locals = {
        ...baseLocals(),
        title: 'Project',
        project: { id: 1, name: 'Test Project', status: null, priority: null, description: null, progress: 0, owner_id: 1, owner_name: 'Ada', start_date: null, end_date: null, budget: null, spent: null },
        tasks: [],
        members: []
      };
      const html = render('projects/show.ejs', locals);
      expect(html).toContain('badge-planning');
      expect(html).toContain('badge-medium');
      expect(html).not.toContain('badge-null');
    });

    it('renders valid badges when task priority is null', () => {
      const locals = {
        ...baseLocals(),
        title: 'Project',
        project: { id: 1, name: 'Test Project', status: 'in_progress', priority: 'medium', description: null, progress: 50, owner_id: 1, owner_name: 'Ada', start_date: null, end_date: null, budget: null, spent: null },
        tasks: [{ id: 1, title: 'Task', status: 'todo', priority: null, due_date: null, assigned_name: null, project_id: 1, project_name: 'Test' }],
        members: []
      };
      const html = render('projects/show.ejs', locals);
      expect(html).toContain('badge-medium');
      expect(html).not.toContain('badge-null');
    });

    it('renders valid role badge when member role is null', () => {
      const locals = {
        ...baseLocals(),
        title: 'Project',
        project: { id: 1, name: 'Test Project', status: 'in_progress', priority: 'medium', description: null, progress: 50, owner_id: 1, owner_name: 'Ada', start_date: null, end_date: null, budget: null, spent: null },
        tasks: [],
        members: [{ id: 1, member_name: 'Ada', role: null }]
      };
      const html = render('projects/show.ejs', locals);
      expect(html).toContain('>Member<');
      expect(html).not.toContain('>null<');
    });
  });

  describe('auth/profile.ejs — nullable role fallback', () => {
    it('renders valid role display when role is null', () => {
      const locals = {
        ...baseLocals(),
        title: 'Profile',
        profileUser: { id: 1, username: 'admin', first_name: 'Ada', last_name: 'Lovelace', role: null, email: 'ada@co.com', department: 'IT', phone: null, avatar: null, is_active: 1 }
      };
      const html = render('auth/profile.ejs', locals);
      expect(html).toContain('value="Staff"');
      expect(html).not.toContain('value="null"');
    });
  });

  describe('staff.js route — double-denial redirect fix', () => {
    it('redirects to /staff (not edit form) on privileged-role assignment denial', () => {
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
      const audit = jest.fn();
      const flashStore = { success: [], error: [], info: [] };
      const req = {
        session: { user: { id: 1, role: 'manager' } },
        audit,
        flash: (type, msg) => {
          flashStore[type].push(msg);
        },
        body: { email: 'a@b.co', first_name: 'A', last_name: 'B', role: 'admin', department: '', phone: '' },
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
      expect(audit).toHaveBeenCalledWith('access_denied', 'user', 1, expect.stringContaining('Unauthorized privileged role'));
    });

    it('redirects to /staff (not edit form) on self-role-change denial', () => {
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
      const req = {
        session: { user: { id: 1, role: 'admin' } },
        audit: jest.fn(),
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
    });
  });

  describe('reports.js — audit details include period', () => {
    it('ticket analytics audit includes period in details', () => {
      jest.resetModules();
      jest.mock('../src/middleware/auth', () => ({
        requireAuth: (req, res, next) => next(),
        requireAdminOrManager: (req, res, next) => next()
      }));
      jest.mock('../src/middleware/audit', () => ({
        auditMiddleware: (req, res, next) => {
          req.audit = jest.fn(); next();
        }
      }));
      const reports = require('../src/routes/reports');
      const layer = reports.stack.find(l => l.route && l.route.methods.get && l.route.path === '/tickets');
      const handler = layer.route.stack[layer.route.stack.length - 1].handle;
      const audit = jest.fn();
      const req = { session: { user: { id: 1 } }, audit, query: { period: '30' } };
      const res = { render: jest.fn(), flash: jest.fn(), redirect: jest.fn() };
      handler(req, res, () => {});
      expect(audit).toHaveBeenCalledWith('read', 'ticket', null, expect.stringMatching(/period: 30 days/));
    });

    it('staff performance audit includes period in details', () => {
      jest.resetModules();
      jest.mock('../src/middleware/auth', () => ({
        requireAuth: (req, res, next) => next(),
        requireAdminOrManager: (req, res, next) => next()
      }));
      jest.mock('../src/middleware/audit', () => ({
        auditMiddleware: (req, res, next) => {
          req.audit = jest.fn(); next();
        }
      }));
      const reports = require('../src/routes/reports');
      const layer = reports.stack.find(l => l.route && l.route.methods.get && l.route.path === '/staff');
      const handler = layer.route.stack[layer.route.stack.length - 1].handle;
      const audit = jest.fn();
      const req = { session: { user: { id: 1 } }, audit, query: { period: '90' } };
      const res = { render: jest.fn(), flash: jest.fn(), redirect: jest.fn() };
      handler(req, res, () => {});
      expect(audit).toHaveBeenCalledWith('read', 'user', null, expect.stringMatching(/period: 90 days/));
    });
  });
});
