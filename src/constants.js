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

module.exports = {
  ASSET_CATEGORIES, ASSET_STATUSES, ASSET_CONDITIONS,
  TICKET_CATEGORIES, TICKET_PRIORITIES, TICKET_STATUSES,
  PROJECT_STATUSES, PROJECT_PRIORITIES, TASK_STATUSES, TASK_PRIORITIES, MEMBER_ROLES,
  VENDOR_CATEGORIES,
  KB_CATEGORIES, KB_STATUSES,
  CHANGE_TYPES, CHANGE_STATUSES, CHANGE_PRIORITIES,
  LICENSE_TYPES,
  USER_ROLES,
};
