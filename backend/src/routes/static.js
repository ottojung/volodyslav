const express = require('express');
const path = require('path');

const staticPath = path.join(__dirname, '..', '..', '..', 'frontend', 'dist');
const router = express.Router();
router.use(express.static(staticPath));

/**
 * Static files checkpoint.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
router.get('*', (req, res) => {
    res.sendFile(path.join(staticPath, 'index.html'));
});

module.exports = router;
