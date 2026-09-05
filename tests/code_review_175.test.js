const { describe, it, expect } = require('@jest/globals');
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');
const utils = require('../src/utils');
const constants = require('../src/constants');

// Regression tests for the 175th review pass. Defects closed:
// (1) views/pages/assets/show.ejs — titleCase(asset.condition_rating) missing
//     || 'good' fallback; null would render empty badge text while the CSS
//     class correctly showed the fallback severity.
// (2) views/pages/changes/show.ejs — same gap on titleCase(change.change_type)
//     vs badgeClass(change.change_type || 'maintenance', ...).
// (3) views/pages/licenses/show.ejs — same gap on titleCase(license.license_type)
//     vs badgeClass(license.license_type || 'perpetual', ...).
// (4) views/pages/reports/assets.ejs — aria-label titleCase(c.condition_rating)
//     missing || 'good' fallback matching the text span on the previous line.

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

describe('code review 175: titleCase fallback consistency in show/detail templates', () => {
  describe('assets/show ejs — condition_rating titleCase has fallback', () => {
    it('renders a readable condition label when condition_rating is null', () => {
      const locals = { ...baseLocals(), title: 'Asset', asset: { id: 1, name: 'Test Asset', asset_tag: 'AST-001', status: 'in_storage', condition_rating: null, category: 'laptop', warranty_expiry: null, purchase_date: null, purchase_price: null, assigned_name: null, assigned_email: null, location: null, notes: null }, relatedTickets: [] };
      const html = render('assets/show.ejs', locals);
      // Fallback flows through both badgeClass and titleCase so text and CSS agree.
      expect(html).toContain('badge-low'); // CONDITION_BADGE maps 'good' → 'low'
      expect(html).not.toContain('badge-null');
      expect(html).toContain('>Good<');
    });

    it('renders correctly when condition_rating is a valid enum value', () => {
      const locals = { ...baseLocals(), title: 'Asset', asset: { id: 1, name: 'Test Asset', asset_tag: 'AST-001', status: 'in_use', condition_rating: 'poor', category: 'laptop', warranty_expiry: null, purchase_date: null, purchase_price: null, assigned_name: null, assigned_email: null, location: null, notes: null }, relatedTickets: [] };
      const html = render('assets/show.ejs', locals);
      expect(html).toContain('badge-critical');
      expect(html).toContain('>Poor<');
    });
  });

  describe('changes/show ejs — change_type titleCase has fallback', () => {
    it('renders a readable type label when change_type is null', () => {
      const locals = { ...baseLocals(), title: 'Change', change: { id: 1, title: 'Test Change', change_type: null, status: 'scheduled', priority: 'medium', impact: null, description: null, scheduled_start: null, scheduled_end: null, actual_start: null, actual_end: null, assigned_name: null } };
      const html = render('changes/show.ejs', locals);
      expect(html).toContain('badge-medium');
      expect(html).not.toContain('badge-null');
      expect(html).toContain('>Maintenance<');
    });

    it('renders correctly when change_type is a valid enum value', () => {
      const locals = { ...baseLocals(), title: 'Change', change: { id: 1, title: 'Test Change', change_type: 'security', status: 'scheduled', priority: 'high', impact: null, description: null, scheduled_start: null, scheduled_end: null, actual_start: null, actual_end: null, assigned_name: null } };
      const html = render('changes/show.ejs', locals);
      expect(html).toContain('badge-critical');
      expect(html).toContain('>Security<');
    });
  });

  describe('licenses/show ejs — license_type titleCase has fallback', () => {
    it('renders a readable type label when license_type is null', () => {
      const locals = { ...baseLocals(), title: 'License', license: { id: 1, software_name: 'Test License', vendor: null, license_key: null, license_type: null, total_seats: 10, used_seats: 0, purchase_date: null, expiry_date: null, cost: null, notes: null } };
      const html = render('licenses/show.ejs', locals);
      expect(html).toContain('badge-medium');
      expect(html).not.toContain('badge-null');
      expect(html).toContain('>Perpetual<');
    });

    it('renders correctly when license_type is a valid enum value', () => {
      const locals = { ...baseLocals(), title: 'License', license: { id: 1, software_name: 'Test License', vendor: null, license_key: null, license_type: 'subscription', total_seats: 10, used_seats: 5, purchase_date: null, expiry_date: null, cost: null, notes: null } };
      const html = render('licenses/show.ejs', locals);
      expect(html).toContain('badge-medium');
      expect(html).toContain('>Subscription<');
    });
  });

  describe('reports/assets ejs — condition_rating aria-label titleCase has fallback', () => {
    it('renders a valid aria-label when condition_rating is null', () => {
      const locals = { ...baseLocals(), title: 'Asset Report', byCategory: [], byStatus: [], byCondition: [{ condition_rating: null, count: 3 }], warrantyCount: 0, warrantyExpiring: [], ageDistribution: [], totalValue: {} };
      const html = render('reports/assets.ejs', locals);
      // The aria-label must match the text span on the previous line so a
      // screen reader announces the same label as the visible text.
      expect(html).toContain('aria-label="Good: 3 assets"');
      expect(html).not.toContain('aria-label="null:');
    });

    it('renders a valid aria-label when condition_rating is a valid enum value', () => {
      const locals = { ...baseLocals(), title: 'Asset Report', byCategory: [], byStatus: [], byCondition: [{ condition_rating: 'poor', count: 2 }], warrantyCount: 0, warrantyExpiring: [], ageDistribution: [], totalValue: {} };
      const html = render('reports/assets.ejs', locals);
      expect(html).toContain('aria-label="Poor: 2 assets"');
    });
  });
});
