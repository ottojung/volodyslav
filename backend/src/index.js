const express = require('express');
const { port } = require('./config');
const rootRouter = require('./routes/root');
const uploadRouter = require('./routes/upload');

const app = express();

// Mount routers
app.use('/', rootRouter);
app.use('/', uploadRouter);

// Start server if run directly
if (require.main === module) {
  app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });
}

module.exports = app;
