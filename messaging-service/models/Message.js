const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema({
    threadId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
        index: true
    },

    senderId: {
        type: mongoose.Schema.Types.ObjectId,
        default: null
    },

    recipientId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true
    },

    type: {
        type: String,
        enum: ['text', 'system', 'product_card', 'order_ref', 'attachment'],
        default: 'text'
    },

    body: { type: String, default: '' },

    attachment: {
        url:  { type: String },
        type: { type: String, enum: ['image'] }
    },

    status: {
        deliveredAt: { type: Date, default: null },
        readAt:      { type: Date, default: null }
    },

    edit: {
        edited:       { type: Boolean, default: false },
        editedAt:     { type: Date },
        originalBody: { type: String }
    },

    deletion: {
        deleted:           { type: Boolean, default: false },
        deletedAt:         { type: Date },
        senderAnonymized:  { type: Boolean, default: false }
    },

    reactions: [{
        userId: { type: mongoose.Schema.Types.ObjectId, required: true },
        emoji:  { type: String, required: true }
    }],

    createdAt: { type: Date, default: Date.now }
});

MessageSchema.index({ threadId: 1, createdAt: 1 });
MessageSchema.index({ threadId: 1, createdAt: -1 });
MessageSchema.index({ threadId: 1, type: 1 });

module.exports = MessageSchema;
