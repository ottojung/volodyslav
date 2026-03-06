const express = require("express");
const { synchronizeAll, isSynchronizeAllError } = require("../sync");

/** @typedef {import('../capabilities/root').Capabilities} Capabilities */

/**
 * Handles POST /sync requests.
 * @param {Capabilities} capabilities
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function handleSyncRequest(capabilities, req, res) {
    const body = req.body || {};
    const resetToTheirs = body.reset_to_theirs;

    if (resetToTheirs !== undefined && resetToTheirs !== true) {
        return res.status(400).json({
            error: `Invalid reset_to_theirs value: ${JSON.stringify(resetToTheirs)}. Must be true or absent.`,
        });
    }

    /** @type {{ resetToTheirs?: boolean }} */
    const options = resetToTheirs === true ? { resetToTheirs: true } : {};

    capabilities.logger.logDebug(
        { method: req.method, url: req.originalUrl, resetToTheirs, client_ip: req.ip },
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
