function banCheck(MessagingBan) {
    return async function (socket, next) {
        try {
            const ban = await MessagingBan.findOne({ userId: socket.user.sub });
            if (ban) {
                if (ban.type === 'temporary' && ban.expiresAt && ban.expiresAt < new Date()) {
                    await MessagingBan.deleteOne({ userId: socket.user.sub });
                    return next();
                }
                return next(new Error('You are banned from messaging'));
            }
            next();
        } catch (err) {
            next(new Error('Auth check failed'));
        }
    };
}

module.exports = banCheck;
