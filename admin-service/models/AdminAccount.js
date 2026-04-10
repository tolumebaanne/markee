const mongoose = require('mongoose');

const permissionFields = (keys) => {
  const obj = {};
  for (const k of keys) obj[k] = { type: Boolean, default: false };
  return obj;
};

const AdminAccountSchema = new mongoose.Schema({
  userId:  { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
  email:   { type: String, required: true, unique: true },

  isSuperuser: { type: Boolean, default: false },

  // ── MFA ─────────────────────────────────────────────────────────────────────
  mfaEnabled:       { type: Boolean, default: false },
  mfaSecret:        { type: String, default: null },
  mfaRecoveryCodes: { type: [String], default: [] },  // bcrypt-hashed, single-use

  // ── Session security ─────────────────────────────────────────────────────────
  currentSessionId:         { type: String, default: null },  // Superuser: single-session enforcement
  maxConcurrentSessions:    { type: Number, default: 2 },
  inactivityTimeoutMinutes: { type: Number, default: 30 },

  // ── Permissions bucket ───────────────────────────────────────────────────────
  permissions: {
    auth:          permissionFields(['read', 'write', 'ban', 'impersonate']),
    catalog:       permissionFields(['read', 'write', 'approve', 'reject', 'feature', 'categoryMgmt', 'bulk']),
    orders:        permissionFields(['read', 'forceStatus', 'cancel', 'bulk']),
    payments:      permissionFields(['read', 'refund', 'release', 'partialRefund', 'freeze', 'splitRefund', 'resolveDisputes', 'payoutHold']),
    sellers:       permissionFields(['read', 'write', 'verify', 'suspend', 'ban', 'regApproval', 'tier']),
    reviews:       permissionFields(['read', 'moderate', 'delete', 'bulk']),
    messages:      permissionFields(['read', 'moderate', 'inject', 'ban']),
    notifications: permissionFields(['read', 'send', 'broadcast', 'editTemplates', 'prefOverride', 'config']),
    analytics:     permissionFields(['read', 'readAll', 'export']),
    search:        permissionFields(['read', 'feature', 'reindex', 'hide', 'autocomplete']),
    inventory:     permissionFields(['read', 'adjust', 'freeze']),
    shipping:      permissionFields(['read', 'forceStatus']),
    intelligence:  permissionFields(['sellerScores', 'buyerScores', 'buyerOverride', 'fraudSignals', 'anomalies', 'leakage', 'balance', 'funnel']),
    config:        permissionFields(['read', 'write']),
    audit:         permissionFields(['readOwn', 'readAll', 'export']),
    system:        permissionFields(['impersonate', 'nukeTokens', 'lockdown'])  // Superuser-only
  },

  permissionTemplateId: { type: mongoose.Schema.Types.ObjectId, default: null },

  scopeRestrictions: {
    storeId:  { type: mongoose.Schema.Types.ObjectId, default: null },
    category: { type: String, default: null }
  },

  status:        { type: String, enum: ['active', 'suspended', 'revoked'], default: 'active' },
  suspendedAt:   { type: Date, default: null },
  suspendedBy:   { type: mongoose.Schema.Types.ObjectId, default: null },
  suspendReason: { type: String, default: '' },
  revokedAt:     { type: Date, default: null },
  revokedBy:     { type: mongoose.Schema.Types.ObjectId, default: null },
  revokeReason:  { type: String, default: '' },

  createdBy:        { type: mongoose.Schema.Types.ObjectId, default: null },
  createdAt:        { type: Date, default: Date.now },
  lastActive:       { type: Date, default: null },
  lastLoginIp:      { type: String, default: null },
  lastLoginAt:      { type: Date, default: null },
  failedLoginCount: { type: Number, default: 0 },
  lockedUntil:      { type: Date, default: null }
});

let _model = null;
module.exports = {
  schema: AdminAccountSchema,
  init: (db) => { _model = db.model('AdminAccount', AdminAccountSchema); return _model; },
  get model() { return _model; }
};
