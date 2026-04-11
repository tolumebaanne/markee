module.exports = function registerUserEvents(bus, services) {
    const { Thread, Message, Template, mongoose, logger } = services;

    // user.deleted — anonymize order threads, delete non-order threads
    bus.on('user.deleted', async (payload) => {
        try {
            const { userId } = payload;
            if (!userId) return;
            const userOid = new mongoose.Types.ObjectId(userId.toString());

            // Order context threads: anonymize messages
            const orderThreads = await Thread.find({
                participants: userOid,
                'context.type': 'order'
            });
            for (const thread of orderThreads) {
                await Message.updateMany(
                    { threadId: thread._id, senderId: userOid },
                    { $set: { senderId: null, 'deletion.senderAnonymized': true } }
                );
            }

            // Non-order threads: delete messages + threads
            const nonOrderThreads = await Thread.find({
                participants: userOid,
                'context.type': { $ne: 'order' }
            });
            const nonOrderIds = nonOrderThreads.map(t => t._id);
            if (nonOrderIds.length > 0) {
                await Message.deleteMany({ threadId: { $in: nonOrderIds } });
                await Thread.deleteMany({ _id: { $in: nonOrderIds } });
            }

            // Clean up user from all remaining thread fields
            await Thread.updateMany(
                { participants: userOid },
                {
                    $pull: {
                        participants:    userOid,
                        pinnedBy:        userOid,
                        archivedBy:      userOid,
                        participantMeta: { userId: userOid }
                    },
                    $unset: {
                        [`readCursors.${userId}`]: ''
                    }
                }
            );

            // Delete templates
            if (Template) {
                await Template.deleteMany({ sellerId: userOid });
            }
        } catch (err) {
            logger.error('user.deleted handler error:', err.message);
        }
    });

    // user.profile_updated — sync displayName in participantMeta
    bus.on('user.profile_updated', async (payload) => {
        try {
            const { userId, displayName } = payload;
            if (!userId || !displayName) return;
            const userOid = new mongoose.Types.ObjectId(userId.toString());
            await Thread.updateMany(
                { 'participantMeta.userId': userOid },
                { $set: { 'participantMeta.$[elem].displayName': displayName } },
                { arrayFilters: [{ 'elem.userId': userOid }] }
            );
        } catch (err) {
            logger.error('user.profile_updated handler error:', err.message);
        }
    });
};
