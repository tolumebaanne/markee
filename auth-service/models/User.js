const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const UserSchema = new mongoose.Schema({
  email:        { type: String, unique: true, required: true },
  passwordHash: { type: String, required: true },
  // 'user' is the unified role — buyer and seller are capabilities, not roles.
  // 'buyer' and 'seller' kept in enum for backwards compat with existing documents.
  role:         { type: String, enum: ['user', 'buyer', 'seller', 'admin'], default: 'user', required: true },
  storeId:      { type: mongoose.Schema.Types.ObjectId, required: true, index: true }, // every user gets one at registration
  displayName:  { type: String, default: '' },
  phone:        { type: String, default: '' },
  createdAt:    { type: Date, default: Date.now },

  // Admin moderation state — separate from soft-delete lifecycle
  moderationStatus: { type: String, enum: ['active', 'suspended', 'banned'], default: 'active' },

  // Soft-delete lifecycle
  // 'pending_deletion' — user requested deletion, 24h cooldown window active, access revoked immediately
  // 'deleted'          — cooldown elapsed, email mangled, account fully soft-deleted, only Super can see it
  status:               { type: String, enum: ['active', 'pending_deletion', 'deleted'], default: 'active' },
  pendingDeletionSince: { type: Date },   // set when status → pending_deletion; used by scheduled job
  deletedAt:            { type: Date },   // set when status → deleted
  originalEmail:        { type: String }, // stores the real email after mangling; never emitted on event bus
  // Password reset — raw token is emailed; only the SHA-256 hash is stored here (m0t.AUTH.3.4)
  resetToken:           { type: String, default: null },
  resetTokenExpiry:     { type: Date,   default: null },
});

// Normalize email before every save — lowercase + trim enforced at model layer
// regardless of which call path creates or updates the document.
UserSchema.pre('save', function(next) {
  if (this.email) this.email = this.email.toLowerCase().trim();
  next();
});

UserSchema.statics.validatePassword = async function(email, password) {
  const user = await this.findOne({ email: email.toLowerCase().trim() });
  if (!user) return null;
  
  const isValid = await bcrypt.compare(password, user.passwordHash);
  if (!isValid) return null;
  
  return user;
};

UserSchema.statics.createUser = async function({ email, password, role, displayName, phone }) {
  const hashedPassword = await bcrypt.hash(password, 10);
  // Every user gets a storeId at registration — used for product ownership and cascade cleanup
  const storeId = new mongoose.Types.ObjectId();
  // Normalise legacy roles to 'user'
  const normalisedRole = (role === 'buyer' || role === 'seller') ? 'user' : (role || 'user');
  return await this.create({
    email,
    passwordHash: hashedPassword,
    role: normalisedRole,
    storeId,
    displayName: displayName || '',
    phone:       phone       || ''
  });
};

module.exports = mongoose.model('User', UserSchema);
