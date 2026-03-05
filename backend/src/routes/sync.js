const express = require("express");
const eventLogStorage = require("../event_log_storage");
const { synchronizeDatabase } = require("../generators");

/** @typedef {import('../gitstore/working_repository').SyncForce} SyncForce */
/** @typedef {import('../capabilities/root').Capabilities} Capabilities */

/**
 * Validates the `force` field from the request body.
 * @param {unknown} value
 * @returns {value is SyncForce | undefined}
 */
function isValidForce(value) {
    return value === undefined || value === "theirs" || value === "ours";
}

/**
 * Handles POST /sync requests.
 * @param {Capabilities} capabilities
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function handleSyncRequest(capabilities, req, res) {
    const body = req.body || {};
    const force = body.force;

    if (!isValidForce(force)) {
        return res.status(400).json({
            error: `Invalid force value: ${JSON.stringify(force)}. Must be "theirs", "ours", or absent.`,
        });
    }

    /** @type {{ force?: SyncForce }} */
    const options = force !== undefined ? { force } : {};

    capabilities.logger.logDebug(
        { method: req.method, url: req.originalUrl, force, client_ip: req.ip },
        "Sync endpoint called"
    );

    try {
        await eventLogStorage.synchronize(capabilities, options);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        capabilities.logger.logError({ error: message }, "Error during event log synchronization");
        return res.status(500).json({ error: `Event log sync failed: ${message}` });
    }

    try {
        await capabilities.interface.withDatabaseLocked(() =>
            synchronizeDatabase(capabilities, options)
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        capabilities.logger.logError({ error: message }, "Error during generators database synchronization");
        return res.status(500).json({ error: `Generators database sync failed: ${message}` });
    }

    try {
        await capabilities.interface.update();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        capabilities.logger.logError({ error: message }, "Error invalidating interface after sync");
        return res.status(500).json({ error: `Interface update failed: ${message}` });
    }

    return res.status(204).end();
}

/**
 * @param {Capabilities} capabilities
 * @returns {import('express').Router}
 */
function makeRouter(capabilities) {
    const router = express.Router();

    router.post("/sync", async (req, res) => {
        await handleSyncRequest(capabilities, req, res);
    });

    return router;
}

module.exports = { makeRouter };
