const express = require('express');
const { port } = require('./config');
const path = require('path');
const rootRouter = require('./routes/root');
const uploadRouter = require('./routes/upload');
const pingRouter = require('./routes/ping');

const app = express();


// Mount upload and API routers
app.use('/api', uploadRouter);
app.use('/api', rootRouter);
app.use('/api', pingRouter);

// Serve frontend static assets.
// IMPORTANT: Do not check for any production flags.
const staticPath = path.join(__dirname, '..', '..', 'frontend', 'dist');
app.use(express.static(staticPath));
app.get('*', (req, res) => {
    res.sendFile(path.join(staticPath, 'index.html'));
});

// Start server if run directly
if (require.main === module) {
  app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });
}

module.exports = app;
