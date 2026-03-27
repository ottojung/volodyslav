/**
 * Router for live diary questioning endpoints.
 *
 * Endpoints:
 *   POST /diary/live/transcribe-window
 *   POST /diary/live/generate-questions
 *
 * @module routes/diary_live
 */

const express = require("express");
const multer = require("multer");
const os = require("os");
const path = require("path");
const fsp = require("fs/promises");
const fs = require("fs");
const crypto = require("crypto");

/** @typedef {import('../environment').Environment} Environment */
/** @typedef {import('../logger').Logger} Logger */
/** @typedef {import('../ai/transcription').AITranscription} AITranscription */
/** @typedef {import('../ai/diary_questions').AIDiaryQuestions} AIDiaryQuestions */

/**
 * @typedef {object} Capabilities
 * @property {Environment} environment
 * @property {Logger} logger
 * @property {AITranscription} aiTranscription
 * @property {AIDiaryQuestions} aiDiaryQuestions
 */

/** Supported audio MIME types and their extensions. */
/** @type {Record<string, string>} */
const EXTENSION_BY_MIME = {
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "audio/wave": "wav",
    "audio/x-wav": "wav",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/flac": "flac",
};

/**
 * Returns the file extension for a MIME type, defaulting to "webm".
 * @param {string} mimeType
 * @returns {string}
 */
function extensionForMime(mimeType) {
    const base = (mimeType.split(";")[0] || "").trim().toLowerCase();
    return EXTENSION_BY_MIME[base] || "webm";
}

/**
 * Validates that the value is a non-negative finite integer.
 * @param {unknown} value
 * @returns {value is number}
 */
function isNonNegativeInteger(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && Math.floor(value) === value;
}

/**
 * Parses an integer from a string. Returns null on failure.
 * @param {unknown} value
 * @returns {number | null}
 */
function parseIntegerField(value) {
    if (typeof value !== "string" || value.trim() === "") {
        return null;
    }
    const n = Number(value);
    if (!Number.isFinite(n) || Math.floor(n) !== n) {
        return null;
    }
    return n;
}

/**
 * @param {Capabilities} capabilities
 * @returns {import('express').Router}
 */
