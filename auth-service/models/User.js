const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const UserSchema = new mongoose.Schema({
  email:        { type: String, unique: true, required: true },
  passwordHash: { type: String, required: true },
  // 'buyer'/'seller' kept in enum for backwards compat; 'user' is the unified role (buyer/seller are capabilities)
  role:         { type: String, enum: ['user', 'buyer', 'seller', 'admin'], default: 'user', required: true },
  storeId:      { type: mongoose.Schema.Types.ObjectId, required: true, index: true }, // every user gets one at registration
  displayName:  { type: String, default: '' },
  phone:        { type: String, default: '' },
  createdAt:    { type: Date, default: Date.now },

  // Admin moderation state — separate from soft-delete lifecycle
  moderationStatus: { type: String, enum: ['active', 'suspended', 'banned'], default: 'active' },

  // Soft-delete lifecycle: pending_deletion = 24h cooldown, access revoked; deleted = email mangled, Super-only
  status:               { type: String, enum: ['active', 'pending_deletion', 'deleted'], default: 'active' },
  pendingDeletionSince: { type: Date },   // set when status → pending_deletion; used by scheduled job
  deletedAt:            { type: Date },
  originalEmail:        { type: String }, // real email after mangling; never emitted on event bus
  // raw token is emailed; only the SHA-256 hash is stored
  resetToken:           { type: String, default: null },
  resetTokenExpiry:     { type: Date,   default: null },

  // Onboarding — false until user completes Phase 1 profile setup (phone + default address)
  profileSetupDone: { type: Boolean, default: false },
});

// async pre-save — Mongoose 9 resolves via the returned Promise, not a callback
UserSchema.pre('save', async function() {
  if (this.email) this.email = this.email.toLowerCase().trim();
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
