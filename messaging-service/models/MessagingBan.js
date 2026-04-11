const mongoose = require('mongoose');

const MessagingBanSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
        unique: true
    },
    reason:    { type: String },
    type:      { type: String, enum: ['permanent', 'temporary'] },
    expiresAt: { type: Date },
    bannedAt:  { type: Date, default: Date.now }
});

module.exports = MessagingBanSchema;
