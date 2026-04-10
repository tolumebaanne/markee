/**
 * System Controls — /admin/system/*
 *
 * Superuser-only controls: maintenance mode, lockdown, token nuking,
 * impersonation, platform-wide operations.
 *
 * m0t.SYSTEM: All system state changes cascade simultaneously —
 * DB write, event emission, and audit log in a single atomic flow.
 */
const express = require('express');
const router  = express.Router();

const PlatformConfig   = require('../models/PlatformConfig');
const AdminAccount     = require('../models/AdminAccount');
const AdminSession     = require('../models/AdminSession');
const requireAdminAuth = require('../middleware/requireAdminAuth');
const requirePermission= require('../middleware/requirePermission');
const sessionActivity  = require('../middleware/sessionActivity');
const auditLog         = require('../middleware/auditLog');
const errorResponse    = require('../../shared/utils/errorResponse');
const bus              = require('../../shared/eventBus');

router.use(requireAdminAuth, sessionActivity);

// ── GET /admin/system/status ──────────────────────────────────────────────────
router.get('/status', async (req, res) => {
  try {
    const config = await PlatformConfig.model.getSingleton();
    res.json({
      maintenanceMode: config.maintenanceMode,
      lockdownMode:    config.lockdownMode,
      flags:           config.flags,
      limits:          config.limits,
      updatedAt:       config.updatedAt
    });
  } catch (err) {
    errorResponse(res, 500, err.message);
  }
});

// ── POST /admin/system/maintenance — toggle maintenance mode ──────────────────
router.post('/maintenance',
  requirePermission('system', 'lockdown'),
  auditLog('system.maintenance_toggle', 'PlatformConfig'),
  async (req, res) => {
    const { enabled, reason } = req.body;
    if (typeof enabled !== 'boolean') return errorResponse(res, 400, 'enabled (boolean) required');
    try {
      const config = await PlatformConfig.model.findOneAndUpdate(
        { _singleton: 'global' },
        { maintenanceMode: enabled, updatedAt: new Date(), updatedBy: req.admin.id },
        { new: true, upsert: true }
      );

      bus.emit('platform.maintenance_mode', {
        enabled,
        reason: reason || '',
        changedBy: req.admin.id,
        timestamp: new Date()
      });

      console.log(`[ADMIN] Maintenance mode ${enabled ? 'ENABLED' : 'DISABLED'} by ${req.admin.email}`);
      res.json({ maintenanceMode: config.maintenanceMode, message: `Maintenance mode ${enabled ? 'enabled' : 'disabled'}` });
    } catch (err) {
      errorResponse(res, 500, err.message);
    }
  }
);

// ── POST /admin/system/lockdown — full platform lockdown ──────────────────────
router.post('/lockdown',
  requirePermission('system', 'lockdown'),
  auditLog('system.lockdown_toggle', 'PlatformConfig'),
  async (req, res) => {
    const { enabled, reason } = req.body;
    if (typeof enabled !== 'boolean') return errorResponse(res, 400, 'enabled (boolean) required');
    try {
      const config = await PlatformConfig.model.findOneAndUpdate(
        { _singleton: 'global' },
        { lockdownMode: enabled, updatedAt: new Date(), updatedBy: req.admin.id },
        { new: true, upsert: true }
      );

      bus.emit('platform.lockdown', {
        enabled,
        reason: reason || '',
        changedBy: req.admin.id,
        timestamp: new Date()
      });

      console.warn(`[ADMIN] ⚠️  Platform lockdown ${enabled ? 'ACTIVATED' : 'DEACTIVATED'} by ${req.admin.email}. Reason: ${reason}`);
      res.json({ lockdownMode: config.lockdownMode, message: `Lockdown ${enabled ? 'activated' : 'deactivated'}` });
    } catch (err) {
      errorResponse(res, 500, err.message);
    }
  }
);

