const { AppError } = require('../utils/errors');

const ALLOWED_EMOJIS = ['👍', '❤️', '😮'];

function createMessageService({ Message, Thread, mongoose, logger }) {
    return {
        async create(data) {
            const { threadId, senderId, recipientId, type, body, attachment } = data;
            const msg = new Message({
                threadId:    new mongoose.Types.ObjectId(threadId.toString()),
                senderId:    senderId ? new mongoose.Types.ObjectId(senderId.toString()) : null,
                recipientId: new mongoose.Types.ObjectId(recipientId.toString()),
                type:        type || 'text',
                body:        body || '',
                attachment:  attachment || undefined
            });
            await msg.save();
            return msg;
        },

        async edit(messageId, userId, newBody) {
            const msg = await Message.findById(messageId);
            if (!msg) throw new AppError('Message not found', 404);
            if (msg.senderId?.toString() !== userId.toString()) throw new AppError('Forbidden', 403);
            if (msg.type === 'system') throw new AppError('Cannot edit system messages', 403);

            const ageMs = Date.now() - new Date(msg.createdAt).getTime();
            if (ageMs > 300000) throw new AppError('Edit window expired (5 minutes)', 409);

            msg.edit.originalBody = msg.edit.originalBody || msg.body;
            msg.edit.edited    = true;
            msg.edit.editedAt  = new Date();
            msg.body           = newBody;
            await msg.save();
            return msg;
        },

        async softDelete(messageId, userId, isAdmin) {
            const msg = await Message.findById(messageId);
            if (!msg) throw new AppError('Message not found', 404);
            if (!isAdmin && msg.senderId?.toString() !== userId.toString()) {
                throw new AppError('Forbidden', 403);
            }
            msg.deletion.deleted   = true;
            msg.deletion.deletedAt = new Date();
            await msg.save();
            return msg;
        },

        async hardDelete(messageId) {
            await Message.deleteOne({ _id: messageId });
            return { ok: true };
        },

        async addReaction(messageId, userId, emoji) {
            if (!ALLOWED_EMOJIS.includes(emoji)) {
                throw new AppError('Emoji not allowed', 400);
            }
            const msg = await Message.findById(messageId);
            if (!msg) throw new AppError('Message not found', 404);

            const existing = msg.reactions.find(r => r.userId.toString() === userId.toString());
            if (existing) {
                if (existing.emoji === emoji) {
                    // Toggle off
                    msg.reactions = msg.reactions.filter(r => r.userId.toString() !== userId.toString());
                } else {
                    // Replace
                    existing.emoji = emoji;
                }
            } else {
                msg.reactions.push({ userId: new mongoose.Types.ObjectId(userId.toString()), emoji });
            }
            await msg.save();
            return msg.reactions;
        },

        async anonymizeForUser(userId, threadContextType) {
            if (threadContextType === 'order') {
                await Message.updateMany(
                    { senderId: new mongoose.Types.ObjectId(userId.toString()) },
                    { $set: { senderId: null, 'deletion.senderAnonymized': true } }
                );
            } else {
                const threads = await Thread.find({
                    participants: new mongoose.Types.ObjectId(userId.toString())
                });
                const threadIds = threads.map(t => t._id);
                await Message.deleteMany({ threadId: { $in: threadIds } });
                await Thread.deleteMany({ _id: { $in: threadIds } });
            }
        },

        async getById(messageId) {
            return Message.findById(messageId);
        }
    };
}

module.exports = createMessageService;
