/**
 * Admin Account Management — /admin/accounts/*
 *
 * Superuser can create, adjust, suspend, and revoke spawned admin accounts.
 * Permission inheritance: spawned admin can never receive permissions
 * exceeding those of the account creating them.
 */
const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcrypt');
const crypto   = require('crypto');

const AdminAccount       = require('../models/AdminAccount');
const PermissionTemplate = require('../models/PermissionTemplate');
const AdminActionLog     = require('../models/AdminActionLog');
const { generateSecret, otpauthUri, generateRecoveryCodes } = require('../utils/totp');
const requireAdminAuth   = require('../middleware/requireAdminAuth');
const requirePermission  = require('../middleware/requirePermission');
const sessionActivity    = require('../middleware/sessionActivity');
const auditLog           = require('../middleware/auditLog');
const errorResponse      = require('../../shared/utils/errorResponse');
const bus                = require('../../shared/eventBus');

// All account management routes require admin auth + session activity tracking
router.use(requireAdminAuth, sessionActivity);

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a full permissions object with all fields set to false.
 * Used as the empty bucket for new admin accounts.
 */
function emptyPermissions() {
  const make = (...keys) => Object.fromEntries(keys.map(k => [k, false]));
  return {
    auth:          make('read', 'write', 'ban', 'impersonate'),
    catalog:       make('read', 'write', 'approve', 'reject', 'feature', 'categoryMgmt', 'bulk'),
    listingReview: make('canReview', 'canAssign', 'canUseTemplates', 'canViewOwnActivityLog'),
    orders:        make('read', 'forceStatus', 'cancel', 'bulk'),
    payments:      make('read', 'refund', 'release', 'partialRefund', 'freeze', 'splitRefund', 'resolveDisputes', 'payoutHold'),
    sellers:       make('read', 'write', 'verify', 'suspend', 'ban', 'regApproval', 'tier'),
    reviews:       make('read', 'moderate', 'delete', 'bulk'),
    messages:      make('read', 'moderate', 'inject', 'ban'),
    notifications: make('read', 'send', 'broadcast', 'editTemplates', 'prefOverride', 'config'),
    analytics:     make('read', 'readAll', 'export'),
    search:        make('read', 'feature', 'reindex', 'hide', 'autocomplete'),
    inventory:     make('read', 'adjust', 'freeze'),
    shipping:      make('read', 'forceStatus'),
    intelligence:  make('sellerScores', 'buyerScores', 'buyerOverride', 'fraudSignals', 'anomalies', 'leakage', 'balance', 'funnel'),
    config:        make('read', 'write'),
    audit:         make('readOwn', 'readAll', 'export'),
    system:        make('impersonate', 'nukeTokens', 'lockdown')
  };
}

/**
 * Clamp permissions: ensure no spawned admin gets a permission
 * that the creating admin doesn't have. Superuser bypasses this.
 */
function clampPermissions(requested, grantor) {
  if (grantor.isSuperuser) return requested;
  const result = emptyPermissions();
  for (const domain of Object.keys(result)) {
    for (const action of Object.keys(result[domain])) {
      const grantorHas = grantor.permissions?.[domain]?.[action] === true;
      result[domain][action] = grantorHas && requested?.[domain]?.[action] === true;
    }
  }
  // system permissions can only be granted by Superuser — always strip from spawned grants
  result.system = make('impersonate', 'nukeTokens', 'lockdown');
  function make(...keys) { return Object.fromEntries(keys.map(k => [k, false])); }
  return result;
}

// ── GET /admin/accounts — list all admin accounts ─────────────────────────────
router.get('/', requirePermission('auth', 'read'), async (req, res) => {
  try {
    const { status, page = 1, limit = 50 } = req.query;
    const query = {};
    if (status) query.status = status;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const lim  = Math.min(parseInt(limit), 100);

    const [accounts, total] = await Promise.all([
      AdminAccount.model.find(query)
        .select('-mfaSecret -mfaRecoveryCodes -currentSessionId')
        .sort({ createdAt: -1 })
        .skip(skip).limit(lim),
      AdminAccount.model.countDocuments(query)
    ]);

    res.json({ accounts, total, page: parseInt(page), hasMore: skip + lim < total });
  } catch (err) {
    errorResponse(res, 500, err.message);
  }
});

