module.exports = function createMessageRoutes(services) {
    const express = require('express');
    const router  = express.Router();
    const { messageService, unreadService, logger } = services;
    const errorResponse = require('../../shared/utils/errorResponse');

    // GET /unread-count — Total unread count
    router.get('/unread-count', async (req, res) => {
        try {
            const total = await unreadService.getTotalUnread(req.user.sub);
            res.json({ total });
        } catch (err) {
            logger.error('GET /unread-count error:', err.message);
            errorResponse(res, 500, err.message);
        }
    });

    // PUT /:id — Edit message (5-min window)
    router.put('/:id', async (req, res) => {
        try {
            const { body } = req.body;
            if (!body || !body.trim()) return errorResponse(res, 400, 'body required');
            const msg = await messageService.edit(req.params.id, req.user.sub, body.trim());
            res.json({ message: msg });
        } catch (err) {
            if (err.statusCode) return errorResponse(res, err.statusCode, err.message);
            logger.error('PUT /:id error:', err.message);
            errorResponse(res, 500, err.message);
        }
    });

    // DELETE /:id — Soft-delete message
    router.delete('/:id', async (req, res) => {
        try {
            const isAdmin = req.user.role === 'admin';
            await messageService.softDelete(req.params.id, req.user.sub, isAdmin);
            res.json({ ok: true });
        } catch (err) {
            if (err.statusCode) return errorResponse(res, err.statusCode, err.message);
            logger.error('DELETE /:id error:', err.message);
            errorResponse(res, 500, err.message);
        }
    });

    // POST /:id/react — Add/toggle emoji reaction
    router.post('/:id/react', async (req, res) => {
        try {
            const { emoji } = req.body;
            if (!emoji) return errorResponse(res, 400, 'emoji required');
            const reactions = await messageService.addReaction(req.params.id, req.user.sub, emoji);
            res.json({ reactions });
        } catch (err) {
            if (err.statusCode) return errorResponse(res, err.statusCode, err.message);
            logger.error('POST /:id/react error:', err.message);
            errorResponse(res, 500, err.message);
        }
    });

    return router;
};
