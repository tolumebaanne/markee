module.exports = function createTemplateRoutes(services) {
    const express = require('express');
    const router  = express.Router();
    const { Template, logger } = services;
    const errorResponse = require('../../shared/utils/errorResponse');

    // GET /templates — List seller's templates
    router.get('/templates', async (req, res) => {
        try {
            if (!req.user.storeId) return errorResponse(res, 403, 'Sellers only');
            const templates = await Template.find({ sellerId: req.user.sub }).sort({ createdAt: 1 });
            res.json({ templates });
        } catch (err) {
            logger.error('GET /templates error:', err.message);
            errorResponse(res, 500, err.message);
        }
    });

    // POST /templates — Create template (max 10)
    router.post('/templates', async (req, res) => {
        try {
            if (!req.user.storeId) return errorResponse(res, 403, 'Sellers only');
            const { label, body } = req.body;
            if (!label || !body) return errorResponse(res, 400, 'label and body required');

            const count = await Template.countDocuments({ sellerId: req.user.sub });
            if (count >= 10) return errorResponse(res, 409, 'Maximum 10 templates');

            const template = await Template.create({ sellerId: req.user.sub, label, body });
            res.json({ template });
        } catch (err) {
            logger.error('POST /templates error:', err.message);
            errorResponse(res, 500, err.message);
        }
    });

    return router;
};
