const express = require('express');
const { port } = require('./config');
const path = require('path');
const rootRouter = require('./routes/root');
const uploadRouter = require('./routes/upload');
const pingRouter = require('./routes/ping');

const app = express();

// Serve frontend static assets in production
if (process.env.NODE_ENV === 'production') {
  const staticPath = path.join(__dirname, '..', 'frontend', 'dist');
  app.use(express.static(staticPath));
}

// Mount upload and API routers
app.use('/', uploadRouter);
app.use('/', rootRouter);
app.use('/', pingRouter);

// Serve index.html for any unknown route in production (for SPA)
if (process.env.NODE_ENV === 'production') {
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'frontend', 'dist', 'index.html'));
  });
}

// Start server if run directly
if (require.main === module) {
  app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });
}

module.exports = app;
