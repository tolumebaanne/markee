const mongoose = require('mongoose');

const RefreshTokenSchema = new mongoose.Schema({
  token: { type: String, unique: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  expiresAt: { type: Date, expires: '7d' }, // Auto delete after 7 days
  revoked: { type: Boolean, default: false }
});

module.exports = mongoose.model('RefreshToken', RefreshTokenSchema);
