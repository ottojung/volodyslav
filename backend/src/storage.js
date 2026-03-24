const multer = require("multer");

/**
 * Creates a multer upload middleware that stores uploaded files in memory.
 * File contents are available as Buffer objects on each `file.buffer`.
 * The caller is responsible for storing those buffers in the temporary database.
 *
 * @returns {import('multer').Multer}
 */
function makeUpload() {
    return multer({ storage: multer.memoryStorage() });
}

// Export multer upload middleware using memory storage
module.exports = { makeUpload };
