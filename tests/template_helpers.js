/**
 * Shared template rendering helpers — extracted from templates.test.js and
 * code_review_*.test.js to eliminate ~300 lines of duplicated baseLocals()
 * boilerplate across the test suite.
 *
 * If a new helper or badge is added to app.js res.locals, add it here and
 * every test that renders templates will pick it up automatically.
 */
const utils = require('../src/utils');
const constants = require('../src/constants');
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');

/**
 * Reproduce the exact res.locals surface that app.js injects into every
 * rendered template. Accepts an optional user override so callers can test
 * with non-admin roles or different IDs without mutating the default.
 * @param {object|null} [user] — optional user object; merges over the default admin
 * @returns {object} res.locals replica
 */
function baseLocals(user) {
  const defaultUser = { id: 1, first_name: 'Ada', last_name: 'Lovelace', role: 'admin', email: 'ada@company.com', department: 'IT' };
  return {
    user: user ? { ...defaultUser, ...user } : defaultUser,
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
    TICKET_STATUS_BADGE: constants.TICKET_STATUS_BADGE,
    TICKET_PRIORITY_BADGE: constants.TICKET_PRIORITY_BADGE,
    ASSET_STATUS_BADGE: constants.ASSET_STATUS_BADGE,
    PROJECT_STATUS_BADGE: constants.PROJECT_STATUS_BADGE,
    PROJECT_PRIORITY_BADGE: constants.PROJECT_PRIORITY_BADGE,
    TASK_PRIORITY_BADGE: constants.TASK_PRIORITY_BADGE,
    CHANGE_STATUS_BADGE: constants.CHANGE_STATUS_BADGE,
    CHANGE_PRIORITY_BADGE: constants.CHANGE_PRIORITY_BADGE,
    KB_STATUS_BADGE: constants.KB_STATUS_BADGE,
    VENDOR_CATEGORY_BADGE: constants.VENDOR_CATEGORY_BADGE,
    ACTION_BADGE: constants.ACTION_BADGE,
    IS_ACTIVE_BADGE: constants.IS_ACTIVE_BADGE,
    TASK_DEADLINE_BADGE: constants.TASK_DEADLINE_BADGE,
    WARRANTY_DEADLINE_BADGE: constants.WARRANTY_DEADLINE_BADGE,
    CONSTANTS: constants
  };
}

/**
 * Render an EJS template at the given relative path with the provided locals.
 * @param {string} pageRel — relative to views/pages/ (e.g. 'tickets/index.ejs')
 * @param {object} locals
 * @returns {string} rendered HTML
 */
function render(pageRel, locals) {
  const file = path.join(__dirname, '..', 'views', 'pages', pageRel);
  return ejs.render(fs.readFileSync(file, 'utf8'), locals, { filename: file });
}

module.exports = { baseLocals, render };
