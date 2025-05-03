const path = require('path');
const fs = require('fs');
const { myRoot, myServerPort } = require('./environment');


// Directory where uploaded photos are stored.
const myroot = myRoot();
const uploadDir = path.join(myroot, 'wd', 'volodyslav', 'uploads');

// Ensure upload directory exists
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Server listening port
const port = myServerPort() || 29932;

module.exports = { uploadDir, port };
