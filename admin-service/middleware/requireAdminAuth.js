/**
 * requireAdminAuth — JWT validation + DB-authoritative permission load.
 *
 * m0t.OPERATOR.1.3: Never trust the JWT payload for access control.
 * Always load the live AdminAccount record from the DB on every request.
 * The JWT is used only to identify WHO is making the request.
 */
const jwt = require('jsonwebtoken');
const AdminAccount = require('../models/AdminAccount');
const AdminSession = require('../models/AdminSession');
const errorResponse = require('../../shared/utils/errorResponse');

module.exports = async function requireAdminAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return errorResponse(res, 401, 'Missing or invalid authorization header');
  }

  const token = authHeader.split(' ')[1];

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET);
  } catch (err) {
    return errorResponse(res, 401, 'Admin token invalid or expired');
  }

  if (!decoded.isAdmin) {
    return errorResponse(res, 403, 'Not an admin token');
  }

  try {
    // Load live record — permissions in JWT are NOT used for access control
    const account = await AdminAccount.model.findOne({ userId: decoded.sub });
    if (!account) return errorResponse(res, 403, 'Admin account not found');
    if (account.status !== 'active') return errorResponse(res, 403, `Admin account is ${account.status}`);

    // Validate session is still live
    const session = await AdminSession.model.findOne({
      sessionId: decoded.sessionId,
      revoked: false
    });
    if (!session) return errorResponse(res, 401, 'Session expired or revoked');
    if (session.refreshExpiresAt < new Date()) return errorResponse(res, 401, 'Session expired');

    // Superuser: single-session enforcement
    if (account.isSuperuser && account.currentSessionId !== decoded.sessionId) {
      return errorResponse(res, 401, 'Superuser session superseded by new login');
    }

    // Attach to request — routes use req.admin, not req.user
    req.admin = {
      id:          account._id.toString(),
      userId:      account.userId.toString(),
      email:       account.email,
      isSuperuser: account.isSuperuser,
      permissions: account.permissions.toObject ? account.permissions.toObject() : account.permissions,
      scopeRestrictions: account.scopeRestrictions,
      sessionId:   decoded.sessionId,
      _account:    account  // full document for session middleware
    };

    next();
  } catch (err) {
    console.error('[ADMIN] requireAdminAuth error:', err.message);
    errorResponse(res, 500, 'Auth check failed');
  }
};
