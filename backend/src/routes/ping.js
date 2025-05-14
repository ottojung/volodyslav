const express = require("express");
const router = express.Router();
const runtimeIdentifier = require("../runtime_identifier");

/**
 * The alive check endpoint.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
router.get("/ping", (req, res) => {
    const id = req.query.runtime_identifier;

    if (id !== undefined) {
        if (!id) {
            return res.status(400).send("Bad Request");
        }
        if (id !== runtimeIdentifier) {
            return res.status(400).send("Identifiers do not match.");
        }
    }

    return res.send("pong");
});

module.exports = router;
