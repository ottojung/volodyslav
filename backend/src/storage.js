const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { uploadDir } = require('./config');

/**
 * Multer storage engine to save uploaded files to disk
 * @type {import('multer').StorageEngine}
 */
const storage = multer.diskStorage({
    /**
     * @param {import('express').Request} req
     * @param {Express.Multer.File} _file
     * @param {(error: Error|null, destination: string) => void} cb
     */
    destination: (req, _file, cb) => {
        const reqId = req.body.request_identifier;
        if (!reqId) {
            return cb(new Error('Missing request_identifier field'), uploadDir);
        }

        // e.g. /var/www/uploads/REQ12345
        const targetDir = path.join(uploadDir, reqId);

        // mkdir -p style
        fs.mkdir(targetDir, { recursive: true }, (err /** type {unknown} */) => {
            if (err) {
                return cb(err, targetDir);
            }
            cb(null, targetDir);
        });
    },

    /**
     * @param {import('express').Request} _req
     * @param {Express.Multer.File} file
     * @param {(error: Error|null, filename: string) => void} cb
     */
    filename: (_req, file, cb) => cb(null, file.originalname),
});

// Export multer upload middleware using disk storage
const upload = multer({ storage });
module.exports = upload;
