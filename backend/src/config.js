const { resultsDirectory, myServerPort } = require('./environment');

// Directory where uploaded photos are stored.
const uploadDir = resultsDirectory();

// Server listening port
const port = myServerPort();

module.exports = { uploadDir, port };
