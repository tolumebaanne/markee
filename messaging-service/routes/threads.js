module.exports = function createThreadRoutes(services) {
    const express  = require('express');
    const router   = express.Router();
    const { threadService, unreadService, identityService, logger } = services;
    const errorResponse = require('../../shared/utils/errorResponse');

    const USER_URL = process.env.USER_SERVICE_URL || 'http://localhost:5013';

    async function fetchDisplayNames(userIds) {
        if (!userIds.length) return {};
        try {
            const r = await fetch(
                `${USER_URL}/users/internal/display-names?ids=${userIds.join(',')}`,
                { headers: { 'x-internal-service': 'messaging-service' } }
            );
            return r.ok ? await r.json() : {};
        } catch { return {}; }
    }

    // GET /threads — List user's threads (paginated)
    router.get('/threads', async (req, res) => {
        try {
            const userId   = req.user.sub;
            const archived = req.query.archived === 'true';
            const page     = Math.max(1, parseInt(req.query.page) || 1);
            const limit    = Math.min(50, parseInt(req.query.limit) || 20);
            const result   = await threadService.listThreads(userId, { archived, page, limit });

            // Map to frontend-expected shape
            const threads = result.threads.map(t => {
                const rc = t.readCursors && t.readCursors.get
                    ? t.readCursors.get(userId)
                    : (t.readCursors && t.readCursors[userId]);
                return {
                    threadId:        t._id,
                    context:         t.context,
                    lastMessage:     t.lastMessage,
                    lastMessageType: t.lastMessageType,
                    lastAt:          t.lastAt,
                    unreadCount:     (rc && rc.unreadCount) || 0,
                    priority:        t.priority,
                    pinned:          !!(t.pinnedBy && t.pinnedBy.some(p => p.toString() === userId)),
                    archived:        !!(t.archivedBy && t.archivedBy.some(p => p.toString() === userId)),
                    participantMeta: t.participantMeta,
                    messageCount:    t.messageCount
                };
            });

            // Enrich other participants' displayName + email fallback from user-service
            const otherIds = [...new Set(
                threads.flatMap(t => (t.participantMeta || [])
                    .map(m => m.userId?.toString())
                    .filter(id => id && id !== userId)
                )
            )];
            const nameMap = await fetchDisplayNames(otherIds);
            const enriched = threads.map(t => ({
                ...t,
                participantMeta: (t.participantMeta || []).map(m => {
                    const id = m.userId?.toString();
                    if (!id || id === userId) return m;
                    const fresh = nameMap[id];
                    if (!fresh) return m;
                    return { ...m, displayName: fresh.displayName || m.displayName || '', emailFallback: fresh.email };
                })
            }));

            res.json({ threads: enriched, total: result.total, page: result.page });
        } catch (err) {
            logger.error('GET /threads error:', err.message);
            errorResponse(res, 500, err.message);
        }
    });

    // POST /thread — Create or find thread
    router.post('/thread', async (req, res) => {
        try {
            const userId = req.user.sub;
            const { recipientId, contextType, refId, refTitle, refImage, recipientName } = req.body;
            if (!recipientId) return errorResponse(res, 400, 'recipientId required');
            // Resolve storeId → personal userId (passthrough if already a userId)
            const resolvedRecipient = identityService.resolve(recipientId);
            // Auto-fill recipient name from identity cache if not provided
            const resolvedName = recipientName || identityService.getStoreName(recipientId) || identityService.getStoreName(resolvedRecipient) || '';
            const thread = await threadService.findOrCreate(
                userId, resolvedRecipient,
                { type: contextType || 'general', refId, refTitle, refImage },
                req.user.displayName || '', resolvedName
            );
            res.json({ thread });
        } catch (err) {
            logger.error('POST /thread error:', err.message);
            errorResponse(res, 500, err.message);
        }
    });

    // GET /thread/:threadId — Load thread + messages
    router.get('/thread/:threadId', async (req, res) => {
        try {
            const userId = req.user.sub;
            const thread = await threadService.getThread(req.params.threadId, userId);
            const limit  = Math.min(100, parseInt(req.query.limit) || 50);
            const before = req.query.before ? new Date(req.query.before) : null;
            const { messages, hasMore } = await threadService.getMessages(req.params.threadId, { limit, before });
            res.json({ thread, messages, hasMore });
        } catch (err) {
            if (err.statusCode === 403) return errorResponse(res, 403, err.message);
            if (err.statusCode === 404) return errorResponse(res, 404, err.message);
            logger.error('GET /thread/:id error:', err.message);
            errorResponse(res, 500, err.message);
        }
    });

    // POST /thread/:threadId/read — Mark thread as read
    router.post('/thread/:threadId/read', async (req, res) => {
        try {
            const userId = req.user.sub;
            await threadService.markRead(req.params.threadId, userId);
            const total = await unreadService.getTotalUnread(userId);
            res.json({ ok: true, total });
        } catch (err) {
            logger.error('POST /thread/:id/read error:', err.message);
            errorResponse(res, 500, err.message);
        }
    });

    // GET /thread/:threadId/since — Reconnect recovery
    router.get('/thread/:threadId/since', async (req, res) => {
        try {
            const timestamp = req.query.timestamp;
            if (!timestamp) return errorResponse(res, 400, 'timestamp required');
            const messages = await threadService.getMessagesSince(req.params.threadId, timestamp);
            res.json(messages);
        } catch (err) {
            logger.error('GET /thread/:id/since error:', err.message);
            errorResponse(res, 500, err.message);
        }
    });

    // GET /thread/:threadId/search — Search messages
    router.get('/thread/:threadId/search', async (req, res) => {
        try {
            const q = req.query.q;
            if (!q) return errorResponse(res, 400, 'q required');
            const results = await threadService.searchMessages(req.params.threadId, q, 20);
            res.json({ results });
        } catch (err) {
            logger.error('GET /thread/:id/search error:', err.message);
            errorResponse(res, 500, err.message);
        }
    });

    // GET /thread/:threadId/export — Export thread as JSON
    router.get('/thread/:threadId/export', async (req, res) => {
        try {
            const data = await threadService.exportThread(req.params.threadId);
            res.json(data);
        } catch (err) {
            logger.error('GET /thread/:id/export error:', err.message);
            errorResponse(res, 500, err.message);
        }
    });

    // POST /thread/:threadId/archive — Toggle archive
    router.post('/thread/:threadId/archive', async (req, res) => {
        try {
            const result = await threadService.archiveThread(req.params.threadId, req.user.sub);
            res.json(result);
        } catch (err) {
            logger.error('POST /thread/:id/archive error:', err.message);
            errorResponse(res, 500, err.message);
        }
    });

    // POST /thread/:threadId/pin — Toggle pin (max 5)
    router.post('/thread/:threadId/pin', async (req, res) => {
        try {
            const result = await threadService.pinThread(req.params.threadId, req.user.sub);
            res.json(result);
        } catch (err) {
            if (err.statusCode === 409) return errorResponse(res, 409, err.message);
            logger.error('POST /thread/:id/pin error:', err.message);
            errorResponse(res, 500, err.message);
        }
    });

    return router;
};
