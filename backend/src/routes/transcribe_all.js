const express = require("express");
const { fromRequest } = require("../request_identifier");
const { transcribeAllRequest, InputDirectoryAccess } = require("../transcribe_all");

/** @typedef {import('../filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('../filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('../filesystem/dirscanner').DirScanner} DirScanner */
/** @typedef {import('../filesystem/writer').FileWriter} FileWriter */
/** @typedef {import('../random/seed').NonDeterministicSeed} NonDeterministicSeed */
/** @typedef {import('../subprocess/command').Command} Command */
/** @typedef {import('../environment').Environment} Environment */
/** @typedef {import('../logger').Logger} Logger */
/** @typedef {import('../ai/transcription').AITranscription} AITranscription */

/**
 * @typedef {object} Capabilities
 * @property {FileCreator} creator
 * @property {FileChecker} checker
 * @property {DirScanner} scanner
 * @property {FileWriter} writer
 * @property {NonDeterministicSeed} seed
 * @property {Command} git
 * @property {Environment} environment - An environment instance.
 * @property {Logger} logger - A logger instance.
 * @property {AITranscription} aiTranscription - An AI transcription instance.
 */

/**
 * Handles the batch transcription request.
 * @param {Capabilities} capabilities
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function handleTranscribeAllRequest(capabilities, req, res) {
    let reqId;
    try {
        reqId = fromRequest(req);
    } catch {
        capabilities.logger.logError(
            {
                error: "Missing request identifier",
                path: req.path,
                query: req.query,
                headers: req.headers,
            },
            "Batch transcription request failed - invalid request identifier"
        );
        return res.status(400).json({
            success: false,
            error: "Missing request_identifier parameter",
        });
    }

    /** @type {any} */
    const query = req.query;
    const rawDir = query["input_dir"];
    capabilities.logger.logInfo(
        {
            request_identifier: reqId.identifier,
            input_dir: rawDir,
            client_ip: req.ip,
            user_agent: req.get("user-agent"),
        },
        "Batch transcription request received"
    );
    if (!rawDir) {
        capabilities.logger.logError(
            {
                request_identifier: reqId.identifier,
                error: "Missing input_dir parameter",
                query: req.query,
            },
            "Batch transcription request failed - missing input_dir"
        );
        return res.status(400).json({
            success: false,
            error: "Please provide the input_dir parameter",
        });
    }

    const inputDir = String(rawDir);
    try {
        const result = await transcribeAllRequest(
            capabilities,
            inputDir,
            reqId
        );
        if (result.failures.length > 0) {
            capabilities.logger.logError(
                {
                    request_identifier: reqId.identifier,
                    result,
                    input_dir: inputDir,
                },
                "Batch transcription completed with failures"
            );
            return res
                .status(500) // Using 500 for partial failure, or 207 Multi-Status if more appropriate
                .json({ success: false, result });
        }
        capabilities.logger.logInfo(
            { request_identifier: reqId.identifier, result, input_dir: inputDir },
            "Batch transcription successful"
        );
        return res.json({ success: true, result });
    } catch (/** @type {unknown} */ error) {
        if (error instanceof InputDirectoryAccess) {
            capabilities.logger.logError(
                {
                    request_identifier: reqId.identifier,
                    error: error.message,
                    input_dir: inputDir,
                    error_stack: error.stack,
                },
                "Batch transcription failed - input directory access issue"
            );
            return res
                .status(404)
                .json({ success: false, error: error.message });
        }
        // Catch-all for other errors
        capabilities.logger.logError(
            {
                request_identifier: reqId.identifier,
                error:
                    error instanceof Object && "message" in error
                        ? String(error.message)
                        : String(error),
                error_name: error instanceof Error ? error.name : "Unknown",
                error_stack: error instanceof Error ? error.stack : undefined,
                input_dir: inputDir,
            },
            "Batch transcription failed - internal error"
        );
        return res.status(500).json({
            success: false,
            error: "Internal server error during batch transcription",
        });
    }
}

/**
 * @param {Capabilities} capabilities
 * @returns {import('express').Router}
 */
function makeRouter(capabilities) {
    const router = express.Router();

    /**
     * Batch transcription endpoint.
     * Query params:
     *    ?input_dir=/absolute/path/to/directory
     *    &request_identifier=0x123
     */
    router.get("/transcribe_all", async (req, res) =>
        await handleTranscribeAllRequest(capabilities, req, res)
    );

    return router;
}

module.exports = { makeRouter };
