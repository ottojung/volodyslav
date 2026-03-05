const express = require("express");
const { synchronizeAll, isSynchronizeAllError } = require("../sync");

/** @typedef {import('../gitstore/working_repository').SyncForce} SyncForce */
/** @typedef {import('../capabilities/root').Capabilities} Capabilities */

/**
 * Casts the `force` field to a SyncForce type if valid, or returns null if invalid.
 *
 * @param {unknown} value
 * @returns {SyncForce | undefined | null} - Returns the valid SyncForce value, or null if invalid.
 */
function castToForce(value) {
    if (value === "theirs" || value === "ours") {
        return value;
    } else if (value === undefined) {
        return undefined;
    } else {
        return null;
    }
}

/**
 * Handles POST /sync requests.
 * @param {Capabilities} capabilities
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function handleSyncRequest(capabilities, req, res) {
    const body = req.body || {};
    const force = castToForce(body.force);

    if (force === null) {
        return res.status(400).json({
            error: `Invalid force value: ${JSON.stringify(body.force)}. Must be "theirs", "ours", or absent.`,
        });
    }

    /** @type {{ force?: SyncForce }} */
    const options = force !== undefined ? { force } : {};

    capabilities.logger.logDebug(
        { method: req.method, url: req.originalUrl, force, client_ip: req.ip },
        "Sync endpoint called"
    );

    try {
        await synchronizeAll(capabilities, options);
    } catch (error) {
        if (isSynchronizeAllError(error)) {
            const message = error.errors.map((e) => e.message).join("; ");
            capabilities.logger.logError({ error: message }, "Errors during synchronization");
            return res.status(500).json({ error: `Sync failed: ${message}` });
        }
        const message = error instanceof Error ? error.message : String(error);
        capabilities.logger.logError({ error: message }, "Unexpected error during synchronization");
        return res.status(500).json({ error: `Sync failed: ${message}` });
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
