require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express  = require('express');
const mongoose = require('mongoose');
const cors     = require('cors');
const http     = require('http');
const crypto   = require('crypto');
const path     = require('path');
const fs       = require('fs');
const { Server }  = require('socket.io');
const jwt         = require('jsonwebtoken');
const multer      = require('multer');
const sharp       = require('sharp');
const { v4: uuidv4 } = require('uuid');
const errorResponse = require('../shared/utils/errorResponse');
const parseUser     = require('../shared/middleware/parseUser');
const platformGuard = require('../shared/middleware/platformGuard');
const bus           = require('../shared/eventBus');

const app = express();
app.use(express.json());
app.use(cors());
app.use(parseUser);
app.use(platformGuard);

// ── Uploads directory ────────────────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOADS_DIR));

if (!process.env.MONGODB_URI) { console.error('[MSG] MONGODB_URI not set'); process.exit(1); }

const db = mongoose.createConnection(process.env.MONGODB_URI);
db.on('connected', () => console.log('Messaging DB Connected'));
db.on('error',     (err) => console.error('[MSG] DB error:', err.message));

// ── Schemas ──────────────────────────────────────────────────────────────────

const ThreadSchema = new mongoose.Schema({
    _id: { type: String },   // deterministic hash IS the threadId

    participants: [{ type: mongoose.Schema.Types.ObjectId, required: true }],

    context: {
        type:     { type: String, enum: ['product', 'order', 'general'], default: 'general' },
        refId:    { type: mongoose.Schema.Types.ObjectId },
        refTitle: { type: String, default: '' },
        refImage: { type: String, default: '' }
    },

    // Denormalized for fast thread list
    lastMessage:     { type: String,  default: '' },
    lastMessageType: { type: String,  default: 'text' },
    lastAt:          { type: Date,    default: Date.now },
    messageCount:    { type: Number,  default: 0 },

    // Per-participant unread tracking
    lastReadAt:    { type: Map, of: Date,   default: {} },
    unreadCounts:  { type: Map, of: Number, default: {} },

    // Inbox management
    archivedBy: [{ type: mongoose.Schema.Types.ObjectId }],
    pinnedBy:   [{ type: mongoose.Schema.Types.ObjectId }],

    // Priority — system-set on dispute/refund events
    priority: { type: String, enum: ['normal', 'urgent'], default: 'normal' },

    // Auto-archive machinery (C12)
    pendingAutoArchive:   { type: Boolean, default: false },
    pendingAutoArchiveAt: { type: Date },

    // Participant display name snapshot (C19)
    participantMeta: [{
        userId:      { type: mongoose.Schema.Types.ObjectId },
        displayName: { type: String, default: '' }
    }],

    createdAt: { type: Date, default: Date.now }
});

ThreadSchema.index({ participants: 1, lastAt: -1 });
ThreadSchema.index({ participants: 1, 'context.type': 1 });
ThreadSchema.index({ participants: 1, priority: -1, lastAt: -1 });
ThreadSchema.index({ pendingAutoArchive: 1, pendingAutoArchiveAt: 1 });
ThreadSchema.index({ 'context.type': 1, 'context.refId': 1 });

const Thread = db.model('Thread', ThreadSchema);

const MessageSchema = new mongoose.Schema({
    threadId:    { type: String, required: true, index: true },
    senderId:    { type: mongoose.Schema.Types.ObjectId },   // null for system messages
    recipientId: { type: mongoose.Schema.Types.ObjectId },

    type:          { type: String, enum: ['text', 'system', 'product_card', 'order_ref', 'attachment'], default: 'text' },
    body:          { type: String, default: '' },
    attachmentUrl: { type: String, default: '' },
    attachmentType:{ type: String, default: '' },

    // Delivery and read state (C15)
    deliveredAt: { type: Date },
    readAt:      { type: Date },

    // Edit and soft-delete (R11, R12)
    deleted:      { type: Boolean, default: false },
    deletedAt:    { type: Date },
    edited:       { type: Boolean, default: false },
    editedAt:     { type: Date },
    originalBody: { type: String },

    // Reactions (C4)
    reactions: [{ userId: mongoose.Schema.Types.ObjectId, emoji: String }],

    // Set when sender is anonymized on hard-delete — senderId becomes null
    _senderDeleted: { type: Boolean, default: false },

    createdAt: { type: Date, default: Date.now }
});

MessageSchema.index({ threadId: 1, createdAt: 1 });
MessageSchema.index({ threadId: 1, createdAt: -1 });
MessageSchema.index({ threadId: 1, type: 1 });

const Message = db.model('Message', MessageSchema);

const TemplateSchema = new mongoose.Schema({
    sellerId:  { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    label:     { type: String, required: true },
    body:      { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
});

const Template = db.model('Template', TemplateSchema);

// ── Context-aware threadId (R2) ───────────────────────────────────────────────
// General threads: SHA-256(sorted userIds) — backward compatible
// Product/Order threads: SHA-256(sorted userIds + contextType + refId)
function makeThreadId(userIdA, userIdB, contextType = 'general', refId = '') {
    const sorted = [userIdA.toString(), userIdB.toString()].sort();
    const key = contextType === 'general'
        ? sorted.join(':')
        : sorted.join(':') + ':' + contextType + ':' + refId.toString();
    return crypto.createHash('sha256').update(key).digest('hex');
}

// ── Starter suggestions (C17) ─────────────────────────────────────────────────
const STARTER_SUGGESTIONS = {
    product: [
        'Is this available in a different size?',
        'What is the shipping time?',
        'Do you offer bulk pricing?'
    ],
    order: [
        'I have a question about my order.',
        'Can I modify my order?',
        'I\'d like to request a return.'
    ],
    general: []
};

// ── Rate limiter (R7) ─────────────────────────────────────────────────────────
const rateLimitMap = new Map();  // userId → { count, windowStart }
const RATE_MAX    = 20;
const RATE_WINDOW = 60 * 1000;

function checkRateLimit(userId) {
    const now   = Date.now();
    const entry = rateLimitMap.get(userId);
    if (!entry || now - entry.windowStart > RATE_WINDOW) {
        rateLimitMap.set(userId, { count: 1, windowStart: now });
        return true;
    }
    if (entry.count >= RATE_MAX) return false;
    entry.count++;
    return true;
}

// ── Presence map (C3) ─────────────────────────────────────────────────────────
const presenceMap = new Map();  // userId → { online, lastSeenAt }

// ── WebSocket ─────────────────────────────────────────────────────────────────
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Auth error: no token'));
    jwt.verify(token, process.env.JWT_SECRET || 'fallback-secret', (err, decoded) => {
        if (err) return next(new Error('Auth error: invalid token'));
        socket.user = decoded;
        next();
    });
});

