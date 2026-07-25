const db = require('../models/database');
const { ALLOWED_ACTIONS, ALLOWED_ENTITY_TYPES, MAX_AUDIT_DETAILS } = require('../constants');

// Cache the prepared statement — audit() is called on every write route
// and prepare() is relatively expensive. Lazily initialized so tests can
// reset the cached statement via resetCachedStatements().
let _auditStmt = null;
function _getAuditStmt() {
  if (!_auditStmt) {
    _auditStmt = db.prepare(`
      INSERT INTO audit_log (user_id, action, entity_type, entity_id, details, ip_address)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
  }
  return _auditStmt;
}

/**
 * Reset the module-level cached prepared statement (test use only).
 * Ensures test isolation when using mock db instances.
 */
function resetCachedStatements() {
  _auditStmt = null;
}

/**
 * Log an auditable action to the database.
 *
 * @param {Object} opts
 * @param {Object} [opts.req]  - Express request (used to extract user_id, ip)
 * @param {string} opts.action - e.g. 'create', 'update', 'delete', 'login'
 * @param {string} opts.entity - e.g. 'ticket', 'asset', 'user'
 * @param {number} [opts.entityId]
 * @param {string} [opts.details] - Free-text description
 */
function audit({ req, action, entity, entityId, details }) {
  try {
    // Validate action and entity against allowlists to prevent inconsistent data
    // in the audit_log table from typos or unexpected caller values.
    if (!ALLOWED_ACTIONS.includes(action)) {
      throw new Error(`Invalid audit action: "${action}"`);
    }
    if (!ALLOWED_ENTITY_TYPES.includes(entity)) {
      throw new Error(`Invalid audit entity: "${entity}"`);
    }

    const uid = req?.session?.user?.id ?? null;
    const ip = req?.ip ?? null;
    // Coerce details to a string before the length check — a future caller
    // passing a non-string (object/number) would otherwise make `details.length`
    // undefined (always passing the truncation guard) or throw on `.substring`.
    // Normalizing here keeps the audit_log.details column consistent and crash-free.
    const raw = details == null ? '' : String(details);
    const safeDetails = details == null ? null
      : raw.length > MAX_AUDIT_DETAILS ? raw.substring(0, MAX_AUDIT_DETAILS)
        : raw;
    const safeEntityId = entityId == null || !Number.isFinite(Number(entityId))
      ? null
      : Number(entityId);
    _getAuditStmt().run(uid, action, entity, safeEntityId, safeDetails, ip);
  } catch (err) {
    // Audit logging should never crash the request
    console.error('Audit log error:', err.message);
  }
}

/**
 * Express middleware that attaches `audit` to `req` for convenience.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function auditMiddleware(req, res, next) {
  req.audit = (action, entity, entityId, details) =>
    audit({ req, action, entity, entityId, details });
  next();
}

module.exports = { audit, auditMiddleware, resetCachedStatements };