function makeRouter(capabilities) {
    const router = express.Router();
    const upload = multer({ storage: multer.memoryStorage() });

    /**
     * POST /diary/live/transcribe-window
     *
     * Multipart form fields:
     *   audio          - binary audio file (required)
     *   mimeType       - MIME type string (required)
     *   sessionId      - string session identifier (required)
     *   milestoneNumber - integer (required)
     *   windowStartMs  - integer ms (required)
     *   windowEndMs    - integer ms (required)
     *
     * Response:
     *   { success: true, milestoneNumber, windowStartMs, windowEndMs, tokens, rawText }
     */
    router.post("/diary/live/transcribe-window", upload.single("audio"), async (req, res) => {
        const audioFile = req.file;
        if (!audioFile) {
            return res.status(400).json({ success: false, error: "Missing audio file" });
        }

        const { mimeType, sessionId, milestoneNumber: milestoneNumberRaw, windowStartMs: windowStartMsRaw, windowEndMs: windowEndMsRaw } = req.body || {};

        if (typeof sessionId !== "string" || !sessionId) {
            return res.status(400).json({ success: false, error: "Missing or invalid sessionId" });
        }

        if (typeof mimeType !== "string" || !mimeType) {
            return res.status(400).json({ success: false, error: "Missing or invalid mimeType" });
        }

        const milestoneNumber = parseIntegerField(milestoneNumberRaw);
        if (milestoneNumber === null || milestoneNumber < 1) {
            return res.status(400).json({ success: false, error: "Missing or invalid milestoneNumber" });
        }

        const windowStartMs = parseIntegerField(windowStartMsRaw);
        if (windowStartMs === null || !isNonNegativeInteger(windowStartMs)) {
            return res.status(400).json({ success: false, error: "Missing or invalid windowStartMs" });
        }

        const windowEndMs = parseIntegerField(windowEndMsRaw);
        if (windowEndMs === null || !isNonNegativeInteger(windowEndMs) || windowEndMs <= windowStartMs) {
            return res.status(400).json({ success: false, error: "Missing or invalid windowEndMs" });
        }

        capabilities.logger.logInfo(
            { sessionId, milestoneNumber, windowStartMs, windowEndMs },
            "Live diary transcription window requested"
        );

        // Write audio buffer to a temporary file with a random name (no user data in path).
        // The transcription service requires a named file stream, so we cannot use in-memory streams.
        const ext = extensionForMime(mimeType);
        const randomHex = crypto.randomBytes(8).toString("hex");
        const tmpFile = path.join(os.tmpdir(), `diary-live-${randomHex}.${ext}`);

        try {
            await fsp.writeFile(tmpFile, audioFile.buffer);
        } catch (error) {
            capabilities.logger.logError(
                { error: error instanceof Error ? error.message : String(error) },
                "Failed to write temporary audio file for live transcription"
            );
            return res.status(500).json({ success: false, error: "Failed to process audio file" });
        }

        try {
            const fileStream = fs.createReadStream(tmpFile);

            // Wait for the file to be opened before calling the transcription service.
            // This prevents a race between the stream's async open and cleanup (unlink).
            await new Promise((resolve, reject) => {
                fileStream.once("open", resolve);
                fileStream.once("error", reject);
            });

            let result;
            try {
                result = await capabilities.aiTranscription.transcribeStreamDetailed(fileStream);
            } finally {
                fileStream.destroy();
            }

            const rawText = result.structured.transcript;

            // Approximate per-word tokens across the window.
            // The transcription service does not provide per-word timestamps, so we
            // distribute the window duration evenly across words.  Fine-grained tokens
            // allow the replace-zone merge to preserve content outside the current
            // window when milestones overlap.
            const trimmedText = rawText.trim();

            /** @type {Array<{text: string, startMs: number, endMs: number}>} */
            const tokens = [];

            if (trimmedText) {
                const words = trimmedText.split(/\s+/);
                const wordCount = words.length;
                const windowDuration = Math.max(0, windowEndMs - windowStartMs);
                const durationPerWord = wordCount > 0 ? windowDuration / wordCount : 0;

                let currentStart = windowStartMs;
                for (let i = 0; i < wordCount; i += 1) {
                    const isLast = i === wordCount - 1;
                    const currentEnd = isLast
                        ? windowEndMs
                        : windowStartMs + Math.round(durationPerWord * (i + 1));

                    tokens.push({
                        text: words[i] ?? "",
                        startMs: currentStart,
                        endMs: currentEnd,
                    });

                    currentStart = currentEnd;
                }
            }

            return res.json({
                success: true,
                milestoneNumber,
                windowStartMs,
                windowEndMs,
                tokens,
                rawText,
            });
        } catch (error) {
            capabilities.logger.logError(
                {
                    sessionId,
                    milestoneNumber,
                    error: error instanceof Error ? error.message : String(error),
                },
                "Live diary transcription failed"
            );
            return res.status(500).json({ success: false, error: "Transcription failed" });
        } finally {
            fsp.unlink(tmpFile).catch(() => {
                // Best-effort cleanup
            });
        }
    });

    /**
     * POST /diary/live/generate-questions
     *
     * JSON body:
     *   sessionId       - string (required)
     *   milestoneNumber - integer (required)
     *   transcriptSoFar - string (required)
     *   askedQuestions  - string[] (required)
     *
     * Response:
     *   { success: true, milestoneNumber, questions: [{text, intent}] }
     */
    router.post("/diary/live/generate-questions", express.json(), async (req, res) => {
        const { sessionId, milestoneNumber: milestoneNumberRaw, transcriptSoFar, askedQuestions } = req.body || {};

        if (typeof sessionId !== "string" || !sessionId) {
            return res.status(400).json({ success: false, error: "Missing or invalid sessionId" });
        }

        if (typeof milestoneNumberRaw !== "number" || !Number.isFinite(milestoneNumberRaw) || milestoneNumberRaw < 1) {
            return res.status(400).json({ success: false, error: "Missing or invalid milestoneNumber" });
        }

        const milestoneNumber = milestoneNumberRaw;

        if (typeof transcriptSoFar !== "string") {
            return res.status(400).json({ success: false, error: "Missing or invalid transcriptSoFar" });
        }

        if (!Array.isArray(askedQuestions) || askedQuestions.some((q) => typeof q !== "string")) {
            return res.status(400).json({ success: false, error: "Missing or invalid askedQuestions: must be a string array" });
        }

        capabilities.logger.logInfo(
            { sessionId, milestoneNumber, transcriptLength: transcriptSoFar.length, askedCount: askedQuestions.length },
            "Live diary question generation requested"
        );

        try {
            const questions = await capabilities.aiDiaryQuestions.generateQuestions(transcriptSoFar, askedQuestions);
            return res.json({
                success: true,
                milestoneNumber,
                questions,
            });
        } catch (error) {
            capabilities.logger.logError(
                {
                    sessionId,
                    milestoneNumber,
                    error: error instanceof Error ? error.message : String(error),
                },
                "Live diary question generation failed"
            );
            return res.status(500).json({ success: false, error: "Question generation failed" });
        }
    });

    return router;
}

module.exports = { makeRouter };
