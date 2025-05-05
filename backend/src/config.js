const fs = require('fs');
const { resultsDirectory, myServerPort } = require('./environment');

// Directory where uploaded photos are stored.
const uploadDir = resultsDirectory();

// Ensure upload directory exists
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Server listening port
const port = myServerPort();

module.exports = { uploadDir, port };
