const db = require('../models/database');

// Cache the prepared statement — audit() is called on every write route
// and prepare() is relatively expensive.
const _auditStmt = db.prepare(`
  INSERT INTO audit_log (user_id, action, entity_type, entity_id, details, ip_address)
  VALUES (?, ?, ?, ?, ?, ?)
`);

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
    const uid = req && req.session && req.session.user ? req.session.user.id : null;
    const ip = req && req.ip ? req.ip : null;
    // Truncate details to prevent unbounded row growth
    const MAX_DETAILS_LENGTH = 4000;
    const safeDetails = details && details.length > MAX_DETAILS_LENGTH ? details.substring(0, MAX_DETAILS_LENGTH) : (details || null);
    _auditStmt.run(uid, action, entity, entityId || null, safeDetails, ip);
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

module.exports = { audit, auditMiddleware };
