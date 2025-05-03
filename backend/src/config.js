const path = require('path');
const fs = require('fs');

// Directory where uploaded photos are stored
const uploadDir = path.join(__dirname, '..', 'uploads');
// Ensure upload directory exists
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Server listening port
const port = process.env.PORT || 3000;

module.exports = { uploadDir, port };