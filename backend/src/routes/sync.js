const express = require("express");
const { synchronizeAll, synchronizeAllExclusiveProcess } = require("../sync");
const { isValidHostname, parseHeadsRefHostnameBranch } = require("../hostname");

/** @typedef {import('../capabilities/root').Capabilities} Capabilities */
/** @typedef {import('../sync').SyncState} SyncState */

/**
 * @param {import('express').Response} res
 * @param {SyncState} state
 */
function sendSyncState(res, state) {
    if (state.status === "running") {
        return res.status(202).json(state);
    }

    if (state.status === "error") {
        return res.status(500).json(state);
    }

    return res.status(200).json(state);
}

/**
 * @param {Capabilities} capabilities
 * @returns {Promise<string[]>}
 */
async function listResetHostnames(capabilities) {
    const remotePath = capabilities.environment.generatorsRepository();
    const result = await capabilities.git.call(
        "-c",
        "safe.directory=*",
        "ls-remote",
        "--heads",
        "--",
        remotePath
    );

    /** @type {string[]} */
    const hostnames = [];
    for (const line of result.stdout.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "") {
            continue;
        }
        const parts = trimmed.split(/\s+/);
        const refName = parts[1] ?? null;
        if (refName === null) {
            continue;
        }
        const hostname = parseHeadsRefHostnameBranch(refName);
        if (hostname !== null) {
            hostnames.push(hostname);
        }
    }

    return [...new Set(hostnames)].sort();
}

/**
 * @param {Capabilities} capabilities
 * @returns {import('express').Router}
 */
function makeRouter(capabilities) {
    const router = express.Router();

    router.post("/sync", async (req, res) => {
        const body = req.body || {};
        const resetToHostname = body.reset_to_hostname;

        if (resetToHostname !== undefined && (typeof resetToHostname !== "string" || !isValidHostname(resetToHostname))) {
            return res.status(400).json({
                error: `Invalid reset_to_hostname value: ${JSON.stringify(resetToHostname)}. Must match [0-9A-Za-z_-]+.`,
            });
        }

        /** @type {{ resetToHostname?: string }} */
        const options = resetToHostname !== undefined ? { resetToHostname } : {};

        capabilities.logger.logDebug(
            { method: req.method, url: req.originalUrl, resetToHostname, client_ip: req.ip },
            "Sync endpoint called"
        );

        synchronizeAll(capabilities, options).catch((error) => {
            capabilities.logger.logError(
                { error, resetToHostname, method: req.method, url: req.originalUrl, client_ip: req.ip },
                "Background sync failed"
            );
        });
        // State is already "running" (set synchronously by procedure's first mutateState call).
        return sendSyncState(res, synchronizeAllExclusiveProcess.getState());
    });

    router.get("/sync", async (_req, res) => {
        return sendSyncState(res, synchronizeAllExclusiveProcess.getState());
    });

    router.get("/sync/hostnames", async (_req, res) => {
        try {
            return res.status(200).json({
                hostnames: await listResetHostnames(capabilities),
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            capabilities.logger.logError({ error }, "Failed to list reset hostnames");
            return res.status(500).json({
                error: `Failed to list reset hostnames: ${message}`,
            });
        }
    });

    return router;
}

module.exports = { makeRouter };
