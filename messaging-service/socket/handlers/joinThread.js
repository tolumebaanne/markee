module.exports = function joinThreadHandler(socket, io, services) {
    socket.on('join_thread', (data) => {
        if (!data?.threadId) return;
        socket.join(`thread:${data.threadId}`);
    });
};
