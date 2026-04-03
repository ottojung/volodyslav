const express = require("express");
const { runDiarySummaryPipeline, diarySummaryExclusiveProcess } = require("../jobs");

/** @typedef {import('../capabilities/root').Capabilities} Capabilities */
/** @typedef {import('../generators/incremental_graph/database/types').DiaryMostImportantInfoSummaryEntry} DiaryMostImportantInfoSummaryEntry */
/** @typedef {import('../jobs/diary_summary').DiarySummaryRunState} DiarySummaryRunState */

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

    router.get("/diary-summary", async (req, res) => {
        await handleGetDiarySummary(capabilities, req, res);
    });

    router.post("/diary-summary/run", async (_req, res) => {
        if (!capabilities.interface.isInitialized()) {
            res.status(503).json({ error: "Graph not initialized" });
            return;
        }

        const currentHostname = capabilities.environment.hostname();
        const analyzerHostname = capabilities.environment.analyzerHostname();
        if (currentHostname !== analyzerHostname) {
            res.status(503).json({
                error: "not_analyzer",
                currentHostname,
                analyzerHostname,
            });
            return;
        }

        diarySummaryExclusiveProcess.invoke({ capabilities });
        // State is already "running" (set synchronously by procedure's first mutateState call).
        return sendDiarySummaryRunState(res, diarySummaryExclusiveProcess.getState());
    });

    router.get("/diary-summary/run", async (_req, res) => {
        return sendDiarySummaryRunState(res, diarySummaryExclusiveProcess.getState());
    });

    return router;
}

module.exports = { makeRouter };