// ── POST /admin/system/nuke-tokens/:userId — invalidate all tokens for a user ─
router.post('/nuke-tokens/:userId',
  requirePermission('system', 'nukeTokens'),
  auditLog('system.nuke_tokens', 'User'),
  async (req, res) => {
    const { userId } = req.params;
    try {
      // Revoke all admin sessions for this user if they are an admin
      const adminAccount = await AdminAccount.model.findOne({ userId });
      if (adminAccount) {
        await AdminSession.model.updateMany(
          { adminId: adminAccount._id, revoked: false },
          { revoked: true, invalidatedReason: 'admin_revoke' }
        );
      }

      // Emit event — Auth Service and other services listen to revoke user tokens
      bus.emit('admin.tokens_nuked', {
        userId,
        nukedBy: req.admin.id,
        reason: req.body.reason || '',
        timestamp: new Date()
      });

      res.json({ success: true, message: `All tokens for user ${userId} have been invalidated` });
    } catch (err) {
      errorResponse(res, 500, err.message);
    }
  }
);

// ── POST /admin/system/impersonate/:userId — issue impersonation token ────────
router.post('/impersonate/:userId',
  requirePermission('system', 'impersonate'),
  auditLog('system.impersonate', 'User'),
  async (req, res) => {
    const jwt = require('jsonwebtoken');
    try {
      // Fetch user details from Auth Service
      const authUrl  = process.env.AUTH_SERVICE_URL || 'http://localhost:5001';
      const authRes  = await fetch(`${authUrl}/users/${req.params.userId}`);
      if (!authRes.ok) return errorResponse(res, 404, 'User not found in Auth Service');
      const user = await authRes.json();

      // Issue a short-lived impersonation token (5 minutes, non-refreshable)
      const token = jwt.sign(
        {
          sub:           user._id || user.id,
          email:         user.email,
          role:          user.role,
          storeId:       user.storeId || null,
          storeActive:   user.storeActive || false,
          displayName:   user.displayName || '',
          scopes:        ['catalog:read', 'orders:read'],
          impersonatedBy:req.admin.id,
          isImpersonation: true,
          exp: Math.floor(Date.now() / 1000) + (5 * 60)
        },
        process.env.JWT_SECRET
      );

      bus.emit('admin.impersonation_started', {
        adminId: req.admin.id,
        targetUserId: req.params.userId,
        reason: req.body.reason || ''
      });

      res.json({
        access_token: token,
        token_type: 'Bearer',
        expires_in: 300,
        warning: 'This token is non-refreshable and expires in 5 minutes. All actions are audited.'
      });
    } catch (err) {
      errorResponse(res, 500, err.message);
    }
  }
);

// ── POST /admin/system/flags — update feature flags ──────────────────────────
router.post('/flags',
  requirePermission('config', 'write'),
  auditLog('system.flags_update', 'PlatformConfig'),
  async (req, res) => {
    try {
      const allowed = ['buyerReviewsEnabled', 'sellerRegistrationOpen', 'guestCheckoutEnabled',
        'codEnabled', 'searchAutocompleteLive', 'analyticsPublic', 'messagingEnabled',
        'notificationsEnabled', 'sellerTierBadges',
        'PRODUCT_REVIEW_ENABLED', 'SELLER_REGISTRATION_APPROVAL_ENABLED', 'COD_ENABLED',
        'REVIEWS_ENABLED', 'SEARCH_ENABLED', 'NOTIFICATIONS_ENABLED', 'MESSAGING_ENABLED'];
      const updates = {};
      // Support both {flag, enabled} single-toggle AND bulk {flagName: bool} patterns
      if (req.body.flag !== undefined && req.body.enabled !== undefined) {
        if (allowed.includes(req.body.flag)) updates[`flags.${req.body.flag}`] = req.body.enabled;
      } else {
        for (const key of allowed) {
          if (req.body[key] !== undefined) updates[`flags.${key}`] = req.body[key];
        }
      }
      if (!Object.keys(updates).length) return errorResponse(res, 400, 'No valid flags provided');
      updates.updatedAt = new Date();
      updates.updatedBy = req.admin.id;

      const config = await PlatformConfig.model.findOneAndUpdate(
        { _singleton: 'global' },
        { $set: updates },
        { new: true, upsert: true }
      );

      bus.emit('platform.flags_updated', {
        flags: req.body,
        updatedBy: req.admin.id,
        timestamp: new Date()
      });

      res.json({ flags: config.flags });
    } catch (err) {
      errorResponse(res, 500, err.message);
    }
  }
);

