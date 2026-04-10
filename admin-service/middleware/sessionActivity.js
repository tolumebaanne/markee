/**
 * sessionActivity — updates lastActivityAt and enforces inactivity timeout.
 * Must run AFTER requireAdminAuth (needs req.admin).
 */
const AdminSession = require('../models/AdminSession');
const AdminAccount = require('../models/AdminAccount');
const errorResponse = require('../../shared/utils/errorResponse');

module.exports = async function sessionActivity(req, res, next) {
  if (!req.admin) return next(); // not an admin request

  try {
    const session = await AdminSession.model.findOne({ sessionId: req.admin.sessionId });
    if (!session) return errorResponse(res, 401, 'Session not found');

    const account = req.admin._account;
    const timeoutMs = (account.inactivityTimeoutMinutes || 30) * 60 * 1000;
    const now = new Date();

    // Inactivity check
    if (session.lastActivityAt && (now - session.lastActivityAt) > timeoutMs) {
      await AdminSession.model.findOneAndUpdate(
        { sessionId: req.admin.sessionId },
        { revoked: true, invalidatedReason: 'inactivity' }
      );
      return errorResponse(res, 401, 'Session expired due to inactivity');
    }

    // Update activity timestamp (fire-and-forget — don't await to avoid adding latency)
    AdminSession.model.findOneAndUpdate(
      { sessionId: req.admin.sessionId },
      { lastActivityAt: now }
    ).catch(err => console.error('[ADMIN] sessionActivity update error:', err.message));

    // Also update lastActive on the account
    AdminAccount.model.findByIdAndUpdate(
      account._id,
      { lastActive: now }
    ).catch(err => console.error('[ADMIN] lastActive update error:', err.message));

    next();
  } catch (err) {
    console.error('[ADMIN] sessionActivity error:', err.message);
    next(); // don't block the request on a non-critical check
  }
};
