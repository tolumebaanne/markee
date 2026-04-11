module.exports = function typingHandler(socket, io, services) {
    const userId = socket.user.sub;

    socket.on('typing_start', (data) => {
        if (!data?.recipientId || !data?.threadId) return;
        io.to(data.recipientId).emit('typing_start', {
            senderId: userId,
            threadId: data.threadId
        });
    });

    socket.on('typing_stop', (data) => {
        if (!data?.recipientId || !data?.threadId) return;
        io.to(data.recipientId).emit('typing_stop', {
            senderId: userId,
            threadId: data.threadId
        });
    });
};