// ── GET /admin/accounts/:id — get single account ──────────────────────────────
router.get('/:id', requirePermission('auth', 'read'), async (req, res) => {
  try {
    const account = await AdminAccount.model
      .findById(req.params.id)
      .select('-mfaSecret -mfaRecoveryCodes -currentSessionId');
    if (!account) return errorResponse(res, 404, 'Account not found');
    res.json(account);
  } catch (err) {
    errorResponse(res, 500, err.message);
  }
});

// ── POST /admin/accounts — create a spawned admin account ─────────────────────
router.post('/', requirePermission('auth', 'write'), auditLog('account.create', 'AdminAccount'), async (req, res) => {
  const { email, templateId, permissions: requestedPerms, scopeRestrictions, mfaEnabled } = req.body;
  if (!email) return errorResponse(res, 400, 'email required');

  try {
    // Resolve permissions: template > manual > empty bucket
    let permissions = emptyPermissions();
    if (templateId) {
      const template = await PermissionTemplate.model.findById(templateId);
      if (!template) return errorResponse(res, 404, 'Permission template not found');
      permissions = { ...emptyPermissions(), ...template.permissions };
    } else if (requestedPerms) {
      permissions = requestedPerms;
    }

    // Clamp to grantor's own permissions (permission inheritance enforcement)
    permissions = clampPermissions(permissions, req.admin);

    // Create a User record in the Auth Service first, then an AdminAccount here
    // The auth service quick-login endpoint handles credential creation
    // For now, we create a placeholder userId (in production, call auth service to create user)
    const userId = new (require('mongoose').Types.ObjectId)();

    const account = await AdminAccount.model.create({
      userId,
      email,
      isSuperuser: false,
      permissions,
      permissionTemplateId: templateId || null,
      scopeRestrictions: scopeRestrictions || {},
      mfaEnabled: mfaEnabled === true,
      maxConcurrentSessions: 2,
      inactivityTimeoutMinutes: 30,
      createdBy: req.admin.id,
      status: 'active'
    });

    bus.emit('admin.account_created', {
      createdBy: req.admin.id,
      newAdminId: account._id.toString(),
      email
    });

    res.status(201).json({ account: { ...account.toObject(), mfaSecret: undefined, mfaRecoveryCodes: undefined } });
  } catch (err) {
    if (err.code === 11000) return errorResponse(res, 409, 'An admin account with this email already exists');
    errorResponse(res, 500, err.message);
  }
});

// ── PUT /admin/accounts/:id/permissions — update permissions ──────────────────
router.put('/:id/permissions',
  requirePermission('auth', 'write'),
  auditLog('account.permissions_update', 'AdminAccount'),
  async (req, res) => {
    try {
      const target = await AdminAccount.model.findById(req.params.id);
      if (!target) return errorResponse(res, 404, 'Account not found');
      if (target.isSuperuser) return errorResponse(res, 403, 'Cannot modify Superuser permissions');

      const clamped = clampPermissions(req.body.permissions, req.admin);
      const updated = await AdminAccount.model.findByIdAndUpdate(
        req.params.id,
        { permissions: clamped, permissionTemplateId: req.body.templateId || null },
        { new: true }
      ).select('-mfaSecret -mfaRecoveryCodes');

      bus.emit('admin.permissions_updated', {
        updatedBy: req.admin.id,
        targetAdminId: req.params.id
      });

      res.json(updated);
    } catch (err) {
      errorResponse(res, 500, err.message);
    }
  }
);

// ── POST /admin/accounts/:id/apply-template — apply a preset ─────────────────
router.post('/:id/apply-template',
  requirePermission('auth', 'write'),
  auditLog('account.template_applied', 'AdminAccount'),
  async (req, res) => {
    const { templateId } = req.body;
    if (!templateId) return errorResponse(res, 400, 'templateId required');
    try {
      const [target, template] = await Promise.all([
        AdminAccount.model.findById(req.params.id),
        PermissionTemplate.model.findById(templateId)
      ]);
      if (!target)   return errorResponse(res, 404, 'Account not found');
      if (!template) return errorResponse(res, 404, 'Template not found');
      if (target.isSuperuser) return errorResponse(res, 403, 'Cannot apply template to Superuser');

      const clamped = clampPermissions(template.permissions, req.admin);
      const updated = await AdminAccount.model.findByIdAndUpdate(
        req.params.id,
        { permissions: clamped, permissionTemplateId: templateId },
        { new: true }
      ).select('-mfaSecret -mfaRecoveryCodes');

      res.json(updated);
    } catch (err) {
      errorResponse(res, 500, err.message);
    }
  }
);

