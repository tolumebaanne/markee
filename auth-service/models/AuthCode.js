const mongoose = require('mongoose');

const AuthCodeSchema = new mongoose.Schema({
  code: { type: String, unique: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  clientId: String,
  scope: [String],
  redirectUri: String,
  expiresAt: { type: Date, default: () => new Date(Date.now() + 10 * 60 * 1000) }, // Default 10 mins
  used: { type: Boolean, default: false }
});

module.exports = mongoose.model('AuthCode', AuthCodeSchema);
