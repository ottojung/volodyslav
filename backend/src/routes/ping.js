const express = require('express');
const router = express.Router();
const { logInfo } = require('../logger');

/**
 * The alive check endpoint.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
router.get('/ping', (req, res) => {
  logInfo({ method: req.method, url: req.originalUrl }, 'Ping endpoint called');
  res.send('pong');
});

module.exports = router;
