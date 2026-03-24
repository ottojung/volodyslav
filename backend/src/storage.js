const multer = require("multer");

/**
 * Maximum file size per upload in bytes (10 MiB — sufficient for compressed
 * audio diary chunks at typical quality).
 */
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

/**
 * Maximum number of files accepted per request.
 */
const MAX_FILES_PER_REQUEST = 5;

/**
 * Creates a multer upload middleware that stores uploaded files in memory.
 * File contents are available as Buffer objects on each `file.buffer`.
 * The caller is responsible for storing those buffers in the temporary database.
 *
 * Requests exceeding MAX_FILE_SIZE_BYTES or MAX_FILES_PER_REQUEST are rejected
 * before any data is buffered.
 *
 * @returns {import('multer').Multer}
 */
function makeUpload() {
    return multer({
        storage: multer.memoryStorage(),
        limits: {
            fileSize: MAX_FILE_SIZE_BYTES,
            files: MAX_FILES_PER_REQUEST,
        },
    });
}

// Export multer upload middleware using memory storage
module.exports = { makeUpload };
