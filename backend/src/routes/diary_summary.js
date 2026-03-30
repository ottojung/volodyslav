const express = require("express");
const { runDiarySummaryPipeline } = require("../jobs");

/** @typedef {import('../capabilities/root').Capabilities} Capabilities */

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
        const msg = error instanceof Error ? error.message : String(error);
        capabilities.logger.logError({ error: msg }, "Failed to get diary summary");
        res.status(500).json({ error: msg });
    }
}

/**
 * Handles POST /diary-summary/run — runs the summarizer pipeline and returns updated summary.
 * @param {Capabilities} capabilities
 * @param {import('express').Request} _req
 * @param {import('express').Response} res
 */
async function handleRunDiarySummary(capabilities, _req, res) {
    if (!capabilities.interface.isInitialized()) {
        res.status(503).json({ error: "Graph not initialized" });
        return;
    }

    try {
        const summary = await runDiarySummaryPipeline(capabilities);
        res.json(summary);
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        capabilities.logger.logError({ error: msg }, "Failed to run diary summary pipeline");
        res.status(500).json({ error: msg });
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

    router.post("/diary-summary/run", async (req, res) => {
        await handleRunDiarySummary(capabilities, req, res);
    });

    return router;
}

module.exports = { makeRouter };