// ── POST /admin/system/nuke-tokens/all — revoke ALL platform tokens ───────────
router.post('/nuke-tokens/all',
  requirePermission('system', 'nukeTokens'),
  auditLog('system.nuke_all_tokens', 'Platform'),
  async (req, res) => {
    try {
      await AdminSession.model.updateMany({ revoked: false }, { revoked: true, invalidatedReason: 'nuke_all' });
      bus.emit('admin.all_tokens_nuked', { nukedBy: req.admin.id, reason: req.body.reason || '', timestamp: new Date() });
      console.warn(`[ADMIN] ☢️  ALL PLATFORM TOKENS NUKED by ${req.admin.email}`);
      res.json({ success: true, message: 'All tokens revoked platform-wide' });
    } catch (err) { errorResponse(res, 500, err.message); }
  }
);

// ── PATCH /admin/system/config/platform-fee ───────────────────────────────────
router.patch('/config/platform-fee',
  requirePermission('config', 'write'),
  auditLog('system.platform_fee_update', 'PlatformConfig'),
  async (req, res) => {
    const fee = parseFloat(req.body.fee);
    if (isNaN(fee) || fee < 0 || fee > 50) return errorResponse(res, 400, 'fee must be 0–50');
    try {
      const config = await PlatformConfig.model.findOneAndUpdate(
        { _singleton: 'global' },
        { $set: { 'limits.platformFeePercent': fee, updatedAt: new Date(), updatedBy: req.admin.id } },
        { new: true, upsert: true }
      );
      bus.emit('platform.fee_updated', { fee, updatedBy: req.admin.id });
      res.json({ platformFeePercent: fee });
    } catch (err) { errorResponse(res, 500, err.message); }
  }
);

// ── PATCH /admin/system/config/dispute-window ─────────────────────────────────
router.patch('/config/dispute-window',
  requirePermission('config', 'write'),
  auditLog('system.dispute_window_update', 'PlatformConfig'),
  async (req, res) => {
    const hours = parseInt(req.body.hours);
    if (isNaN(hours) || hours < 1 || hours > 720) return errorResponse(res, 400, 'hours must be 1–720');
    try {
      await PlatformConfig.model.findOneAndUpdate(
        { _singleton: 'global' },
        { $set: { 'limits.disputeWindowHours': hours, updatedAt: new Date(), updatedBy: req.admin.id } },
        { upsert: true }
      );
      bus.emit('platform.dispute_window_updated', { hours, updatedBy: req.admin.id });
      res.json({ disputeWindowHours: hours });
    } catch (err) { errorResponse(res, 500, err.message); }
  }
);

// ── GET /admin/system/audit ── audit log viewer ───────────────────────────────
router.get('/audit',
  requirePermission('audit', 'readAll'),
  async (req, res) => {
    const AdminActionLog = require('../models/AdminActionLog');
    try {
      const { adminId, action, from, to, page = 1, limit = 50 } = req.query;
      const query = {};
      if (adminId) query.adminId = adminId;
      if (action)  query.action  = { $regex: action, $options: 'i' };
      if (from || to) query.timestamp = {
        ...(from && { $gte: new Date(from) }),
        ...(to   && { $lte: new Date(to)   })
      };
      const skip = (parseInt(page) - 1) * parseInt(limit);
      const lim  = Math.min(parseInt(limit), 100);
      const [logs, total] = await Promise.all([
        AdminActionLog.model.find(query).sort({ timestamp: -1 }).skip(skip).limit(lim),
        AdminActionLog.model.countDocuments(query)
      ]);
      res.json({ logs, total, page: parseInt(page), hasMore: skip + lim < total });
    } catch (err) {
      errorResponse(res, 500, err.message);
    }
  }
);

module.exports = router;
