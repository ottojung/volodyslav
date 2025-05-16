const express = require("express");
const router = express.Router();
const { logDebug } = require("../logger");
const { everyHour } = require("../scheduler");

/**
 * This endpoint is called periodically.
 * It is responsible for some chore tasks like garbage collection.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
router.get("/periodic", async (req, res) => {
    /** @type {any} */
    const query = req.query;
    const period = query['period'];

    logDebug(
        { method: req.method, url: req.originalUrl },
        "Periodic endpoint called"
    );

    if (!period) {
        res.status(400).send("Bad Request: period parameter is required");
        return;
    }

    switch (period) {
        case "hour":
        case "hourly":
            await everyHour();
            res.send("done");
            return;
        default:
            res.status(400).send("Bad Request: unknown period");
            return;
    }
});

module.exports = router;
