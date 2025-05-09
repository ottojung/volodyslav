const express = require('express');
const upload = require('../storage');
const router = express.Router();
const { logger } = require('../logger');
const { fromRequest, markDone } = require('../request_identifier');

/**
 * Photo upload endpoint
 * Expects multipart/form-data with 'photos' files
 * @param {import('express').Request & { files: Express.Multer.File[] }} req
 * @param {import('express').Response} res
 */
router.post('/upload', upload.array('photos'), async (req, res) => {
    const files = /** @type {Express.Multer.File[]} */ (req.files || []);
    const uploaded = files.map((f) => f.filename);
    logger.info({ files: uploaded }, 'Files uploaded');
    await markDone(fromRequest(req));
    res.json({ success: true, files: uploaded });
});

module.exports = router;
