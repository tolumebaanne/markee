/**
 * auditLog(action, resource) — wraps mutative endpoints with audit trail.
 *
 * Usage:
 *   router.post('/accounts/:id/suspend',
 *     requireAdminAuth, sessionActivity,
 *     auditLog('account.suspend', 'AdminAccount'),
 *     handler
 *   )
 *
 * The middleware patches res.json to capture the response, then writes
 * to AdminActionLog after the handler completes.
 */
const AdminActionLog = require('../models/AdminActionLog');

module.exports = function auditLog(action, resource = null) {
  return function (req, res, next) {
    if (!req.admin) return next();

    // Intercept res.json to capture response status
    const originalJson = res.json.bind(res);
    res.json = function (body) {
      // Write audit log entry (fire-and-forget) — guard against model not yet initialised
      if (!AdminActionLog.model) { return originalJson(body); }
      AdminActionLog.model.create({
        adminId:    req.admin.id,
        isSuperuser:req.admin.isSuperuser,
        sessionId:  req.admin.sessionId,
        action,
        resource,
        resourceId: req.params?.id || req.params?.accountId || null,
        service:    'admin-service',
        method:     req.method,
        path:       req.originalUrl,
        statusCode: res.statusCode,
        params:     { body: req.body, query: req.query, params: req.params },
        reason:     req.body?.reason || '',
        ipAddress:  req.ip || req.headers['x-forwarded-for'] || null,
        timestamp:  new Date()
      }).catch(err => console.error('[ADMIN] auditLog write error:', err.message));

      return originalJson(body);
    };

    next();
  };
};
