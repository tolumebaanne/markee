const mongoose = require('mongoose');

const ThreadSchema = new mongoose.Schema({
    participants: [{
        type: mongoose.Schema.Types.ObjectId,
        required: true
    }],

    context: {
        type:     { type: String, enum: ['product', 'order', 'general'], default: 'general' },
        refId:    { type: mongoose.Schema.Types.ObjectId },
        refTitle: { type: String, default: '' },
        refImage: { type: String, default: '' }
    },

    lastMessage:     { type: String, default: '' },
    lastMessageType: { type: String, default: 'text' },
    lastAt:          { type: Date, default: Date.now },
    messageCount:    { type: Number, default: 0 },

    readCursors: {
        type: Map,
        of: new mongoose.Schema({
            lastReadAt:  { type: Date },
            unreadCount: { type: Number, default: 0 }
        }, { _id: false }),
        default: () => new Map()
    },

    archivedBy: [{ type: mongoose.Schema.Types.ObjectId }],
    pinnedBy:   [{ type: mongoose.Schema.Types.ObjectId }],

    priority: {
        type: String,
        enum: ['normal', 'urgent'],
        default: 'normal'
    },

    autoArchive: {
        pending:     { type: Boolean, default: false },
        scheduledAt: { type: Date }
    },

    participantMeta: [{
        userId:      { type: mongoose.Schema.Types.ObjectId, required: true },
        displayName: { type: String, default: '' }
    }],

    admin: {
        flagged:     { type: Boolean, default: false },
        flaggedAt:   { type: Date },
        suspended:   { type: Boolean, default: false },
        suspendedAt: { type: Date }
    },

    createdAt: { type: Date, default: Date.now }
});

ThreadSchema.index({ participants: 1, lastAt: -1 });
ThreadSchema.index({ participants: 1, 'context.type': 1, 'context.refId': 1 });
ThreadSchema.index({ participants: 1, priority: -1, lastAt: -1 });
ThreadSchema.index({ 'autoArchive.pending': 1, 'autoArchive.scheduledAt': 1 });
ThreadSchema.index({ 'admin.flagged': 1 });

module.exports = ThreadSchema;
