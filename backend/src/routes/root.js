const express = require('express');
const router = express.Router();

/**
 * Root endpoint
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
router.get('/', (req, res) => {
  res.send('Hello World!');
});

module.exports = router;