// ── POST /admin/accounts/:id/suspend ─────────────────────────────────────────
router.post('/:id/suspend',
  requirePermission('auth', 'write'),
  auditLog('account.suspend', 'AdminAccount'),
  async (req, res) => {
    try {
      const target = await AdminAccount.model.findById(req.params.id);
      if (!target) return errorResponse(res, 404, 'Account not found');
      if (target.isSuperuser) return errorResponse(res, 403, 'Cannot suspend the Superuser');
      if (target.status === 'suspended') return errorResponse(res, 400, 'Already suspended');

      const updated = await AdminAccount.model.findByIdAndUpdate(
        req.params.id,
        {
          status: 'suspended',
          suspendedAt: new Date(),
          suspendedBy: req.admin.id,
          suspendReason: req.body.reason || ''
        },
        { new: true }
      ).select('-mfaSecret -mfaRecoveryCodes');

      // Revoke all active sessions
      await AdminSession.model.updateMany(
        { adminId: target._id, revoked: false },
        { revoked: true, invalidatedReason: 'admin_revoke' }
      );

      bus.emit('admin.account_suspended', {
        suspendedBy: req.admin.id,
        targetAdminId: req.params.id,
        reason: req.body.reason || ''
      });

      res.json(updated);
    } catch (err) {
      errorResponse(res, 500, err.message);
    }
  }
);

// ── POST /admin/accounts/:id/reactivate ──────────────────────────────────────
router.post('/:id/reactivate',
  requirePermission('auth', 'write'),
  auditLog('account.reactivate', 'AdminAccount'),
  async (req, res) => {
    try {
      const updated = await AdminAccount.model.findByIdAndUpdate(
        req.params.id,
        { status: 'active', suspendedAt: null, suspendedBy: null, suspendReason: '' },
        { new: true }
      ).select('-mfaSecret -mfaRecoveryCodes');
      if (!updated) return errorResponse(res, 404, 'Account not found');
      bus.emit('admin.account_reactivated', { reactivatedBy: req.admin.id, targetAdminId: req.params.id });
      res.json(updated);
    } catch (err) {
      errorResponse(res, 500, err.message);
    }
  }
);

// ── POST /admin/accounts/:id/revoke ──────────────────────────────────────────
router.post('/:id/revoke',
  requirePermission('auth', 'write'),
  auditLog('account.revoke', 'AdminAccount'),
  async (req, res) => {
    try {
      const target = await AdminAccount.model.findById(req.params.id);
      if (!target) return errorResponse(res, 404, 'Account not found');
      if (target.isSuperuser) return errorResponse(res, 403, 'Cannot revoke the Superuser');

      const updated = await AdminAccount.model.findByIdAndUpdate(
        req.params.id,
        {
          status: 'revoked',
          revokedAt: new Date(),
          revokedBy: req.admin.id,
          revokeReason: req.body.reason || ''
        },
        { new: true }
      ).select('-mfaSecret -mfaRecoveryCodes');

      await AdminSession.model.updateMany(
        { adminId: target._id, revoked: false },
        { revoked: true, invalidatedReason: 'admin_revoke' }
      );

      bus.emit('admin.account_revoked', {
        revokedBy: req.admin.id,
        targetAdminId: req.params.id,
        reason: req.body.reason || ''
      });

      res.json(updated);
    } catch (err) {
      errorResponse(res, 500, err.message);
    }
  }
);