io.on('connection', (socket) => {
    const userId = socket.user.sub;
    socket.join(userId);   // userId room for direct delivery

    // Update presence
    presenceMap.set(userId, { online: true, lastSeenAt: new Date() });

    // Client joins threadId room when opening a thread (for reactions/edits/deletes)
    socket.on('join_thread', (threadId) => {
        if (threadId) socket.join(`thread:${threadId}`);
    });

    // ── send_message ──────────────────────────────────────────────────────────
    socket.on('send_message', async (data) => {
        try {
            // Rate limit (R7)
            if (!checkRateLimit(userId)) {
                socket.emit('rate_limited', { error: 'Too many messages. Slow down.' });
                return;
            }

            const {
                recipientId, body, contextType, refId,
                refTitle = '', refImage = '',
                attachmentUrl = '', attachmentType = ''
            } = data;

            if (!recipientId) {
                socket.emit('message_error', { error: 'recipientId required' });
                return;
            }
            if (!body && !attachmentUrl) {
                socket.emit('message_error', { error: 'body or attachment required' });
                return;
            }

            const threadId = makeThreadId(userId, recipientId, contextType, refId);

            // Upsert Thread — context only set on first creation (S5/S6)
            let thread = await Thread.findById(threadId);
            if (!thread) {
                thread = await Thread.create({
                    _id: threadId,
                    participants: [userId, recipientId],
                    context: {
                        type:     contextType || 'general',
                        refId:    refId || undefined,
                        refTitle: refTitle,
                        refImage: refImage
                    },
                    participantMeta: [
                        { userId: userId,      displayName: socket.user.displayName || '' },
                        { userId: recipientId, displayName: '' }
                    ]
                });
            }

            const msg = await Message.create({
                threadId,
                senderId:      userId,
                recipientId,
                type:          'text',
                body:          body || '',
                attachmentUrl: attachmentUrl,
                attachmentType:attachmentType
            });

            // Thread denormalization (S6/R6)
            const preview = (body || attachmentUrl || '').slice(0, 80);
            const currentRecipientUnread = Number(
                thread.unreadCounts?.get?.(recipientId.toString()) ||
                thread.unreadCounts?.[recipientId.toString()] || 0
            );
            await Thread.updateOne(
                { _id: threadId },
                {
                    $set: { lastMessage: preview, lastMessageType: 'text', lastAt: msg.createdAt },
                    $inc: { messageCount: 1, [`unreadCounts.${recipientId}`]: 1 }
                }
            );

            // Delivery receipts (C15 / S11)
            const recipientRoom  = io.sockets.adapter.rooms.get(recipientId.toString());
            const recipientOnline = recipientRoom && recipientRoom.size > 0;

            if (recipientOnline) {
                const msgObj = msg.toObject();
                msgObj.deliveredAt = new Date();
                await Message.updateOne({ _id: msg._id }, { $set: { deliveredAt: msgObj.deliveredAt } });
                // socket.to() excludes the emitting socket (sender)
                socket.to(recipientId.toString()).emit('new_message', msgObj);
                socket.emit('message_delivered', { messageId: msg._id, deliveredAt: msgObj.deliveredAt });
                socket.emit('message_sent', msgObj);
                // Multi-tab: notify any other sender tabs; exclude recipient (already notified above)
                socket.to(`thread:${threadId}`).except(recipientId.toString()).emit('new_message', msgObj);
            } else {
                socket.to(recipientId.toString()).emit('new_message', msg);
                socket.emit('message_sent', msg);
                // Notify offline recipient via bus (C8 / S24)
                bus.emit('message.unread', {
                    recipientId: recipientId.toString(),
                    senderId:    userId,
                    senderName:  socket.user.displayName || '',
                    threadId,
                    preview
                });
                // Multi-tab: recipient offline so no duplicate risk
                socket.to(`thread:${threadId}`).emit('new_message', msg);
            }

            // Seller response time analytics (C9 / S25)
            try {
                const isSenderSeller = socket.user.storeActive === true || socket.user.role === 'seller';
                if (isSenderSeller) {
                    const freshThread = await Thread.findById(threadId);
                    if (freshThread && freshThread.messageCount === 2) {
                        const firstMsg = await Message.findOne({ threadId, type: 'text' }).sort({ createdAt: 1 });
                        if (firstMsg && firstMsg.senderId?.toString() !== userId) {
                            const responseTimeMs = new Date(msg.createdAt) - new Date(firstMsg.createdAt);
                            bus.emit('message.seller_response', {
                                sellerId:       userId,
                                threadId,
                                responseTimeMs,
                                contextType:    freshThread.context?.type || 'general'
                            });
                        }
                    }
                }
            } catch (_) { /* analytics never blocks delivery */ }

        } catch (err) {
            socket.emit('message_error', { error: err.message });
        }
    });

    // ── Typing indicators (C1 / S9) ───────────────────────────────────────────
    socket.on('typing_start', (data) => {
        if (data?.recipientId) {
            io.to(data.recipientId.toString()).emit('typing_start', {
                senderId: userId,
                threadId: data.threadId
            });
        }
    });

    socket.on('typing_stop', (data) => {
        if (data?.recipientId) {
            io.to(data.recipientId.toString()).emit('typing_stop', {
                senderId: userId,
                threadId: data.threadId
            });
        }
    });

    // ── Socket mark_read (R9 alt) ─────────────────────────────────────────────
    socket.on('mark_read', async (data) => {
        if (!data?.threadId) return;
        try {
            const thread = await Thread.findById(data.threadId);
            if (!thread || !thread.participants.some(p => p.toString() === userId)) return;
            await Thread.updateOne(
                { _id: data.threadId },
                {
                    $set: {
                        [`lastReadAt.${userId}`]:   new Date(),
                        [`unreadCounts.${userId}`]: 0
                    }
                }
            );
            const total = await getTotalUnread(userId);
            socket.emit('unread_count_update', { total });
        } catch (_) { /* ignore */ }
    });

    socket.on('disconnect', () => {
        presenceMap.set(userId, { online: false, lastSeenAt: new Date() });
    });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getTotalUnread(userId) {
    try {
        const threads = await Thread.find({
            participants: new mongoose.Types.ObjectId(userId),
            archivedBy:   { $ne: new mongoose.Types.ObjectId(userId) }
        });
        let total = 0;
        for (const t of threads) {
            const count = Number(
                t.unreadCounts?.get?.(userId.toString()) ||
                t.unreadCounts?.[userId.toString()] || 0
            );
            total += count;
        }
        return total;
    } catch { return 0; }
}

async function injectSystemMessage(threadId, body, participantIds) {
    try {
        const msg = await Message.create({ threadId, type: 'system', body });
        await Thread.updateOne(
            { _id: threadId },
            {
                $set: { lastMessage: body.slice(0, 80), lastMessageType: 'system', lastAt: msg.createdAt },
                $inc: { messageCount: 1 }
            }
        );
        for (const pId of participantIds) {
            io.to(pId.toString()).emit('system_message', msg);
        }
        io.to(`thread:${threadId}`).emit('system_message', msg);
    } catch (err) { console.error('[MSG] injectSystemMessage error:', err.message); }
}

// ── Image compression (C11 / S19) ────────────────────────────────────────────
async function compressToTarget(buffer, targetKb = 50) {
    const targetBytes = targetKb * 1024;
    let output;
    for (const [width, quality] of [[800, 80], [800, 60], [800, 40], [600, 40], [400, 35]]) {
        output = await sharp(buffer)
            .resize(width, width, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality })
            .toBuffer();
        if (output.length <= targetBytes) break;
    }
    if (output.length > targetBytes) throw new Error('Image cannot be compressed to target size');
    return output;
}

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (!file.mimetype.startsWith('image/')) {
            return cb(new Error('Only image files are allowed'));
        }
        cb(null, true);
    }
});

