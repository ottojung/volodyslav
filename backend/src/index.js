// Main framework.
const express = require('express');

// For file uploads
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();

// Ensure upload directory exists
const uploadDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Configure multer storage to save uploaded photos to disk
/**
 * Configure multer storage to save uploaded photos to disk
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
const upload = multer({ storage });

const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Hello World!');
});

// Endpoint to receive photo uploads
// Expects form-data with field 'photos' (can be multiple files)
// Endpoint to receive photo uploads
// Expects form-data with field 'photos' (can be multiple files)
app.post(
  '/upload',
  upload.array('photos'),
  /**
   * @param {import('express').Request & { files: Express.Multer.File[] }} req
   * @param {import('express').Response} res
   */
  (req, res) => {
    // Files have been stored to disk under uploads/ with original names
    const files = /** @type {Express.Multer.File[]} */ (req.files || []);
    const uploaded = files.map((f) => f.filename);
    res.json({ success: true, files: uploaded });
  }
);

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });
}

module.exports = app;
