module.exports = function createUploadRoutes(services) {
    const express = require('express');
    const router  = express.Router();
    const multer  = require('multer');
    const { v4: uuidv4 } = require('uuid');
    const path    = require('path');
    const fs      = require('fs');
    const { imageService, logger } = services;
    const errorResponse = require('../../shared/utils/errorResponse');

    const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

    const upload = multer({ limits: { fileSize: 8 * 1024 * 1024 } });

    router.post('/upload', upload.single('image'), async (req, res) => {
        try {
            if (!req.user?.sub) return errorResponse(res, 401, 'Unauthorized');
            if (!req.file) return errorResponse(res, 400, 'No file uploaded');

            const compressed = await imageService.compress(req.file.buffer, 50);
            const filename   = uuidv4() + '.jpg';
            const filePath   = path.join(UPLOADS_DIR, filename);
            fs.writeFileSync(filePath, compressed);

            const sizeKb = Math.round(compressed.length / 1024);
            res.json({ url: `/api/messages/uploads/${filename}`, sizeKb });
        } catch (err) {
            if (err.message && err.message.includes('compressed')) return errorResponse(res, 422, err.message);
            logger.error('POST /upload error:', err.message);
            errorResponse(res, 500, err.message);
        }
    });

    return router;
};
