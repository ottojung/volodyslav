const path = require('path');
const fs = require('fs');


const myroot = process.env.MY_ROOT;
if (myroot === undefined) {
   throw new Error("Must defined $MY_ROOT evironment variable.");
}


// Directory where uploaded photos are stored.
const uploadDir = path.join(myroot, 'wd', 'volodyslav', 'uploads');

// Ensure upload directory exists
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Server listening port
const port = process.env.PORT || 29932;

module.exports = { uploadDir, port };