// POST /upload — image upload with compression (S19)
// Must be registered BEFORE parseUser because multer handles the body
app.post('/upload', (req, res, next) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    upload.single('image')(req, res, async (err) => {
        if (err?.code === 'LIMIT_FILE_SIZE') return errorResponse(res, 413, 'File exceeds 8MB limit');
        if (err) return errorResponse(res, 400, err.message || 'Upload error');
        if (!req.file) return errorResponse(res, 400, 'No file provided');
        try {
            const compressed = await compressToTarget(req.file.buffer);
            const filename   = `${uuidv4()}.jpg`;
            await fs.promises.writeFile(path.join(UPLOADS_DIR, filename), compressed);
            const sizeKb = Math.round(compressed.length / 1024);
            res.json({ url: `/api/messages/uploads/${filename}`, sizeKb });
        } catch (compressErr) {
            if (compressErr.message.includes('cannot be compressed')) {
                return errorResponse(res, 422, 'Image cannot be compressed to ≤50KB');
            }
            errorResponse(res, 500, compressErr.message);
        }
    });
});

// ── REST Routes ───────────────────────────────────────────────────────────────

// POST /thread — create or retrieve a thread with context (S5/S6)
app.post('/thread', async (req, res) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    const { recipientId, contextType = 'general', refId, refTitle = '', refImage = '' } = req.body;
    if (!recipientId) return errorResponse(res, 400, 'recipientId required');
    try {
        const userId   = req.user.sub;
        const threadId = makeThreadId(userId, recipientId, contextType, refId);

        const thread = await Thread.findOneAndUpdate(
            { _id: threadId },
            {
                $setOnInsert: {
                    _id:          threadId,
                    participants: [userId, recipientId],
                    context:      { type: contextType, refId: refId || undefined, refTitle, refImage },
                    participantMeta: [
                        { userId,      displayName: req.user.displayName || '' },
                        { userId: recipientId, displayName: '' }
                    ]
                }
            },
            { upsert: true, new: true }
        );

        const starterSuggestions = STARTER_SUGGESTIONS[contextType] || [];
        res.json({ threadId, thread, starterSuggestions });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// GET /threads — Thread collection query (S12 / R6)
app.get('/threads', async (req, res) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    try {
        const userId  = req.user.sub;
        const userOid = new mongoose.Types.ObjectId(userId);
        const archived = req.query.archived === 'true';
        const page  = Math.max(1, parseInt(req.query.page)  || 1);
        const limit = Math.min(50, parseInt(req.query.limit) || 20);
        const skip  = (page - 1) * limit;

        const query = { participants: userOid };
        if (archived) {
            query.archivedBy = userOid;
        } else {
            query.archivedBy = { $ne: userOid };
        }

        const [total, rawThreads] = await Promise.all([
            Thread.countDocuments(query),
            Thread.find(query).sort({ lastAt: -1 }).skip(skip).limit(limit)
        ]);

        // Sort: pinned → urgent → lastAt desc
        const pinned  = rawThreads.filter(t => t.pinnedBy?.some(p => p.toString() === userId));
        const urgent  = rawThreads.filter(t => !t.pinnedBy?.some(p => p.toString() === userId) && t.priority === 'urgent');
        const normal  = rawThreads.filter(t => !t.pinnedBy?.some(p => p.toString() === userId) && t.priority !== 'urgent');
        const sorted  = [...pinned, ...urgent, ...normal];

        const threads = sorted.map(t => ({
            threadId:        t._id,
            context:         t.context,
            lastMessage:     t.lastMessage,
            lastMessageType: t.lastMessageType,
            lastAt:          t.lastAt,
            unreadCount:     Number(t.unreadCounts?.get?.(userId) || t.unreadCounts?.[userId] || 0),
            priority:        t.priority,
            pinned:          t.pinnedBy?.some(p => p.toString() === userId) || false,
            archived:        t.archivedBy?.some(p => p.toString() === userId) || false,
            participantMeta: t.participantMeta,
            messageCount:    t.messageCount
        }));

        res.json({ threads, total, page });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// GET /thread/:threadId — idempotent, no auto read-marking (R9)
app.get('/thread/:threadId', async (req, res) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    try {
        const userId = req.user.sub;
        const thread = await Thread.findById(req.params.threadId);
        if (!thread) return errorResponse(res, 404, 'Thread not found');
        if (!thread.participants.some(p => p.toString() === userId)) {
            return errorResponse(res, 403, 'Not a participant in this thread');
        }

        const limit  = Math.min(100, parseInt(req.query.limit) || 50);
        const before = req.query.before ? new Date(req.query.before) : null;

        const msgQuery = { threadId: req.params.threadId };
        if (before) msgQuery.createdAt = { $lt: before };

        const messages = await Message.find(msgQuery)
            .sort({ createdAt: -1 })
            .limit(limit + 1);

        const hasMore = messages.length > limit;
        if (hasMore) messages.pop();
        messages.reverse();

        res.json({ thread, messages, hasMore });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// POST /thread/:threadId/read — explicit read cursor update (R9)
app.post('/thread/:threadId/read', async (req, res) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    try {
        const userId = req.user.sub;
        const thread = await Thread.findById(req.params.threadId);
        if (!thread) return errorResponse(res, 404, 'Thread not found');
        if (!thread.participants.some(p => p.toString() === userId)) {
            return errorResponse(res, 403, 'Not a participant');
        }
        await Thread.updateOne(
            { _id: req.params.threadId },
            {
                $set: {
                    [`lastReadAt.${userId}`]:   new Date(),
                    [`unreadCounts.${userId}`]: 0
                }
            }
        );
        const total = await getTotalUnread(userId);
        io.to(userId).emit('unread_count_update', { total });
        res.json({ ok: true });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// GET /thread/:threadId/since?timestamp= — reconnection recovery (R8)
app.get('/thread/:threadId/since', async (req, res) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    try {
        const userId = req.user.sub;
        const thread = await Thread.findById(req.params.threadId);
        if (!thread) return errorResponse(res, 404, 'Thread not found');
        if (!thread.participants.some(p => p.toString() === userId)) {
            return errorResponse(res, 403, 'Not a participant');
        }
        const since = req.query.timestamp ? new Date(req.query.timestamp) : new Date(0);
        const messages = await Message.find({
            threadId:  req.params.threadId,
            createdAt: { $gt: since }
        }).sort({ createdAt: 1 });
        res.json(messages);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// GET /thread/:threadId/admin — admin-only view (R10)
app.get('/thread/:threadId/admin', async (req, res) => {
    if (!req.user?.sub)          return errorResponse(res, 401, 'Unauthorized');
    if (req.user.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    try {
        const thread = await Thread.findById(req.params.threadId);
        if (!thread) return errorResponse(res, 404, 'Thread not found');
        const messages = await Message.find({ threadId: req.params.threadId }).sort({ createdAt: 1 });
        res.json({ thread, messages });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// GET /thread/:threadId/search?q= — regex search with context window (C6)
app.get('/thread/:threadId/search', async (req, res) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    try {
        const userId = req.user.sub;
        const thread = await Thread.findById(req.params.threadId);
        if (!thread) return errorResponse(res, 404, 'Thread not found');
        if (!thread.participants.some(p => p.toString() === userId)) {
            return errorResponse(res, 403, 'Not a participant');
        }
        const q = req.query.q;
        if (!q) return errorResponse(res, 400, 'Missing ?q= parameter');

        const matches = await Message.find({
            threadId: req.params.threadId,
            deleted:  { $ne: true },
            body:     { $regex: q, $options: 'i' }
        }).sort({ createdAt: 1 }).limit(20);

        const allMessages = await Message.find({ threadId: req.params.threadId }).sort({ createdAt: 1 });
        const results = matches.map(match => {
            const idx = allMessages.findIndex(m => m._id.toString() === match._id.toString());
            return {
                prev:  idx > 0 ? allMessages[idx - 1] : null,
                match: match,
                next:  idx < allMessages.length - 1 ? allMessages[idx + 1] : null
            };
        });

        res.json(results);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// GET /thread/:threadId/export — full thread dump (C10)
app.get('/thread/:threadId/export', async (req, res) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    try {
        const userId = req.user.sub;
        const thread = await Thread.findById(req.params.threadId);
        if (!thread) return errorResponse(res, 404, 'Thread not found');
        if (!thread.participants.some(p => p.toString() === userId)) {
            return errorResponse(res, 403, 'Not a participant');
        }
        const messages = await Message.find({ threadId: req.params.threadId }).sort({ createdAt: 1 });
        res.json({ thread, messages, exportedAt: new Date(), exportedBy: userId });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// POST /thread/:threadId/archive — toggle archive (C5)
app.post('/thread/:threadId/archive', async (req, res) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    try {
        const userId  = req.user.sub;
        const userOid = new mongoose.Types.ObjectId(userId);
        const thread  = await Thread.findById(req.params.threadId);
        if (!thread) return errorResponse(res, 404, 'Thread not found');
        if (!thread.participants.some(p => p.toString() === userId)) {
            return errorResponse(res, 403, 'Not a participant');
        }
        const isArchived = thread.archivedBy?.some(p => p.toString() === userId);
        if (isArchived) {
            await Thread.updateOne({ _id: req.params.threadId }, { $pull:     { archivedBy: userOid } });
        } else {
            await Thread.updateOne({ _id: req.params.threadId }, { $addToSet: { archivedBy: userOid } });
        }
        res.json({ archived: !isArchived });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// POST /thread/:threadId/pin — toggle pin, max 5 per user (C16)
app.post('/thread/:threadId/pin', async (req, res) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    try {
        const userId  = req.user.sub;
        const userOid = new mongoose.Types.ObjectId(userId);
        const thread  = await Thread.findById(req.params.threadId);
        if (!thread) return errorResponse(res, 404, 'Thread not found');
        if (!thread.participants.some(p => p.toString() === userId)) {
            return errorResponse(res, 403, 'Not a participant');
        }
        const isPinned = thread.pinnedBy?.some(p => p.toString() === userId);
        if (!isPinned) {
            const pinCount = await Thread.countDocuments({ participants: userOid, pinnedBy: userOid });
            if (pinCount >= 5) return errorResponse(res, 409, 'Maximum 5 pinned threads per user');
            await Thread.updateOne({ _id: req.params.threadId }, { $addToSet: { pinnedBy: userOid } });
        } else {
            await Thread.updateOne({ _id: req.params.threadId }, { $pull: { pinnedBy: userOid } });
        }
        res.json({ pinned: !isPinned });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// GET /unread-count — total unread for nav badge (C14)
app.get('/unread-count', async (req, res) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    try {
        const total = await getTotalUnread(req.user.sub);
        res.json({ total });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// GET /presence/:userId — online status (C3)
app.get('/presence/:userId', async (req, res) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    const entry = presenceMap.get(req.params.userId);
    res.json({
        userId:      req.params.userId,
        online:      entry?.online     || false,
        lastSeenAt:  entry?.lastSeenAt || null
    });
});

// GET /templates — seller quick-reply templates (C7)
app.get('/templates', async (req, res) => {
    if (!req.user?.sub)      return errorResponse(res, 401, 'Unauthorized');
    if (!req.user.storeId)   return errorResponse(res, 403, 'Sellers only');
    try {
        const templates = await Template.find({ sellerId: req.user.storeId }).sort({ createdAt: 1 });
        res.json({ templates });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// POST /templates — create template (C7, max 10)
app.post('/templates', async (req, res) => {
    if (!req.user?.sub)    return errorResponse(res, 401, 'Unauthorized');
    if (!req.user.storeId) return errorResponse(res, 403, 'Sellers only');
    try {
        const count = await Template.countDocuments({ sellerId: req.user.storeId });
        if (count >= 10) return errorResponse(res, 409, 'Maximum 10 templates per seller');
        const { label, body } = req.body;
        if (!label || !body) return errorResponse(res, 400, 'label and body required');
        const template = await Template.create({ sellerId: req.user.storeId, label, body });
        res.status(201).json(template);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// PUT /:id — edit message (R12, 5-minute window)
app.put('/:id', async (req, res) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    try {
        const msg = await Message.findById(req.params.id);
        if (!msg) return errorResponse(res, 404, 'Message not found');
        if (msg.senderId?.toString() !== req.user.sub) return errorResponse(res, 403, 'Not your message');
        if ((Date.now() - new Date(msg.createdAt)) > 300000) {
            return errorResponse(res, 409, 'Edit window expired (5 minutes)');
        }
        if (!req.body.body) return errorResponse(res, 400, 'body required');

        const updated = await Message.findByIdAndUpdate(
            req.params.id,
            {
                $set: {
                    originalBody: msg.body,
                    body:         req.body.body,
                    edited:       true,
                    editedAt:     new Date()
                }
            },
            { new: true }
        );
        io.to(`thread:${msg.threadId}`).emit('message_edited', updated);
        res.json(updated);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// DELETE /messages/:id — soft delete (R11)
app.delete('/:id', async (req, res) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    try {
        const msg     = await Message.findById(req.params.id);
        if (!msg) return errorResponse(res, 404, 'Message not found');
        const isOwner = msg.senderId?.toString() === req.user.sub;
        const isAdmin = req.user.role === 'admin';
        if (!isOwner && !isAdmin) return errorResponse(res, 403, 'Not authorized to delete this message');

        await Message.updateOne(
            { _id: req.params.id },
            { $set: { deleted: true, deletedAt: new Date(), body: '', attachmentUrl: '' } }
        );
        io.to(`thread:${msg.threadId}`).emit('message_deleted', {
            messageId: req.params.id,
            threadId:  msg.threadId
        });
        res.json({ ok: true });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// POST /messages/:id/react — message reactions (C4)
app.post('/:id/react', async (req, res) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    const ALLOWED = ['✓', '👍', '❤️', '😮'];
    const { emoji } = req.body;
    if (!ALLOWED.includes(emoji)) {
        return errorResponse(res, 400, `Emoji must be one of: ${ALLOWED.join(' ')}`);
    }
    try {
        const msg = await Message.findById(req.params.id);
        if (!msg) return errorResponse(res, 404, 'Message not found');

        const userId  = req.user.sub;
        const userOid = new mongoose.Types.ObjectId(userId);
        const existing = msg.reactions?.find(r => r.userId?.toString() === userId && r.emoji === emoji);

        // Pull existing reaction from this user regardless
        await Message.updateOne({ _id: req.params.id }, { $pull: { reactions: { userId: userOid } } });

        // If not a toggle-off, add the new reaction
        if (!existing) {
            await Message.updateOne(
                { _id: req.params.id },
                { $push: { reactions: { userId: userOid, emoji } } }
            );
        }

        const updated = await Message.findById(req.params.id);
        io.to(`thread:${msg.threadId}`).emit('reaction_added', {
            messageId: req.params.id,
            reactions: updated.reactions
        });
        res.json(updated.reactions);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// Legacy GET /thread?with= — backward compat
app.get('/thread', async (req, res) => {
    if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
    const { with: targetUserId } = req.query;
    if (!targetUserId) return errorResponse(res, 400, 'Missing ?with= param');
    try {
        const threadId = makeThreadId(req.user.sub, targetUserId);
        const messages = await Message.find({ threadId }).sort({ createdAt: 1 });
        res.json({ threadId, messages });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// ── Event Bus Listeners ───────────────────────────────────────────────────────

// user.deleted → purge messages + threads (S32 / existing)
bus.on('user.deleted', async (payload) => {
    try {
        const uid = new mongoose.Types.ObjectId(payload.userId);
        const uidStr = payload.userId;

        // 1. Find order-context threads involving this user — keep as business records but anonymize
        const orderThreads = await Thread.find({
            participants: uid,
            'context.type': 'order'
        }).select('_id');
        const orderThreadIds = orderThreads.map(t => t._id);

        // Anonymize messages in order threads (replace sender/recipientId with null sentinel)
        if (orderThreadIds.length) {
            await Message.updateMany(
                { threadId: { $in: orderThreadIds }, senderId: uidStr },
                { $set: { senderId: null, _senderDeleted: true } }
            );
            // Remove user from participantMeta but keep the thread intact
            await Thread.updateMany(
                { _id: { $in: orderThreadIds } },
                {
                    $pull:  { participants: uid, pinnedBy: uid, archivedBy: uid, participantMeta: { userId: uid } },
                    $unset: { [`lastReadAt.${uidStr}`]: '', [`unreadCounts.${uidStr}`]: '' }
                }
            );
        }

        // 2. Find non-order threads (general, product) — delete entirely
        const generalThreads = await Thread.find({
            participants: uid,
            'context.type': { $ne: 'order' }
        }).select('_id');
        const generalThreadIds = generalThreads.map(t => t._id);

        if (generalThreadIds.length) {
            await Message.deleteMany({ threadId: { $in: generalThreadIds } });
            await Thread.deleteMany({ _id: { $in: generalThreadIds } });
        }

        console.log(`[MSG] user.deleted cleanup: anonymized ${orderThreadIds.length} order threads, deleted ${generalThreadIds.length} general threads for user ${uidStr}`);
    } catch (err) { console.error('[MSG] user.deleted cleanup error:', err.message); }
});

// order.placed → inject system message + seed thread (C2 / S22)
bus.on('order.placed', async (payload) => {
    try {
        const { orderId, buyerId, sellerIds, items, totalAmount } = payload;
        if (!orderId || !buyerId || !Array.isArray(sellerIds) || !sellerIds.length) return;

        for (const sellerId of sellerIds) {
            const threadId = makeThreadId(
                buyerId.toString(), sellerId.toString(), 'order', orderId.toString()
            );
            const shortId = orderId.toString().slice(-8).toUpperCase();

            await Thread.findOneAndUpdate(
                { _id: threadId },
                {
                    $setOnInsert: {
                        _id:          threadId,
                        participants: [buyerId, sellerId],
                        context:      { type: 'order', refId: orderId, refTitle: `Order #${shortId}`, refImage: '' },
                        participantMeta: [
                            { userId: buyerId,   displayName: '' },
                            { userId: sellerId,  displayName: '' }
                        ]
                    }
                },
                { upsert: true, new: true }
            );

            const sellerItems = (items || []).filter(i => i.sellerId?.toString() === sellerId.toString());
            const itemCount = sellerItems.length;
            const total = totalAmount ? ` — Total: $${(totalAmount / 100).toFixed(2)}` : '';
            const body  = `Order #${shortId} placed${total}. ${itemCount} item${itemCount !== 1 ? 's' : ''}.`;

            await injectSystemMessage(threadId, body, [buyerId.toString(), sellerId.toString()]);
        }
    } catch (err) { console.error('[MSG] order.placed handler error:', err.message); }
});

// shipment.created → inject system message (C2 / S23)
bus.on('shipment.created', async (payload) => {
    try {
        const { orderId, buyerId, sellerId, carrier, trackingNumber } = payload;
        if (!orderId || !buyerId || !sellerId) return;

        const threadId = makeThreadId(
            buyerId.toString(), sellerId.toString(), 'order', orderId.toString()
        );
        const thread = await Thread.findById(threadId);
        if (!thread) return;

        const tracking = trackingNumber
            ? ` Tracking: ${trackingNumber}${carrier ? ` via ${carrier}` : ''}.`
            : '';
        await injectSystemMessage(
            threadId,
            `Your order has shipped!${tracking}`,
            thread.participants.map(p => p.toString())
        );
    } catch (err) { console.error('[MSG] shipment.created handler error:', err.message); }
});

// shipment.delivered → system message + auto-archive flag (C2, C12 / S23)
bus.on('shipment.delivered', async (payload) => {
    try {
        const { orderId, buyerId, sellerId } = payload;
        if (!orderId || !buyerId || !sellerId) return;

        const threadId = makeThreadId(
            buyerId.toString(), sellerId.toString(), 'order', orderId.toString()
        );
        const thread = await Thread.findById(threadId);
        if (!thread) return;

        await injectSystemMessage(threadId, 'Order delivered.', thread.participants.map(p => p.toString()));

        // Set auto-archive flag — daily sweep archives after 30d of silence
        await Thread.updateOne(
            { _id: threadId },
            {
                $set: {
                    pendingAutoArchive:   true,
                    pendingAutoArchiveAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
                }
            }
        );
    } catch (err) { console.error('[MSG] shipment.delivered handler error:', err.message); }
});

// order.status_updated → system message + priority escalation (C2, C13 / S23)
bus.on('order.status_updated', async (payload) => {
    try {
        const { orderId, status, buyerId, sellerIds } = payload;
        if (!orderId || !buyerId) return;

        const STATUS_MESSAGES = {
            cancelled:          'This order has been cancelled.',
            refund_requested:   'A refund has been requested for this order.',
            disputed:           'A dispute has been opened for this order.',
            shipped:            'Your order is now shipped.',
            delivered:          'Your order has been delivered.'
        };
        const body = STATUS_MESSAGES[status];
        if (!body) return;

        const URGENT = ['cancelled', 'refund_requested', 'disputed'];
        const sellers = Array.isArray(sellerIds) ? sellerIds : [];

        for (const sellerId of sellers) {
            const threadId = makeThreadId(
                buyerId.toString(), sellerId.toString(), 'order', orderId.toString()
            );
            const thread = await Thread.findById(threadId);
            if (!thread) continue;

            await injectSystemMessage(threadId, body, thread.participants.map(p => p.toString()));
            if (URGENT.includes(status)) {
                await Thread.updateOne({ _id: threadId }, { $set: { priority: 'urgent' } });
            }
        }
    } catch (err) { console.error('[MSG] order.status_updated handler error:', err.message); }
});

// shipment.status_updated → inject system message per status change into order thread (C4/S14)
// 'created' is excluded — shipment.created already covers it and fires a richer message.
bus.on('shipment.status_updated', async (payload) => {
    try {
        const { orderId, buyerId, sellerId, status, note, location } = payload;
        if (!orderId || !buyerId || !sellerId) return;
        if (status === 'created') return; // handled by shipment.created listener above

        const threadId = makeThreadId(
            buyerId.toString(), sellerId.toString(), 'order', orderId.toString()
        );
        const thread = await Thread.findById(threadId);
        if (!thread) return; // do not create threads from status updates

        const STATUS_LABELS = {
            in_transit:        'In transit',
            out_for_delivery:  'Out for delivery',
            delivered:         'Delivered',
            cancelled:         'Shipment cancelled'
        };
        let body = `Shipment update: ${STATUS_LABELS[status] || status}.`;
        if (note)     body += ` ${note}.`;
        if (location) body += ` (${location})`;

        await injectSystemMessage(threadId, body, thread.participants.map(p => p.toString()));
    } catch (err) { console.error('[MSG] shipment.status_updated handler error:', err.message); }
});

// payment.disputed → inject system message + set thread priority to urgent (C6/S9)
bus.on('payment.disputed', async (payload) => {
    try {
        const { orderId, buyerId } = payload;
        if (!orderId || !buyerId) return;

        // Fetch seller from escrow best-effort to find the order thread participants
        let sellerIds = [];
        try {
            const escRes = await fetch(`http://localhost:5004/escrow/${orderId}`).catch(() => null);
            if (escRes?.ok) {
                const esc = await escRes.json();
                sellerIds = (esc.sellerPayouts || []).map(p => p.sellerId?.toString()).filter(Boolean);
            }
        } catch {}

        for (const sellerId of sellerIds) {
            const threadId = makeThreadId(
                buyerId.toString(), sellerId.toString(), 'order', orderId.toString()
            );
            const thread = await Thread.findById(threadId);
            if (!thread) continue;

            // Escalate thread priority to urgent
            await Thread.findByIdAndUpdate(threadId, { priority: 'urgent' });

            const shortId = orderId.toString().slice(-8).toUpperCase();
            await injectSystemMessage(
                threadId,
                `A payment dispute has been raised for order #${shortId}. This conversation has been flagged for review. An admin will respond shortly.`,
                thread.participants.map(p => p.toString())
            );
        }
    } catch (err) { console.error('[MSG] payment.disputed handler error:', err.message); }
});

// user.profile_updated → update participantMeta display names (C19 / S32)
bus.on('user.profile_updated', async (payload) => {
    try {
        const { userId, displayName } = payload;
        if (!userId || !displayName) return;
        await Thread.updateMany(
            { 'participantMeta.userId': new mongoose.Types.ObjectId(userId) },
            { $set: { 'participantMeta.$[elem].displayName': displayName } },
            { arrayFilters: [{ 'elem.userId': new mongoose.Types.ObjectId(userId) }] }
        );
    } catch (err) { console.error('[MSG] user.profile_updated handler error:', err.message); }
});

// ── ADMIN ROUTES ──────────────────────────────────────────────────────────────

// Inline MessagingBan model (no separate file needed)
const MessagingBan = db.model('MessagingBan', new mongoose.Schema({
    userId:    { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
    reason:    { type: String, default: '' },
    type:      { type: String, enum: ['permanent', 'temporary'], default: 'permanent' },
    expiresAt: { type: Date },
    bannedAt:  { type: Date, default: Date.now }
}));

// GET /admin/threads — list all threads, paginated
app.get('/admin/threads', async (req, res) => {
    if (req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    try {
        const page     = Math.max(1, parseInt(req.query.page)  || 1);
        const limit    = Math.min(100, parseInt(req.query.limit) || 30);
        const skip     = (page - 1) * limit;
        const filter   = {};
        if (req.query.priority) filter.priority = req.query.priority;
        const [total, threads] = await Promise.all([
            Thread.countDocuments(filter),
            Thread.find(filter).sort({ lastAt: -1 }).skip(skip).limit(limit)
        ]);
        res.json({ threads, total, page });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// GET /admin/threads/flagged — threads flagged for admin review
app.get('/admin/threads/flagged', async (req, res) => {
    if (req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    try {
        const threads = await Thread.find({
            $or: [{ adminFlagged: true }, { priority: 'urgent' }]
        }).sort({ lastAt: -1 });
        res.json({ threads });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// GET /admin/threads/disputes — all threads with priority:'urgent'
app.get('/admin/threads/disputes', async (req, res) => {
    if (req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    try {
        const threads = await Thread.find({ priority: 'urgent' }).sort({ lastAt: -1 });
        res.json({ threads });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// PATCH /admin/threads/:threadId/flag — mark thread as admin-flagged
app.patch('/admin/threads/:threadId/flag', async (req, res) => {
    if (req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    try {
        const thread = await Thread.findByIdAndUpdate(
            req.params.threadId,
            { $set: { adminFlagged: true, adminFlaggedAt: new Date() } },
            { new: true }
        );
        if (!thread) return errorResponse(res, 404, 'Thread not found');
        res.json({ ok: true, thread });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// PATCH /admin/threads/:threadId/suspend — suspend messaging in thread
app.patch('/admin/threads/:threadId/suspend', async (req, res) => {
    if (req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    try {
        const thread = await Thread.findByIdAndUpdate(
            req.params.threadId,
            { $set: { suspended: true } },
            { new: true }
        );
        if (!thread) return errorResponse(res, 404, 'Thread not found');
        res.json({ ok: true, thread });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// POST /admin/threads/:threadId/system-message — inject system message
app.post('/admin/threads/:threadId/system-message', async (req, res) => {
    if (req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    const { text } = req.body;
    if (!text) return errorResponse(res, 400, 'text required');
    try {
        const thread = await Thread.findById(req.params.threadId);
        if (!thread) return errorResponse(res, 404, 'Thread not found');
        const msg = await Message.create({
            threadId:        req.params.threadId,
            senderId:        null,
            type:            'system',
            body:            text,
            isSystemMessage: true
        });
        await Thread.updateOne(
            { _id: req.params.threadId },
            {
                $set: { lastMessage: text.slice(0, 80), lastMessageType: 'system', lastAt: msg.createdAt },
                $inc: { messageCount: 1 }
            }
        );
        for (const pId of thread.participants) {
            io.to(pId.toString()).emit('system_message', msg);
        }
        io.to(`thread:${req.params.threadId}`).emit('system_message', msg);
        res.status(201).json(msg);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// DELETE /admin/messages/:messageId — hard delete a message
app.delete('/admin/messages/:messageId', async (req, res) => {
    if (req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    try {
        const msg = await Message.findById(req.params.messageId);
        if (!msg) return errorResponse(res, 404, 'Message not found');
        await Message.deleteOne({ _id: req.params.messageId });
        io.to(`thread:${msg.threadId}`).emit('message_deleted', {
            messageId: req.params.messageId,
            threadId:  msg.threadId
        });
        res.json({ success: true });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// GET /admin/banned-users — list all messaging-banned users
app.get('/admin/banned-users', async (req, res) => {
    if (req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    try {
        const bans = await MessagingBan.find().sort({ bannedAt: -1 });
        res.json({ bans });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// POST /admin/ban/:userId — ban user from messaging
app.post('/admin/ban/:userId', async (req, res) => {
    if (req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    const { reason = '', type = 'permanent', expiresAt } = req.body;
    try {
        const ban = await MessagingBan.findOneAndUpdate(
            { userId: req.params.userId },
            { $set: { reason, type, expiresAt: expiresAt || null, bannedAt: new Date() } },
            { upsert: true, new: true }
        );
        res.status(201).json(ban);
    } catch (err) { errorResponse(res, 500, err.message); }
});

// DELETE /admin/ban/:userId — lift messaging ban
app.delete('/admin/ban/:userId', async (req, res) => {
    if (req.user?.role !== 'admin') return errorResponse(res, 403, 'Admin only');
    try {
        await MessagingBan.deleteOne({ userId: req.params.userId });
        res.json({ success: true });
    } catch (err) { errorResponse(res, 500, err.message); }
});

// ── Auto-archive sweep (C12 / S23) — runs daily ───────────────────────────────
setInterval(async () => {
    try {
        const now     = new Date();
        const threads = await Thread.find({
            pendingAutoArchive:   true,
            pendingAutoArchiveAt: { $lte: now }
        });
        for (const t of threads) {
            if (t.lastAt <= t.pendingAutoArchiveAt) {
                // No messages since archive was flagged — archive for all participants
                await Thread.updateOne(
                    { _id: t._id },
                    { $set: { archivedBy: t.participants, pendingAutoArchive: false } }
                );
                console.log(`[MSG] Auto-archived thread ${t._id}`);
            } else {
                // New activity since flagged — reset
                await Thread.updateOne({ _id: t._id }, { $set: { pendingAutoArchive: false } });
            }
        }
    } catch (err) { console.error('[MSG] Auto-archive sweep error:', err.message); }
}, 24 * 60 * 60 * 1000);

// ── Bus → Socket.io real-time forwarding ──────────────────────────────────────
// Note: socket rooms use bare userId strings (see socket.join(userId) above)

bus.on('payment.captured', (payload) => {
    if (!Array.isArray(payload.sellerIds)) return;
    payload.sellerIds.forEach(sellerId => {
        io.to(sellerId).emit('order.new', {
            orderId: payload.orderId,
            buyerId: payload.buyerId
        });
    });
});

bus.on('order.status_updated', (payload) => {
    if (!payload.buyerId) return;
    io.to(payload.buyerId.toString()).emit('order.status', {
        orderId: payload.orderId,
        status:  payload.status
    });
});

bus.on('shipment.created', (payload) => {
    if (!payload.buyerId) return;
    io.to(payload.buyerId.toString()).emit('shipment.new', {
        orderId:        payload.orderId,
        trackingNumber: payload.trackingNumber,
        carrier:        payload.carrier
    });
});

bus.on('shipment.delivered', (payload) => {
    if (!payload.buyerId) return;
    io.to(payload.buyerId.toString()).emit('shipment.delivered', {
        orderId: payload.orderId
    });
});

bus.on('inventory.stock_low', (payload) => {
    if (!payload.sellerId) return;
    io.to(payload.sellerId.toString()).emit('stock.low', {
        productId: payload.productId,
        quantity:  payload.quantity
    });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5009;
app.get('/health', (req, res) => {
    res.json({ service: 'messaging-service', status: 'ok', dbState: db.readyState === 1 ? 'connected' : 'disconnected' });
});

server.listen(PORT, () => console.log(`Messaging Service on port ${PORT}`));
