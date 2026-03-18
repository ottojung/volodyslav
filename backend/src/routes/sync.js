const express = require("express");
const { synchronizeAll, isSynchronizeAllError } = require("../sync");
const { isValidHostname, parseHeadsRefHostnameBranch } = require("../hostname");

/** @typedef {import('../capabilities/root').Capabilities} Capabilities */

/**
 * @typedef {{ name: string, message: string, causes: string[] }} SyncErrorDetail
 */

/**
 * @typedef {{ message: string, details: SyncErrorDetail[] }} SyncErrorResponse
 */

/**
 * @typedef {{ name: string, status: "success" | "error" }} SyncStepResult
 */

/**
 * @typedef {{ status: "idle" }} IdleSyncState
 */

/**
 * @typedef {{ status: "running", started_at: string, reset_to_hostname?: string, steps: SyncStepResult[] }} RunningSyncState
 */

/**
 * @typedef {{ status: "success", started_at: string, finished_at: string, reset_to_hostname?: string, steps: SyncStepResult[] }} SuccessfulSyncState
 */

/**
 * @typedef {{ status: "error", started_at: string, finished_at: string, reset_to_hostname?: string, error: SyncErrorResponse, steps: SyncStepResult[] }} FailedSyncState
 */

/**
 * @typedef {IdleSyncState | RunningSyncState | SuccessfulSyncState | FailedSyncState} SyncState
 */

/**
 * @param {unknown} error
 * @returns {string[]}
 */
function describeErrorCauses(error) {
    /** @type {string[]} */
    const causes = [];
    let current = error;

    while (current !== undefined) {
        if (current instanceof Error) {
            causes.push(current.message);
            current = "cause" in current ? current.cause : undefined;
            continue;
        }

        causes.push(String(current));
        break;
    }

    return causes;
}

/**
 * @param {unknown} error
 * @returns {SyncErrorResponse}
 */
function makeSyncErrorResponse(error) {
    if (isSynchronizeAllError(error)) {
        const details = error.errors.map((entry) => ({
            name: entry.name,
            message: entry.message,
            causes: describeErrorCauses(entry.cause),
        }));
        return {
            message: `Sync failed: ${details.map((entry) => entry.message).join("; ")}`,
            details,
        };
    }

    const message = error instanceof Error ? error.message : String(error);
    return {
        message: `Sync failed: ${message}`,
        details: [
            {
                name: error instanceof Error ? error.name : "Error",
                message,
                causes: error instanceof Error && "cause" in error
                    ? describeErrorCauses(error.cause)
                    : [],
            },
        ],
    };
}

/**
 * @param {Capabilities} capabilities
 * @returns {{ getState: () => SyncState, start: (options: { resetToHostname?: string }) => SyncState }}
 */
function makeSyncController(capabilities) {
    /** @type {SyncState} */
    let currentState = { status: "idle" };

    /**
     * @param {{ resetToHostname?: string }} options
     * @returns {SyncState}
     */
    function start(options) {
        if (currentState.status === "running") {
            return currentState;
        }

        const started_at = capabilities.datetime.now().toISOString();
        const runningHostname = capabilities.environment.hostname();
        const reset_to_hostname = options.resetToHostname;

        /** @type {RunningSyncState} */
        const runningState = { status: "running", started_at, reset_to_hostname, steps: [] };
        currentState = runningState;

        capabilities.logger.logInfo(
            { started_at, reset_to_hostname, runningHostname },
            "Sync started in background"
        );

        /** @param {SyncStepResult} step */
        const onStepComplete = (step) => {
            if (currentState === runningState) {
                runningState.steps.push(step);
            }
        };

        void synchronizeAll(capabilities, options, onStepComplete)
            .then(() => {
                if (currentState !== runningState) {
                    return;
                }

                const finished_at = capabilities.datetime.now().toISOString();
                currentState = {
                    status: "success",
                    started_at,
                    finished_at,
                    reset_to_hostname,
                    steps: runningState.steps,
                };
                capabilities.logger.logInfo(
                    { started_at, finished_at, reset_to_hostname, runningHostname },
                    "Sync finished successfully"
                );
            })
            .catch((error) => {
                if (currentState !== runningState) {
                    return;
                }

                const finished_at = capabilities.datetime.now().toISOString();
                const syncError = makeSyncErrorResponse(error);
                currentState = {
                    status: "error",
                    started_at,
                    finished_at,
                    reset_to_hostname,
                    error: syncError,
                    steps: runningState.steps,
                };
                capabilities.logger.logError(
                    { error: syncError.message, details: syncError.details },
                    "Errors during synchronization"
                );
            });

        return currentState;
    }

    return {
        getState: () => currentState,
        start,
    };
}

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
    const syncController = makeSyncController(capabilities);

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

        return sendSyncState(res, syncController.start(options));
    });

    router.get("/sync", async (_req, res) => {
        return sendSyncState(res, syncController.getState());
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
