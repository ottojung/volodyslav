const express = require("express");
const router = express.Router();
const { logDebug } = require("../logger");
const { processDiaryAudios } = require("../diary");
const deleterCapability = require("../filesystem/delete_file");
const random = require('../random');

// Function encapsulating hourly tasks
/**
 * Runs hourly tasks.
 * @param {import('../filesystem/delete_file').FileDeleter} deleter
 * @param {import('../random').RNG} rng
 */
async function everyHour(deleter, rng) {
    await processDiaryAudios(deleter, rng);
}

/**
 * This endpoint is called periodically.
 * It is responsible for some chore tasks like garbage collection.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
router.get("/periodic", async (req, res) => {
    const period = req.query.period;

    logDebug(
        { method: req.method, url: req.originalUrl },
        "Periodic endpoint called"
    );

    const deleter = deleterCapability.make();
    const rng = random.default_generator(random.nondeterministic_seed());

    if (!period) {
        return res.status(400).send('Bad Request: period parameter is required');
    }
        
    switch (period) {
        case 'hour':
        case 'hourly':
            await everyHour(deleter, rng);
            break;
        default:
            return res.status(400).send('Bad Request: unknown period');
    }

    res.send("done");
});

module.exports = router;
