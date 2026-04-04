const mongoose = require('mongoose');

const AuthCodeSchema = new mongoose.Schema({
  code: { type: String, unique: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  clientId: String,
  scope: [String],
  redirectUri: String,
  expiresAt: { type: Date, expires: '10m' }, // Auto delete after 10m based on spec
  used: { type: Boolean, default: false }
});

module.exports = mongoose.model('AuthCode', AuthCodeSchema);
