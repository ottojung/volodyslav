/**
 * Router for live diary questioning endpoints.
 *
 * Endpoints:
 *   POST /diary/live/push-audio
 *
 * This module contains only HTTP-wrapping / unwrapping logic.
 * All business logic is handled by the live_diary service module.
 *
 * @module routes/diary_live
 */

const express = require("express");
const multer = require("multer");
const { pushAudio } = require("../live_diary");

/** @typedef {import('../environment').Environment} Environment */
/** @typedef {import('../logger').Logger} Logger */
/** @typedef {import('../temporary').Temporary} Temporary */
/** @typedef {import('../ai/transcription').AITranscription} AITranscription */
/** @typedef {import('../ai/diary_questions').AIDiaryQuestions} AIDiaryQuestions */
/** @typedef {import('../ai/transcript_recombination').AITranscriptRecombination} AITranscriptRecombination */

/**
 * @typedef {object} Capabilities
 * @property {Environment} environment
 * @property {Logger} logger
 * @property {Temporary} temporary
 * @property {AITranscription} aiTranscription
 * @property {AIDiaryQuestions} aiDiaryQuestions
 * @property {AITranscriptRecombination} aiTranscriptRecombination
 */

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
     * POST /diary/live/push-audio
     *
     * Multipart form fields:
     *   audio          - binary 10-second audio blob (required)
     *   mimeType       - MIME type string (required)
     *   sessionId      - string session identifier (required)
     *   fragmentNumber - integer sequence number, 1-based (required)
     *
     * Response:
     *   { success: true, questions: Array<{text: string, intent: string}> }
     */
    router.post("/diary/live/push-audio", upload.single("audio"), async (req, res) => {
        const audioFile = req.file;
        if (!audioFile) {
            return res.status(400).json({ success: false, error: "Missing audio file" });
        }

        const { mimeType, sessionId, fragmentNumber: fragmentNumberRaw } = req.body || {};

        if (typeof sessionId !== "string" || !sessionId) {
            return res.status(400).json({ success: false, error: "Missing or invalid sessionId" });
        }

        if (typeof mimeType !== "string" || !mimeType) {
            return res.status(400).json({ success: false, error: "Missing or invalid mimeType" });
        }

        const fragmentNumber = parseIntegerField(fragmentNumberRaw);
        if (fragmentNumber === null || fragmentNumber < 1) {
            return res.status(400).json({ success: false, error: "Missing or invalid fragmentNumber" });
        }

        capabilities.logger.logInfo(
            { sessionId, fragmentNumber },
            "Live diary push-audio received"
        );

        const questions = await pushAudio(
            capabilities,
            sessionId,
            audioFile.buffer,
            mimeType,
            fragmentNumber
        );

        return res.json({ success: true, questions });
    });

    return router;
}

module.exports = { makeRouter };
