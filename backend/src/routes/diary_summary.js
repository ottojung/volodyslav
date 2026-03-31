const express = require("express");
const { runDiarySummaryPipeline } = require("../jobs");

/** @typedef {import('../capabilities/root').Capabilities} Capabilities */
/** @typedef {import('../generators/incremental_graph/database/types').DiaryMostImportantInfoSummaryEntry} DiaryMostImportantInfoSummaryEntry */

/**
 * @typedef {{ path: string, status: "pending" | "success" | "error" }} DiarySummaryRunEntry
 */

/**
 * @typedef {{ status: "idle" }} IdleDiarySummaryRunState
 */

/**
 * @typedef {{ status: "running", started_at: string, entries: DiarySummaryRunEntry[] }} RunningDiarySummaryRunState
 */

/**
 * @typedef {{ status: "success", started_at: string, finished_at: string, entries: DiarySummaryRunEntry[], summary: DiaryMostImportantInfoSummaryEntry }} SuccessfulDiarySummaryRunState
 */

/**
 * @typedef {{ status: "error", started_at: string, finished_at: string, entries: DiarySummaryRunEntry[], error: string }} FailedDiarySummaryRunState
 */

/**
 * @typedef {IdleDiarySummaryRunState | RunningDiarySummaryRunState | SuccessfulDiarySummaryRunState | FailedDiarySummaryRunState} DiarySummaryRunState
 */

/**
 * Creates a controller that manages the background diary summary pipeline run.
 * @param {Capabilities} capabilities
 * @returns {{ getState: () => DiarySummaryRunState, start: () => DiarySummaryRunState }}
 */
function makeDiarySummaryController(capabilities) {
    /** @type {DiarySummaryRunState} */
    let currentState = { status: "idle" };

    /**
     * @returns {DiarySummaryRunState}
     */
    function start() {
        if (currentState.status === "running") {
            return currentState;
        }

        const started_at = capabilities.datetime.now().toISOString();

        /** @type {RunningDiarySummaryRunState} */
        const runningState = { status: "running", started_at, entries: [] };
        currentState = runningState;

        capabilities.logger.logInfo(
            { started_at },
            "Diary summary pipeline started in background"
        );

        /** @param {string} path */
        const onEntryQueued = (path) => {
            if (currentState === runningState) {
                runningState.entries.push({ path, status: "pending" });
            }
        };

        /**
         * @param {string} path
         * @param {"success" | "error"} status
         */
        const onEntryProcessed = (path, status) => {
            if (currentState === runningState) {
                const entry = runningState.entries.find((e) => e.path === path && e.status === "pending");
                if (entry !== undefined) {
                    entry.status = status;
                }
            }
        };

        void runDiarySummaryPipeline(capabilities, { onEntryQueued, onEntryProcessed })
            .then((summary) => {
                if (currentState !== runningState) {
                    return;
                }

                const finished_at = capabilities.datetime.now().toISOString();
                currentState = {
                    status: "success",
                    started_at,
                    finished_at,
                    entries: runningState.entries,
                    summary,
                };
                capabilities.logger.logInfo(
                    { started_at, finished_at },
                    "Diary summary pipeline finished successfully"
                );
            })
            .catch((error) => {
                if (currentState !== runningState) {
                    return;
                }

                const finished_at = capabilities.datetime.now().toISOString();
                const errorMessage = error instanceof Error ? error.message : String(error);
                currentState = {
                    status: "error",
                    started_at,
                    finished_at,
                    entries: runningState.entries,
                    error: errorMessage,
                };
                capabilities.logger.logError(
                    { error: errorMessage },
                    "Diary summary pipeline failed"
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
 * @param {DiarySummaryRunState} state
 */
function sendDiarySummaryRunState(res, state) {
    if (state.status === "running") {
        return res.status(202).json(state);
    }

    if (state.status === "error") {
        return res.status(500).json(state);
    }

    return res.status(200).json(state);
}

/**
 * Handles GET /diary-summary — returns current summary node value.
 * @param {Capabilities} capabilities
 * @param {import('express').Request} _req
 * @param {import('express').Response} res
 */
async function handleGetDiarySummary(capabilities, _req, res) {
    if (!capabilities.interface.isInitialized()) {
        res.status(503).json({ error: "Graph not initialized" });
        return;
    }

    try {
        const summary = await capabilities.interface.getDiarySummary();
        res.json(summary);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        capabilities.logger.logError({ error, errorMessage }, "Failed to get diary summary");
        res.status(500).json({ error: "Internal server error" });
    }
}

/**
 * @param {Capabilities} capabilities
 * @returns {import('express').Router}
 */
function makeRouter(capabilities) {
    const router = express.Router();
    const controller = makeDiarySummaryController(capabilities);

    router.get("/diary-summary", async (req, res) => {
        await handleGetDiarySummary(capabilities, req, res);
    });

    router.post("/diary-summary/run", async (_req, res) => {
        if (!capabilities.interface.isInitialized()) {
            res.status(503).json({ error: "Graph not initialized" });
            return;
        }

        return sendDiarySummaryRunState(res, controller.start());
    });

    router.get("/diary-summary/run", async (_req, res) => {
        return sendDiarySummaryRunState(res, controller.getState());
    });

    return router;
}

module.exports = { makeRouter };
