const multer = require('multer');
const { uploadDir } = require('./config');

/**
 * Multer storage engine to save uploaded files to disk
 * @type {import('multer').StorageEngine}
 */
const storage = multer.diskStorage({
  /**
   * @param {import('express').Request} _req
   * @param {Express.Multer.File} _file
   * @param {(error: Error|null, destination: string) => void} cb
   */
  destination: (_req, _file, cb) => cb(null, uploadDir),
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