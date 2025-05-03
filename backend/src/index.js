const express = require('express');
const { port } = require('./config');
const rootRouter = require('./routes/root');
const uploadRouter = require('./routes/upload');
const pingRouter = require('./routes/ping');
const staticRouter = require('./routes/static');

const app = express();

// Mount upload and API routers
app.use('/', pingRouter);
app.use('/api', uploadRouter);
app.use('/api', rootRouter);
app.use('/api', pingRouter);

// Start server if run directly
if (require.main === module) {
  app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });
}

module.exports = app;
