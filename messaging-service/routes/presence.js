module.exports = function createPresenceRoutes(services) {
    const express = require('express');
    const router  = express.Router();
    const { presenceService } = services;

    // GET /presence/:userId — Check if user is online
    router.get('/presence/:userId', (req, res) => {
        const status = presenceService.getStatus(req.params.userId);
        res.json(status);
    });

    return router;
};
