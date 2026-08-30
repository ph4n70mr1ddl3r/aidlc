const { describe, it, expect } = require('@jest/globals');
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');
const utils = require('../src/utils');
const constants = require('../src/constants');

// Regression tests for code_review_126: consistent Number() coercion and
// titleCase usage across EJS templates and the vendor update error path.

function baseLocals(user) {
  return {
    user: user || { id: 1, first_name: 'Ada', last_name: 'Lovelace', role: 'admin', email: 'ada@company.com', department: 'IT' },
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

// ---------------------------------------------------------------------------
// vendors.js — INVALID_ error messages now use titleCase instead of fragile
// manual casing. The helper handles any field name shape correctly.
// ---------------------------------------------------------------------------
describe('vendors.js — INVALID_ error title-case via titleCase helper', () => {
  it('produces "Invalid Contact Person" for INVALID_CONTACT_PERSON', () => {
    expect(utils.titleCase('CONTACT_PERSON')).toBe('Contact Person');
  });

  it('produces "Invalid Email" for INVALID_EMAIL', () => {
    expect(utils.titleCase('EMAIL')).toBe('Email');
  });

  it('produces "Invalid Contract Start" for INVALID_CONTRACT_START', () => {
    expect(utils.titleCase('CONTRACT_START')).toBe('Contract Start');
  });

  it('produces "Invalid Vendor Rating" for a hypothetical INVALID_VENDOR_RATING', () => {
    expect(utils.titleCase('VENDOR_RATING')).toBe('Vendor Rating');
  });
});

// ---------------------------------------------------------------------------
// Template Number() coercion on assigned_to / owner_id / asset_id comparisons
// ---------------------------------------------------------------------------

describe('projects/form — Number() coercion on owner_id / staff.id', () => {
  const staff = [
    { id: 1, first_name: 'Admin', last_name: 'User' },
    { id: '2', first_name: 'StringId', last_name: 'User' }
  ];

  it('selects the option when owner_id is a string matching a numeric staff id', () => {
    const html = render('projects/form.ejs', {
      ...baseLocals(),
      project: { id: 1, name: 'Test', owner_id: '2' },
      staff,
      isEdit: true
    });
    expect(html).toContain('selected');
  });

  it('does not select when owner_id differs from staff id', () => {
    const html = render('projects/form.ejs', {
      ...baseLocals(),
      project: { id: 1, name: 'Test', owner_id: '99' },
      staff,
      isEdit: true
    });
    // No option should be selected since 99 is not in the staff list.
    expect(html).not.toMatch(/value="1"[^>]*selected/);
    expect(html).not.toMatch(/value="2"[^>]*selected/);
  });
});

describe('tickets/form — Number() coercion on assigned_to / asset_id', () => {
  const staff = [{ id: 1, first_name: 'A', last_name: 'B' }];
  const assets = [{ id: '2', asset_tag: 'AST-001', name: 'Laptop' }];

  it('selects assigned_to when both are strings that coerce to the same number', () => {
    const html = render('tickets/form.ejs', {
      ...baseLocals(),
      ticket: { id: 1, title: 'T', category: 'hardware', priority: 'medium', status: 'open', assigned_to: '1' },
      staff,
      assets: [],
      isEdit: true
    });
    expect(html).toContain('selected');
  });

  it('selects asset_id when both are strings that coerce to the same number', () => {
    const html = render('tickets/form.ejs', {
      ...baseLocals(),
      ticket: { id: 1, title: 'T', category: 'hardware', priority: 'medium', status: 'open', assigned_to: null, asset_id: '2' },
      staff: [],
      assets,
      isEdit: true
    });
    expect(html).toContain('selected');
  });
});

describe('changes/form — Number() coercion on assigned_to', () => {
  const staff = [{ id: '3', first_name: 'C', last_name: 'D' }];

  it('selects the option when assigned_to is a string matching a numeric staff id', () => {
    const html = render('changes/form.ejs', {
      ...baseLocals(),
      change: { id: 1, title: 'Ch', change_type: 'maintenance', status: 'scheduled', priority: 'medium', assigned_to: '3' },
      staff,
      isEdit: true
    });
    expect(html).toContain('selected');
  });
});

describe('assets/form — Number() coercion on assigned_to', () => {
  const staff = [{ id: '5', first_name: 'E', last_name: 'F' }];

  it('selects the option when assigned_to is a string matching a numeric staff id', () => {
    const html = render('assets/form.ejs', {
      ...baseLocals(),
      asset: { id: 1, name: 'Asset', category: 'laptop', status: 'in_storage', assigned_to: '5' },
      staff,
      isEdit: true
    });
    expect(html).toContain('selected');
  });
});

describe('assets/index — Number() coercion on filter.assigned_to', () => {
  const staff = [{ id: '7', first_name: 'G', last_name: 'H' }];

  it('selects the option when filter value is a string matching a numeric staff id', () => {
    const html = render('assets/index.ejs', {
      ...baseLocals(),
      staff,
      filters: { assigned_to: '7' },
      total: 0, page: 1, limit: 25, totalPages: 1, baseUrl: '/assets',
      assets: []
    });
    expect(html).toContain('selected');
  });
});

describe('tickets/index — Number() coercion on filter.assigned_to', () => {
  const staff = [{ id: '8', first_name: 'I', last_name: 'J' }];

  it('selects the option when filter value is a string matching a numeric staff id', () => {
    const html = render('tickets/index.ejs', {
      ...baseLocals(),
      staff,
      filters: { assigned_to: '8' },
      total: 0, page: 1, limit: 25, totalPages: 1, baseUrl: '/tickets',
      tickets: []
    });
    expect(html).toContain('selected');
  });
});

describe('changes/index — Number() coercion on filter.assigned_to', () => {
  const staff = [{ id: '9', first_name: 'K', last_name: 'L' }];

  it('selects the option when filter value is a string matching a numeric staff id', () => {
    const html = render('changes/index.ejs', {
      ...baseLocals(),
      staff,
      filters: { assigned_to: '9' },
      total: 0, page: 1, limit: 25, totalPages: 1, baseUrl: '/changes',
      changes: []
    });
    expect(html).toContain('selected');
  });
});
