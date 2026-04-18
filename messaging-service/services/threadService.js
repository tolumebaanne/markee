const { AppError } = require('../utils/errors');

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createThreadService({ Thread, Message, mongoose, logger }) {
    return {
        async findOrCreate(participantA, participantB, context, metaA, metaB) {
            const sorted = [participantA.toString(), participantB.toString()].sort();
            const [p1, p2] = sorted.map(id => new mongoose.Types.ObjectId(id));

            const ctxType  = (context && context.type)     || 'general';
            const ctxRefId = (context && context.refId)    || null;
            const ctxTitle = (context && context.refTitle) || '';
            const ctxImage = (context && context.refImage) || '';

            const displayA = sorted[0] === participantA.toString() ? (metaA || '') : (metaB || '');
            const displayB = sorted[0] === participantA.toString() ? (metaB || '') : (metaA || '');

            // First try to find existing thread
            const filter = {
                participants: { $all: [p1, p2] },
                'context.type': ctxType,
                ...(ctxRefId ? { 'context.refId': new mongoose.Types.ObjectId(ctxRefId.toString()) } : {})
            };

            let thread = await Thread.findOne(filter);
            if (!thread) {
                thread = await Thread.create({
                    participants: [p1, p2],
                    context: {
                        type:     ctxType,
                        refId:    ctxRefId ? new mongoose.Types.ObjectId(ctxRefId.toString()) : undefined,
                        refTitle: ctxTitle,
                        refImage: ctxImage
                    },
                    participantMeta: [
                        { userId: p1, displayName: displayA },
                        { userId: p2, displayName: displayB }
                    ]
                });
            }
            return thread;
        },

        async listThreads(userId, { archived = false, page = 1, limit = 20 } = {}) {
            const userOid = new mongoose.Types.ObjectId(userId);
            const query = { participants: userOid };
            if (archived) {
                query.archivedBy = userOid;
            } else {
                query.archivedBy = { $ne: userOid };
            }

            const skip = (page - 1) * limit;
            const [threads, total] = await Promise.all([
                Thread.find(query)
                    .sort({ pinnedBy: -1, priority: -1, lastAt: -1 })
                    .skip(skip)
                    .limit(limit)
                    .lean(),
                Thread.countDocuments(query)
            ]);

            return { threads, total, page };
        },

        async getThread(threadId, userId) {
            const thread = await Thread.findById(threadId);
            if (!thread) throw new AppError('Thread not found', 404);
            const isParticipant = thread.participants.some(p => p.toString() === userId.toString());
            if (!isParticipant) throw new AppError('Forbidden', 403);
            return thread;
        },

        async getMessages(threadId, { limit = 30, before } = {}) {
            const query = { threadId: new mongoose.Types.ObjectId(threadId.toString()) };
            if (before) query.createdAt = { $lt: new Date(before) };

            const messages = await Message.find(query)
                .sort({ createdAt: -1 })
                .limit(limit + 1);

            const hasMore = messages.length > limit;
            if (hasMore) messages.pop();
            return { messages: messages.reverse(), hasMore };
        },

        async getMessagesSince(threadId, timestamp) {
            return Message.find({
                threadId: new mongoose.Types.ObjectId(threadId.toString()),
                createdAt: { $gt: new Date(timestamp) }
            }).sort({ createdAt: 1 });
        },

        async markRead(threadId, userId) {
            const key = `readCursors.${userId}`;
            return Thread.findByIdAndUpdate(
                threadId,
                { $set: { [`${key}.lastReadAt`]: new Date(), [`${key}.unreadCount`]: 0 } },
                { returnDocument: 'after' }
            );
        },

        async searchMessages(threadId, query, limit = 20) {
            const escaped = escapeRegex(query);
            return Message.find({
                threadId: new mongoose.Types.ObjectId(threadId.toString()),
                body: { $regex: escaped, $options: 'i' },
                'deletion.deleted': { $ne: true }
            }).limit(limit).sort({ createdAt: -1 });
        },

        async exportThread(threadId) {
            const [thread, messages] = await Promise.all([
                Thread.findById(threadId),
                Message.find({ threadId: new mongoose.Types.ObjectId(threadId.toString()) }).sort({ createdAt: 1 })
            ]);
            return { thread, messages };
        },

        async archiveThread(threadId, userId) {
            const userOid = new mongoose.Types.ObjectId(userId.toString());
            const thread = await Thread.findById(threadId);
            if (!thread) throw new AppError('Thread not found', 404);

            const isArchived = thread.archivedBy.some(id => id.toString() === userId.toString());
            if (isArchived) {
                await Thread.updateOne({ _id: threadId }, { $pull: { archivedBy: userOid } });
                return { archived: false };
            } else {
                await Thread.updateOne({ _id: threadId }, { $addToSet: { archivedBy: userOid } });
                return { archived: true };
            }
        },

        async pinThread(threadId, userId) {
            const userOid = new mongoose.Types.ObjectId(userId.toString());
            const thread = await Thread.findById(threadId);
            if (!thread) throw new AppError('Thread not found', 404);

            const isPinned = thread.pinnedBy.some(id => id.toString() === userId.toString());
            if (isPinned) {
                await Thread.updateOne({ _id: threadId }, { $pull: { pinnedBy: userOid } });
                return { pinned: false };
            } else {
                const pinnedCount = await Thread.countDocuments({ pinnedBy: userOid });
                if (pinnedCount >= 5) throw new AppError('Maximum 5 pinned threads', 409);
                await Thread.updateOne({ _id: threadId }, { $addToSet: { pinnedBy: userOid } });
                return { pinned: true };
            }
        },

        async incrementUnread(threadId, recipientId, preview, messageType, lastAt) {
            const key = `readCursors.${recipientId}.unreadCount`;
            return Thread.findByIdAndUpdate(
                threadId,
                {
                    $inc: { [key]: 1, messageCount: 1 },
                    $set: {
                        lastMessage:     preview || '',
                        lastMessageType: messageType || 'text',
                        lastAt:          lastAt || new Date()
                    }
                },
                { returnDocument: 'after' }
            );
        },

        async findThreadByContext(participantA, participantB, contextType, refId) {
            const sorted = [participantA.toString(), participantB.toString()].sort();
            const [p1, p2] = sorted.map(id => new mongoose.Types.ObjectId(id));
            return Thread.findOne({
                participants: { $all: [p1, p2], $size: 2 },
                'context.type': contextType,
                'context.refId': new mongoose.Types.ObjectId(refId.toString())
            });
        }
    };
}

module.exports = createThreadService;
