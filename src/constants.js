/**
 * Centralized validation constants shared across routes.
 * Single source of truth for all enum/check/constraint values.
 */

// Assets
const ASSET_CATEGORIES = Object.freeze(['laptop','desktop','server','monitor','printer','network','phone','tablet','software','peripheral','other']);
const ASSET_STATUSES = Object.freeze(['in_use','in_storage','in_repair','disposed','reserved']);
const ASSET_CONDITIONS = Object.freeze(['new','good','fair','poor','broken']);

// Tickets
const TICKET_CATEGORIES = Object.freeze(['hardware','software','network','access','email','security','other']);
const TICKET_PRIORITIES = Object.freeze(['critical','high','medium','low']);
const TICKET_STATUSES = Object.freeze(['open','in_progress','waiting','resolved','closed']);

// Projects
const PROJECT_STATUSES = Object.freeze(['planning','in_progress','on_hold','completed','cancelled']);
const PROJECT_PRIORITIES = Object.freeze(['critical','high','medium','low']);
const TASK_STATUSES = Object.freeze(['todo','in_progress','review','done']);
const TASK_PRIORITIES = Object.freeze(['high','medium','low']);
const MEMBER_ROLES = Object.freeze(['lead','member','stakeholder']);

// Vendors (stored lowercase for consistency with all other enums)
const VENDOR_CATEGORIES = Object.freeze(['hardware','cloud','security','network','maintenance','software','consulting','telecom','other']);

// Knowledge Base
const KB_CATEGORIES = Object.freeze(['how_to','troubleshooting','policy','faq','sop','other']);
const KB_STATUSES = Object.freeze(['draft','published','archived']);

// Changes
const CHANGE_TYPES = Object.freeze(['maintenance','upgrade','incident','security','configuration']);
const CHANGE_STATUSES = Object.freeze(['scheduled','in_progress','completed','failed','cancelled']);
const CHANGE_PRIORITIES = Object.freeze(['critical','high','medium','low']);

// Licenses
const LICENSE_TYPES = Object.freeze(['perpetual','subscription','volume','oem','academic']);

// Users / Staff
const USER_ROLES = Object.freeze(['admin','manager','staff']);

// Session cookie name — single source of truth so auth middleware and routes
// stay in sync if the name ever changes.
const SESSION_COOKIE = 'itm_sid';

// Session cookie options (minus maxAge, which is set by SESSION_MAX_AGE).
// Must match the app.js session config so that res.clearCookie() can delete
// the cookie correctly in production (where secure:true requires matching
// options on the Clear-Cookie header). The secure flag is set to true in
// production to ensure cookies are only sent over HTTPS.
const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax',
  path: '/'
};

// Session max-age (24 hours, in milliseconds)
const SESSION_MAX_AGE = 24 * 60 * 60 * 1000;

// Audit log filter whitelists — kept in constants so they stay in sync
// if new actions or entity types are added across route files.
const ALLOWED_ACTIONS = Object.freeze(['create', 'update', 'delete', 'read', 'login', 'logout', 'login_failed', 'login_blocked', 'login_rate_limited', 'deactivate', 'reactivate', 'comment', 'access_denied']);
const ALLOWED_ENTITY_TYPES = Object.freeze(['user', 'ticket', 'asset', 'project', 'project_task', 'project_member', 'vendor', 'knowledge_article', 'license', 'change', 'audit_log']);

