const express = require("express");
const router = express.Router();
const { logDebug } = require("../logger");
const { processDiaryAudios } = require("../diary");
const deleterCapability = require("../filesystem/delete_file");
const random = require('../random');

/**
 * This endpoint is called periodically.
 * It is responsible for some chore tasks like garbage collection.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
router.get("/periodic", async (req, res) => {
    logDebug(
        { method: req.method, url: req.originalUrl },
        "Periodic endpoint called"
    );

    const deleter = deleterCapability.make();
    const rng = random.default_generator(random.nondeterministic_seed());

    await processDiaryAudios(deleter, rng);

    res.send("done");
});

module.exports = router;
