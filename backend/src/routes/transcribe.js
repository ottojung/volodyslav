const express = require("express");
const { fromRequest } = require("../request_identifier");
const { transcribeRequest, isInputNotFound } = require("../transcribe");

/** @typedef {import('../logger').Logger} Logger */
/** @typedef {import('../filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('../filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('../filesystem/writer').FileWriter} FileWriter */
/** @typedef {import('../random/seed').NonDeterministicSeed} NonDeterministicSeed */
/** @typedef {import('../subprocess/command').Command} Command */
/** @typedef {import('../environment').Environment} Environment */
/** @typedef {import('../ai/transcription').AITranscription} AITranscription */

/**
 * @typedef {object} Capabilities
 * @property {FileCreator} creator - A directory creator instance.
 * @property {FileChecker} checker - A file system checker instance.
 * @property {FileWriter} writer - A file writer instance.
 * @property {NonDeterministicSeed} seed - A random number generator instance.
 * @property {Command} git - A command instance for Git operations (optional if not always used).
 * @property {Environment} environment - An environment instance.
 * @property {Logger} logger - A logger instance.
 * @property {AITranscription} aiTranscription - An AI transcription instance.
 */

/**
 * Handles the transcription request.
 * @param {Capabilities} capabilities
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function handleTranscribeRequest(capabilities, req, res) {
    // pull request_identifier and validate
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
            "Transcription request failed - invalid request identifier"
        );
        return res
            .status(400)
            .json({
                success: false,
                error: "Missing request_identifier parameter",
            });
    }

    // pull input and output params
    /** @type {any} */
    const query = req.query;
    const rawIn = query["input"];
    // Log the transcription request
    capabilities.logger.logInfo(
        {
            request_identifier: reqId.identifier,
            input: rawIn,
            client_ip: req.ip,
            user_agent: req.get("user-agent"),
        },
        "Transcription request received"
    );

    if (!rawIn) {
        capabilities.logger.logError(
            {
                request_identifier: reqId.identifier,
                error: "Missing input parameter",
                query: req.query,
            },
            "Transcription request failed - missing input"
        );
        return res
            .status(400)
            .json({
                success: false,
                error: "Please provide the input parameter",
            });
    }

    // normalize input and determine paths
    const inputPath = String(rawIn);
    try {
        await transcribeRequest(capabilities, inputPath, reqId);
        // If successful, send a 200 OK response
        return res.status(200).json({ success: true });
    } catch (error) {
        if (isInputNotFound(error)) {
            capabilities.logger.logError(
                {
                    request_identifier: reqId.identifier,
                    error: "Input file not found",
                    input_path: inputPath,
                    error_details: error.message,
                },
                "Transcription request failed - file not found"
            );
            return res
                .status(404)
                .json({ success: false, error: "Input file not found" });
        } else {
            capabilities.logger.logError(
                {
                    request_identifier: reqId.identifier,
                    error:
                        error instanceof Object && "message" in error
                            ? String(error.message)
                            : String(error),
                    error_name: error instanceof Error ? error.name : "Unknown",
                    error_stack:
                        error instanceof Error ? error.stack : undefined,
                    input_path: inputPath,
                },
                "Transcription request failed - internal error"
            );
            return res
                .status(500)
                .json({
                    success: false,
                    error: "Internal server error during transcription",
                });
        }
    }
}

/**
 * @param {Capabilities} capabilities
 * @returns {import('express').Router}
 */
function makeRouter(capabilities) {
    const router = express.Router();

    /**
     * Query params:
     *    ?input=/absolute/path/to/file.wav
     *    &request_identifier=0x123
     */
    router.get("/transcribe", async (req, res) =>
        await handleTranscribeRequest(capabilities, req, res)
    );

    return router;
}

module.exports = { makeRouter };
