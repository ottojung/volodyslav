const multer = require('multer');
const fs = require('fs');
const { fromRequest, isDone, makeDirectory } = require('./request_identifier');

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
    destination: async (req, _file, cb) => {
        const reqId = fromRequest(req);
        if (isDone(reqId)) {
            return cb(new Error('Request already handled'), "");
        }

        // e.g. /var/www/uploads/REQ12345
        const targetDir = await makeDirectory(reqId);
        cb(null, targetDir);
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