// ── PATCH /admin/accounts/:id/permissions — update permission set ─────────────
router.patch('/:id/permissions',
  requirePermission('auth', 'write'),
  auditLog('account.permissions_update', 'AdminAccount'),
  async (req, res) => {
    try {
      const target = await AdminAccount.model.findById(req.params.id);
      if (!target) return errorResponse(res, 404, 'Account not found');
      if (target.isSuperuser) return errorResponse(res, 403, 'Cannot modify Superuser permissions');
      if (target.status === 'revoked') return errorResponse(res, 403, 'Cannot modify revoked account');
      const clamped = clampPermissions(req.body.permissions || {}, req.admin);
      const updated = await AdminAccount.model.findByIdAndUpdate(
        req.params.id,
        { permissions: clamped, updatedAt: new Date() },
        { new: true }
      ).select('-mfaSecret -mfaRecoveryCodes');
      bus.emit('admin.permissions_updated', { updatedBy: req.admin.id, targetAdminId: req.params.id });
      // Kill existing sessions — permission change takes immediate effect on next request
      await AdminSession.model.updateMany(
        { adminId: target._id, revoked: false },
        { revoked: true, invalidatedReason: 'permissions_changed' }
      );
      res.json(updated);
    } catch (err) {
      errorResponse(res, 500, err.message);
    }
  }
);

// ── POST /admin/accounts/:id/setup-mfa — initiate MFA setup ──────────────────
router.post('/:id/setup-mfa', async (req, res) => {
  // Admin can set up their own MFA, or Superuser can set it up for anyone
  if (req.params.id !== req.admin.id && !req.admin.isSuperuser) {
    return errorResponse(res, 403, 'Can only set up your own MFA');
  }
  try {
    const account = await AdminAccount.model.findById(req.params.id);
    if (!account) return errorResponse(res, 404, 'Account not found');

    const secret = generateSecret();
    const uri    = otpauthUri(secret, account.email);

    // Store secret (not yet activated — requires confirmation via confirm-mfa)
    await AdminAccount.model.findByIdAndUpdate(req.params.id, { mfaSecret: secret });

    res.json({ secret, otpauth_uri: uri, message: 'Scan the QR code, then confirm with POST /confirm-mfa' });
  } catch (err) {
    errorResponse(res, 500, err.message);
  }
});

// ── POST /admin/accounts/:id/confirm-mfa — activate MFA after TOTP verified ──
router.post('/:id/confirm-mfa', async (req, res) => {
  if (req.params.id !== req.admin.id && !req.admin.isSuperuser) {
    return errorResponse(res, 403, 'Can only confirm your own MFA');
  }
  const { totp_code } = req.body;
  if (!totp_code) return errorResponse(res, 400, 'totp_code required');

  try {
    const account = await AdminAccount.model.findById(req.params.id);
    if (!account || !account.mfaSecret) return errorResponse(res, 400, 'MFA setup not initiated');

    const { verifyTotp: verify } = require('../utils/totp');
    if (!verify(account.mfaSecret, totp_code)) return errorResponse(res, 401, 'Invalid TOTP code');

    // Generate recovery codes
    const rawCodes  = generateRecoveryCodes();
    const hashedCodes = await Promise.all(rawCodes.map(c => bcrypt.hash(c.replace(/-/g, ''), 10)));

    await AdminAccount.model.findByIdAndUpdate(req.params.id, {
      mfaEnabled: true,
      mfaRecoveryCodes: hashedCodes
    });

    bus.emit('admin.mfa_enabled', { adminId: req.params.id });

    res.json({
      success: true,
      recovery_codes: rawCodes,
      message: 'Save these recovery codes. They will not be shown again.'
    });
  } catch (err) {
    errorResponse(res, 500, err.message);
  }
});

// ── GET /admin/accounts/:id/sessions — list active sessions ──────────────────
router.get('/:id/sessions', requirePermission('auth', 'read'), async (req, res) => {
  try {
    const sessions = await AdminSession.model
      .find({ adminId: req.params.id, revoked: false })
      .select('-refreshToken -refreshTokenHash')
      .sort({ createdAt: -1 });
    res.json(sessions);
  } catch (err) {
    errorResponse(res, 500, err.message);
  }
});

// ── DELETE /admin/accounts/:id/sessions — revoke all sessions ────────────────
router.delete('/:id/sessions',
  requirePermission('auth', 'write'),
  auditLog('account.sessions_revoked', 'AdminAccount'),
  async (req, res) => {
    try {
      const result = await AdminSession.model.updateMany(
        { adminId: req.params.id, revoked: false },
        { revoked: true, invalidatedReason: 'admin_revoke' }
      );
      res.json({ revokedCount: result.modifiedCount });
    } catch (err) {
      errorResponse(res, 500, err.message);
    }
  }
);

module.exports = router;
