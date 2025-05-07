const express = require('express');
const logger = require('./logger');
const { port } = require('./config');
const rootRouter = require('./routes/root');
const uploadRouter = require('./routes/upload');
const pingRouter = require('./routes/ping');
const staticRouter = require('./routes/static');
const transcribeRouter = require('./routes/transcribe');
const transcribeAllRouter = require('./routes/transcribe_all');
const { ensureStartupDependencies } = require('./startup');

const app = express();

// Mount upload and API routers
app.use('/api', uploadRouter);
app.use('/api', rootRouter);
app.use('/api', pingRouter);
app.use('/api', transcribeRouter);
app.use('/api', transcribeAllRouter);
app.use('/', staticRouter);

// Start server if run directly
if (require.main === module) {
  app.listen(port, async () => {
    await ensureStartupDependencies(app);
    logger.info({ port }, 'Server is running');
  });
}

module.exports = app;
