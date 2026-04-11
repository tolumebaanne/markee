function createUnreadService({ Thread, mongoose, logger }) {
    return {
        async getTotalUnread(userId) {
            try {
                const userOid = new mongoose.Types.ObjectId(userId);
                const key = `readCursors.${userId}.unreadCount`;
                const result = await Thread.aggregate([
                    { $match: { participants: userOid, archivedBy: { $ne: userOid } } },
                    { $group: { _id: null, total: { $sum: `$${key}` } } }
                ]);
                return result[0]?.total || 0;
            } catch (err) {
                logger.error('getTotalUnread failed:', err.message);
                return 0;
            }
        }
    };
}

module.exports = createUnreadService;
