/**
 * Centralized validation constants shared across routes.
 * Single source of truth for all enum/check/constraint values.
 */

// Assets
const ASSET_CATEGORIES = ['laptop','desktop','server','monitor','printer','network','phone','tablet','software','peripheral','other'];
const ASSET_STATUSES = ['in_use','in_storage','in_repair','disposed','reserved'];
const ASSET_CONDITIONS = ['new','good','fair','poor','broken'];

// Tickets
const TICKET_CATEGORIES = ['hardware','software','network','access','email','security','other'];
const TICKET_PRIORITIES = ['critical','high','medium','low'];
const TICKET_STATUSES = ['open','in_progress','waiting','resolved','closed'];

// Projects
const PROJECT_STATUSES = ['planning','in_progress','on_hold','completed','cancelled'];
const PROJECT_PRIORITIES = ['critical','high','medium','low'];
const TASK_STATUSES = ['todo','in_progress','review','done'];
const TASK_PRIORITIES = ['high','medium','low'];
const MEMBER_ROLES = ['lead','member','stakeholder'];

// Vendors (stored lowercase for consistency with all other enums)
const VENDOR_CATEGORIES = ['hardware','cloud','security','network','maintenance','software','consulting','telecom','other'];

// Knowledge Base
const KB_CATEGORIES = ['how_to','troubleshooting','policy','faq','sop','other'];
const KB_STATUSES = ['draft','published','archived'];

// Changes
const CHANGE_TYPES = ['maintenance','upgrade','incident','security','configuration'];
const CHANGE_STATUSES = ['scheduled','in_progress','completed','failed','cancelled'];
const CHANGE_PRIORITIES = ['critical','high','medium','low'];

// Licenses
const LICENSE_TYPES = ['perpetual','subscription','volume','oem','academic'];

// Users / Staff
const USER_ROLES = ['admin','manager','staff'];

// Session cookie name — single source of truth so auth middleware and routes
// stay in sync if the name ever changes.
const SESSION_COOKIE = 'connect.sid';

// ---------------------------------------------------------------------------
// Shared max-length constants for input validation
// These are the single source of truth for all substring truncation limits
// used across route handlers. Kept here to eliminate magic number repetition.
// ---------------------------------------------------------------------------
const MAX_SHORT_STR = 100;        // first_name, last_name, department, manufacturer, model, etc.
const MAX_MEDIUM_STR = 200;       // title, software_name, vendor name, asset name, etc.
const MAX_LONG_STR = 500;         // tags, impact, website, address, serial notes
const MAX_DESC = 5000;            // description fields (tickets, projects, tasks, etc.)
const MAX_NOTES = 2000;           // notes fields (assets, vendors, licenses)
const MAX_CONTENT = 50000;        // knowledge article content
const MAX_EMAIL = 200;            // email addresses
const MAX_PHONE = 50;             // phone numbers
const MAX_ADDRESS = 500;          // vendor address
const MAX_PASSWORD = 128;         // password max length

module.exports = {
  ASSET_CATEGORIES, ASSET_STATUSES, ASSET_CONDITIONS,
  TICKET_CATEGORIES, TICKET_PRIORITIES, TICKET_STATUSES,
  PROJECT_STATUSES, PROJECT_PRIORITIES, TASK_STATUSES, TASK_PRIORITIES, MEMBER_ROLES,
  VENDOR_CATEGORIES,
  KB_CATEGORIES, KB_STATUSES,
  CHANGE_TYPES, CHANGE_STATUSES, CHANGE_PRIORITIES,
  LICENSE_TYPES,
  USER_ROLES,
  SESSION_COOKIE,
  MAX_SHORT_STR, MAX_MEDIUM_STR, MAX_LONG_STR, MAX_DESC, MAX_NOTES,
  MAX_CONTENT, MAX_EMAIL, MAX_PHONE, MAX_ADDRESS, MAX_PASSWORD
};
