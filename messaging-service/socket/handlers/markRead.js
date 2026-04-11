module.exports = function markReadHandler(socket, io, services) {
    const { threadService, unreadService, logger, Thread } = services;
    const userId = socket.user.sub;

    socket.on('mark_read', async (data) => {
        if (!data?.threadId) return;
        try {
            const thread = await Thread.findById(data.threadId);
            if (!thread || !thread.participants.some(p => p.toString() === userId)) return;

            await threadService.markRead(data.threadId, userId);

            // Update sender's unread badge
            const total = await unreadService.getTotalUnread(userId);
            socket.emit('unread_count_update', { total });

            // Notify other participant that messages were read
            const otherId = thread.participants.map(p => p.toString()).find(p => p !== userId);
            if (otherId) {
                io.to(otherId).emit('messages_read', {
                    threadId: data.threadId,
                    readBy:   userId,
                    readAt:   new Date()
                });
            }
        } catch (err) {
            logger.error('mark_read error:', err.message);
        }
    });
};
