const { Server } = require('socket.io');
const socketAuth = require('./middleware/auth');
const banCheck   = require('./middleware/banCheck');
const sendMessageHandler = require('./handlers/sendMessage');
const markReadHandler    = require('./handlers/markRead');
const typingHandler      = require('./handlers/typing');
const joinThreadHandler  = require('./handlers/joinThread');

function setupSocket(server, services) {
    const io = new Server(server, {
        cors: { origin: '*', methods: ['GET', 'POST'] },
        transports: ['polling', 'websocket']
    });

    // Middleware chain
    io.use(socketAuth);
    io.use(banCheck(services.MessagingBan));

    io.on('connection', (socket) => {
        const userId = socket.user.sub;
        services.logger.info(`Socket connected: ${userId}`);

        // Join personal room for direct delivery
        socket.join(userId);
        services.presenceService.setOnline(userId);

        // Register handlers
        sendMessageHandler(socket, io, services);
        markReadHandler(socket, io, services);
        typingHandler(socket, io, services);
        joinThreadHandler(socket, io, services);

        socket.on('disconnect', () => {
            services.presenceService.setOffline(userId);
            services.logger.info(`Socket disconnected: ${userId}`);
        });
    });

    return io;
}

module.exports = setupSocket;
