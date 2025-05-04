const express = require('express');
const router = express.Router();
const logger = require('../logger');

/**
 * Root endpoint
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
router.get('/', (req, res) => {
  logger.info({ method: req.method, url: req.originalUrl }, 'Root endpoint called');
  res.send('Hello World!');
});

module.exports = router;