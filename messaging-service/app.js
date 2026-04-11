require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express    = require('express');
const mongoose   = require('mongoose');
const cors       = require('cors');
const http       = require('http');
const path       = require('path');
const fs         = require('fs');

const errorResponse = require('../shared/utils/errorResponse');
const parseUser     = require('../shared/middleware/parseUser');
const platformGuard = require('../shared/middleware/platformGuard');
const bus           = require('../shared/eventBus');
const logger        = require('./utils/logger');

// ── Capture PORT synchronously (monolith overwrites process.env.PORT later) ──
const MSG_PORT = process.env.PORT || 5009;

// ── Schemas ──────────────────────────────────────────────────────────────────
const ThreadSchema       = require('./models/Thread');
const MessageSchema      = require('./models/Message');
const TemplateSchema     = require('./models/Template');
const MessagingBanSchema = require('./models/MessagingBan');

// ── Socket + Events ──────────────────────────────────────────────────────────
const setupSocket    = require('./socket/index');
const registerEvents = require('./events/index');

// ── Route factories ──────────────────────────────────────────────────────────
const threadRoutes   = require('./routes/threads');
const messageRoutes  = require('./routes/messages');
const uploadRoutes   = require('./routes/upload');
const presenceRoutes = require('./routes/presence');
const templateRoutes = require('./routes/templates');
const adminRoutes    = require('./routes/admin');

// ── Middleware ───────────────────────────────────────────────────────────────
const requireAuth  = require('./middleware/requireAuth');
const createRateLimiter = require('./socket/middleware/rateLimit');

// ── Service constructors ─────────────────────────────────────────────────────
const IdentityService     = require('./services/identityService');
const createThreadService = require('./services/threadService');
const createMessageService = require('./services/messageService');
const PresenceService     = require('./services/presenceService');
const createUnreadService = require('./services/unreadService');
const imageService        = require('./services/imageService');

async function start() {
    // 0. Validate required env vars — log and bail (no process.exit in monolith)
    if (!process.env.MONGODB_URI) {
        logger.error('MONGODB_URI is required. Messaging service will not start.');
        return;
    }
    if (!process.env.JWT_SECRET) {
        logger.error('JWT_SECRET is required. Messaging service will not start.');
        return;
    }

    // 1. Connect to MongoDB via createConnection (not default connection)
    const db = await mongoose.createConnection(process.env.MONGODB_URI).asPromise();
    logger.info('MongoDB connected');

    // 2. Register models on this connection
    const Thread       = db.model('Thread',       ThreadSchema);
    const Message      = db.model('Message',      MessageSchema);
    const Template     = db.model('Template',     TemplateSchema);
    const MessagingBan = db.model('MessagingBan', MessagingBanSchema);

    // 3. Create service instances
    const identityService = new IdentityService(bus);
    const presenceService = new PresenceService(logger);
    const rateLimiter     = createRateLimiter();

    const threadService  = createThreadService({ Thread, Message, mongoose, logger });
    const messageService = createMessageService({ Message, Thread, mongoose, logger });
    const unreadService  = createUnreadService({ Thread, mongoose, logger });

    // 4. Warm identity cache — blocks until ready (tolerant of seller-service being down)
    await identityService.warmup(5000);

    // 5. Build services bag (passed everywhere)
    const services = {
        Thread, Message, Template, MessagingBan,
        identityService, threadService, messageService,
        presenceService, unreadService, imageService,
        rateLimiter, logger, bus,
        mongoose
    };

    // 6. Express app + middleware
    const app = express();
    app.use(cors());
    app.use(express.json({ limit: '10mb' }));
    app.use(parseUser);
    app.use(platformGuard);

    // 7. Uploads directory + static serving
    const uploadsDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
    app.use('/uploads', express.static(uploadsDir));

    // 8. Mount routes (factory pattern — each route file receives services)
    app.use('/', requireAuth, threadRoutes(services));
    app.use('/', requireAuth, messageRoutes(services));
    app.use('/', requireAuth, uploadRoutes(services));
    app.use('/', requireAuth, presenceRoutes(services));
    app.use('/', requireAuth, templateRoutes(services));
    app.use('/', adminRoutes(services));   // admin routes have their own auth check

    // 9. Health check
    app.get('/health', (req, res) => res.json({
        service: 'messaging-service',
        status:  'ok',
        dbState: db.readyState
    }));

    // 10. HTTP server
    const server = http.createServer(app);

    // 11. Socket.io
    const io = setupSocket(server, services);

    // Inject io into services so event handlers can emit to sockets
    services.io = io;

    // 12. Register event bus listeners
    registerEvents(bus, services, io);

    // 13. Auto-archive sweep — every 24 hours
    async function autoArchiveSweep() {
        try {
            const now = new Date();
            const candidates = await Thread.find({
                'autoArchive.pending':     true,
                'autoArchive.scheduledAt': { $lte: now }
            });

            for (const thread of candidates) {
                const newMessages = await Message.countDocuments({
                    threadId:  thread._id,
                    createdAt: { $gt: thread.autoArchive.scheduledAt }
                });

                if (newMessages === 0) {
                    // Archive for all participants
                    await Thread.updateOne(
                        { _id: thread._id },
                        {
                            $addToSet: { archivedBy: { $each: thread.participants } },
                            $set:      { 'autoArchive.pending': false }
                        }
                    );
                    logger.info(`Auto-archived thread ${thread._id}`);
                } else {
                    // New messages since scheduled — cancel auto-archive
                    await Thread.updateOne(
                        { _id: thread._id },
                        { $set: { 'autoArchive.pending': false, 'autoArchive.scheduledAt': undefined } }
                    );
                }
            }
        } catch (err) {
            logger.error('Auto-archive sweep error:', err.message);
        }
    }

    setInterval(autoArchiveSweep, 24 * 60 * 60 * 1000);

    // 14. Listen (use MSG_PORT captured at module load, not process.env.PORT which monolith overwrites)
    server.listen(MSG_PORT, () => {
        logger.info(`Messaging service v2 listening on port ${MSG_PORT}`);
    });

    return { app, server, io };
}

start().catch(err => {
    logger.error('Startup error:', err.message);
    logger.error('Messaging service failed to start. Other services unaffected.');
});