// ---------------------------------------------------------------------------
// Shared max-length constants for input validation
// These are the single source of truth for all substring truncation limits
// used across route handlers. Kept here to eliminate magic number repetition.
// ---------------------------------------------------------------------------
const MAX_USERNAME = 50;          // username (also used as substring limit in auth.js and staff.js)
const MAX_SHORT_STR = 100;        // first_name, last_name, department, manufacturer, model, etc.
const MAX_MEDIUM_STR = 200;       // title, software_name, vendor name, asset name, etc.
const MAX_LONG_STR = 500;         // tags, impact, website, address, serial notes
const MAX_DESC = 5000;            // description fields (tickets, projects, tasks, etc.)
const MAX_NOTES = 2000;           // notes fields (assets, vendors, licenses)
const MAX_CONTENT = 50000;        // knowledge article content
const MAX_EMAIL = 200;            // email addresses
const MAX_PHONE = 50;             // phone numbers
const MAX_ADDRESS = 500;          // vendor address
const MIN_PASSWORD = 12;          // password minimum length
const MAX_PASSWORD = 128;         // password max field length (UI/storage cap)
// bcrypt silently truncates inputs at 72 BYTES, so two passwords differing only
// after the 72nd byte hash identically. Cap the byte length — not just the
// character length — to avoid silently-equivalent credentials. Use 72 as the
// hard upper bound; UTF-8 multibyte chars reduce the effective character budget.
const MAX_PASSWORD_BYTES = 72;
const MAX_SEARCH = 100;           // search box input (list filters)
const MAX_ASSET_TAG = 50;         // asset tag format AST-<digits> (incl. prefix)
const ASSET_TAG_PREFIX = 'AST-';  // asset tag prefix followed by digits
// Require at least 3 digits so the auto-incrementing counter never produces a
// tag that later fails validation once it exceeds AST-999 (next_seq 1000 yields
// AST-1000). Keep the lower bound at 3 to preserve the canonical AST-XXX format.
const ASSET_TAG_RE = /^AST-\d{3,}$/;

// Audit log
const MAX_AUDIT_DETAILS = 4000; // max length of audit log details to prevent unbounded row growth

// Bcrypt
const BCRYPT_SALT_ROUNDS = 12;

// Badge severity mappings — centralized so templates and utils share the same
// source of truth. Kept in constants.js (not utils.js) because they are static
// data mappings, not utility functions.
const CONDITION_BADGE = Object.freeze({ new: 'low', good: 'low', fair: 'medium', poor: 'critical', broken: 'critical' });
const CHANGE_TYPE_BADGE = Object.freeze({ security: 'critical', incident: 'high', maintenance: 'medium', upgrade: 'low', configuration: 'low' });
const ROLE_BADGE = Object.freeze({ admin: 'critical', manager: 'high', staff: 'medium' });

// Pagination
const MAX_PAGE = 5000;            // maximum allowed page number to prevent excessively deep pagination offsets
const DEFAULT_PAGE_SIZE = 25;     // default rows per page (overridable via PAGE_SIZE env, max MAX_PAGE_SIZE)
const MAX_PAGE_SIZE = 100;        // hard cap on page size to prevent resource exhaustion

module.exports = {
  ASSET_CATEGORIES, ASSET_STATUSES, ASSET_CONDITIONS,
  TICKET_CATEGORIES, TICKET_PRIORITIES, TICKET_STATUSES,
  PROJECT_STATUSES, PROJECT_PRIORITIES, TASK_STATUSES, TASK_PRIORITIES, MEMBER_ROLES,
  VENDOR_CATEGORIES,
  KB_CATEGORIES, KB_STATUSES,
  CHANGE_TYPES, CHANGE_STATUSES, CHANGE_PRIORITIES,
  LICENSE_TYPES,
  USER_ROLES,
  SESSION_COOKIE, SESSION_COOKIE_OPTIONS, SESSION_MAX_AGE,
  ALLOWED_ACTIONS, ALLOWED_ENTITY_TYPES,
  MAX_USERNAME, MAX_SHORT_STR, MAX_MEDIUM_STR, MAX_LONG_STR, MAX_DESC, MAX_NOTES,
  MAX_CONTENT, MAX_EMAIL, MAX_PHONE, MAX_ADDRESS, MIN_PASSWORD, MAX_PASSWORD, MAX_PASSWORD_BYTES, MAX_SEARCH, MAX_ASSET_TAG, ASSET_TAG_PREFIX, ASSET_TAG_RE,
  MAX_PAGE, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE,
  MAX_AUDIT_DETAILS,
  BCRYPT_SALT_ROUNDS,
  CONDITION_BADGE, CHANGE_TYPE_BADGE, ROLE_BADGE
};
