const express = require('express');
const router = express.Router();

/**
 * The alive check endpoint.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
router.get('/ping', (req, res) => {
  res.send('pong');
});

module.exports = router;
