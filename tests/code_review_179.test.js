const { describe, it, expect } = require('@jest/globals');
const fs = require('fs');
const path = require('path');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

describe('code review 179 — reports audit + a11y progress-bar labels + knowledge featured cell', () => {
  it('reports index route logs a read audit', () => {
    jest.resetModules();
    jest.mock('../src/middleware/auth', () => ({
      requireAuth: (req, res, next) => next(),
      requireAdminOrManager: (req, res, next) => next()
    }));
    jest.mock('../src/middleware/audit', () => ({
      audit: jest.fn(),
      auditMiddleware: (req, res, next) => {
        req.audit = jest.fn();
        next();
      }
    }));
    const reports = require('../src/routes/reports');
    const layer = reports.stack.find(l => l.route && l.route.methods.get && l.route.path === '/');
    expect(layer).toBeDefined();
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    const audit = jest.fn();
    const req = { session: { user: { id: 1 } }, audit, query: {} };
    const res = { render: jest.fn() };
    handler(req, res, () => {});
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith('read', 'report', null, 'Viewed reports index');
  });

  it('reports/staff.ejs progress bar aria-label includes staff name', () => {
    const src = read('views/pages/reports/staff.ejs');
    expect(src).toContain('aria-label="<%= p.name %>: <%= p.open_tickets %> open tickets"');
  });

  it('reports/tickets.ejs top-resolvers progress bar aria-label includes resolver name', () => {
    const src = read('views/pages/reports/tickets.ejs');
    expect(src).toContain('aria-label="<%= r.name %>: <%= r.resolved %> tickets resolved"');
  });

  it('projects/index.ejs progress bar aria-label includes project name', () => {
    const src = read('views/pages/projects/index.ejs');
    expect(src).toContain('aria-label="Project progress: <%= p.name %>: <%= p.progress || 0 %>%"');
  });

  it('projects/show.ejs progress bar aria-label includes project name', () => {
    const src = read('views/pages/projects/show.ejs');
    expect(src).toContain('aria-label="Project progress: <%= project.name %>: <%= project.progress || 0 %>%"');
  });

  it('knowledge/index.ejs non-featured cell uses sr-only instead of aria-hidden dash', () => {
    const src = read('views/pages/knowledge/index.ejs');
    expect(src).toContain('<span class="sr-only">No</span>');
    expect(src).not.toContain('<span aria-hidden="true">-</span>');
  });
});
