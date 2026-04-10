const mongoose = require('mongoose');

const AdminSessionSchema = new mongoose.Schema({
  sessionId:   { type: String, required: true, unique: true },
  adminId:     { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  isSuperuser: { type: Boolean, default: false },

  // Token tracking
  refreshToken:    { type: String, required: true, unique: true },
  refreshTokenHash:{ type: String, required: true },   // SHA-256 of refreshToken for safe DB lookup
  refreshExpiresAt:{ type: Date, required: true },
  revoked:         { type: Boolean, default: false },
  invalidatedReason: { type: String, default: null },  // 'logout', 'inactivity', 'new_session', 'admin_revoke'

  // Activity tracking
  createdAt:      { type: Date, default: Date.now },
  lastActivityAt: { type: Date, default: Date.now },
  ipAddress:      { type: String, default: null },
  userAgent:      { type: String, default: null }
});

// TTL index: auto-remove expired sessions from DB after refresh token expiry + 1 day
AdminSessionSchema.index({ refreshExpiresAt: 1 }, { expireAfterSeconds: 86400 });

let _model = null;
module.exports = {
  schema: AdminSessionSchema,
  init: (db) => { _model = db.model('AdminSession', AdminSessionSchema); return _model; },
  get model() { return _model; }
};
