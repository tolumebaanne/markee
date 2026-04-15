module.exports = function createAdminRoutes(services) {
    const express = require('express');
    const router  = express.Router();
    const requireAdmin = require('../middleware/requireAdmin');
    const { Thread, Message, MessagingBan, logger, mongoose } = services;
    const errorResponse = require('../../shared/utils/errorResponse');

    // All admin routes require admin role
    router.use('/admin', requireAdmin);

    // GET /admin/threads — List all threads (paginated)
    router.get('/admin/threads', async (req, res) => {
        try {
            const page  = Math.max(1, parseInt(req.query.page) || 1);
            const limit = Math.min(50, parseInt(req.query.limit) || 20);
            const skip  = (page - 1) * limit;
            const query = {};
            if (req.query.priority) query.priority = req.query.priority;

            const [threads, total] = await Promise.all([
                Thread.find(query).sort({ lastAt: -1 }).skip(skip).limit(limit).lean(),
                Thread.countDocuments(query)
            ]);
            res.json({ threads, total, page });
        } catch (err) {
            logger.error('GET /admin/threads error:', err.message);
            errorResponse(res, 500, err.message);
        }
    });

    // GET /admin/threads/flagged — Flagged + urgent threads
    router.get('/admin/threads/flagged', async (req, res) => {
        try {
            const threads = await Thread.find({
                $or: [{ 'admin.flagged': true }, { priority: 'urgent' }]
            }).sort({ lastAt: -1 }).lean();
            res.json({ threads });
        } catch (err) {
            logger.error('GET /admin/threads/flagged error:', err.message);
            errorResponse(res, 500, err.message);
        }
    });

    // GET /admin/threads/disputes — Urgent threads only
    router.get('/admin/threads/disputes', async (req, res) => {
        try {
            const threads = await Thread.find({ priority: 'urgent' }).sort({ lastAt: -1 }).lean();
            res.json({ threads });
        } catch (err) {
            logger.error('GET /admin/threads/disputes error:', err.message);
            errorResponse(res, 500, err.message);
        }
    });

    // GET /thread/:threadId/admin — View all messages (admin, no participant check)
    router.get('/thread/:threadId/admin', requireAdmin, async (req, res) => {
        try {
            const thread = await Thread.findById(req.params.threadId);
            if (!thread) return errorResponse(res, 404, 'Thread not found');
            const messages = await Message.find({
                threadId: thread._id
            }).sort({ createdAt: 1 });
            res.json({ thread, messages });
        } catch (err) {
            logger.error('GET /thread/:id/admin error:', err.message);
            errorResponse(res, 500, err.message);
        }
    });

    // PATCH /admin/threads/:threadId/flag — Flag thread for review
    router.patch('/admin/threads/:threadId/flag', async (req, res) => {
        try {
            const thread = await Thread.findByIdAndUpdate(
                req.params.threadId,
                { $set: { 'admin.flagged': true, 'admin.flaggedAt': new Date() } },
                { new: true }
            );
            if (!thread) return errorResponse(res, 404, 'Thread not found');
            res.json({ thread });
        } catch (err) {
            logger.error('PATCH /admin/flag error:', err.message);
            errorResponse(res, 500, err.message);
        }
    });

    // PATCH /admin/threads/:threadId/suspend — Toggle suspend
    router.patch('/admin/threads/:threadId/suspend', async (req, res) => {
        try {
            const thread = await Thread.findById(req.params.threadId);
            if (!thread) return errorResponse(res, 404, 'Thread not found');
            const newState = !thread.admin?.suspended;
            await Thread.updateOne({ _id: req.params.threadId }, {
                $set: { 'admin.suspended': newState, 'admin.suspendedAt': newState ? new Date() : null }
            });
            res.json({ suspended: newState });
        } catch (err) {
            logger.error('PATCH /admin/suspend error:', err.message);
            errorResponse(res, 500, err.message);
        }
    });

    // POST /admin/threads/:threadId/system-message — Inject system message
    router.post('/admin/threads/:threadId/system-message', async (req, res) => {
        try {
            const { body } = req.body;
            if (!body) return errorResponse(res, 400, 'body required');

            const thread = await Thread.findById(req.params.threadId);
            if (!thread) return errorResponse(res, 404, 'Thread not found');

            const recipientId = thread.participants[0];
            const msg = await Message.create({
                threadId: thread._id,
                senderId: null,
                recipientId,
                type: 'system',
                body
            });

            await Thread.updateOne({ _id: thread._id }, {
                $set: { lastMessage: body.slice(0, 80), lastMessageType: 'system', lastAt: msg.createdAt },
                $inc: { messageCount: 1 }
            });

            // Broadcast to all participants via socket
            const io = services.io;
            if (io) {
                thread.participants.forEach(p => {
                    io.to(p.toString()).emit('system_message', msg);
                });
            }

            res.json({ message: msg });
        } catch (err) {
            logger.error('POST /admin/system-message error:', err.message);
            errorResponse(res, 500, err.message);
        }
    });

    // DELETE /admin/messages/:messageId — Hard-delete message
    router.delete('/admin/messages/:messageId', async (req, res) => {
        try {
            const msg = await Message.findByIdAndDelete(req.params.messageId);
            if (!msg) return errorResponse(res, 404, 'Message not found');

            // Notify via socket
            const io = services.io;
            if (io) {
                io.to(`thread:${msg.threadId}`).emit('message_deleted', {
                    messageId: msg._id,
                    threadId: msg.threadId
                });
            }

            res.json({ ok: true });
        } catch (err) {
            logger.error('DELETE /admin/messages error:', err.message);
            errorResponse(res, 500, err.message);
        }
    });

    // GET /admin/banned-users — List messaging bans
    router.get('/admin/banned-users', async (req, res) => {
        try {
            const bans = await MessagingBan.find({}).sort({ bannedAt: -1 });
            res.json({ bans });
        } catch (err) {
            logger.error('GET /admin/banned-users error:', err.message);
            errorResponse(res, 500, err.message);
        }
    });

    // POST /admin/ban/:userId — Ban user from messaging
    router.post('/admin/ban/:userId', async (req, res) => {
        try {
            const { reason, type, expiresAt } = req.body;
            const ban = await MessagingBan.findOneAndUpdate(
                { userId: req.params.userId },
                {
                    userId: req.params.userId,
                    reason: reason || '',
                    type: type || 'permanent',
                    expiresAt: type === 'temporary' ? expiresAt : undefined,
                    bannedAt: new Date()
                },
                { upsert: true, new: true }
            );
            res.json({ ban });
        } catch (err) {
            logger.error('POST /admin/ban error:', err.message);
            errorResponse(res, 500, err.message);
        }
    });

    // DELETE /admin/ban/:userId — Lift ban
    router.delete('/admin/ban/:userId', async (req, res) => {
        try {
            await MessagingBan.deleteOne({ userId: req.params.userId });
            res.json({ ok: true });
        } catch (err) {
            logger.error('DELETE /admin/ban error:', err.message);
            errorResponse(res, 500, err.message);
        }
    });

    return router;
};
