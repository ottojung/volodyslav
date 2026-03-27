/**
 * Router for live diary questioning endpoints.
 *
 * Endpoints:
 *   POST /diary/live/push-audio
 *
 * Design:
 *   The client sends each successive 10-second audio blob to push-audio.
 *   The server maintains per-session state (last fragment, last window transcript,
 *   running transcript, asked questions) in an in-memory map.
 *
 *   When the server has received at least two consecutive fragments it can form a
 *   20-second window (binary concat of the two fragments), transcribe it, then:
 *     - LLM-recombine with the previous 20-second window transcript, and
 *     - accumulate the result into a running transcript, and
 *     - generate diary questions.
 *
 *   The response always returns { success: true, questions: DiaryQuestion[] }.
 *   questions is an empty array until at least two fragments have been received.
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
const { programmaticRecombination } = require("../ai");

/** @typedef {import('../environment').Environment} Environment */
/** @typedef {import('../logger').Logger} Logger */
/** @typedef {import('../ai/transcription').AITranscription} AITranscription */
/** @typedef {import('../ai/diary_questions').AIDiaryQuestions} AIDiaryQuestions */
/** @typedef {import('../ai/transcript_recombination').AITranscriptRecombination} AITranscriptRecombination */

/**
 * @typedef {object} Capabilities
 * @property {Environment} environment
 * @property {Logger} logger
 * @property {AITranscription} aiTranscription
 * @property {AIDiaryQuestions} aiDiaryQuestions
 * @property {AITranscriptRecombination} aiTranscriptRecombination
 */

/**
 * @typedef {object} SessionState
 * @property {Buffer | null} lastFragment - Audio bytes of the previous 10s fragment.
 * @property {string} lastFragmentMime - MIME type of lastFragment.
 * @property {string} lastWindowTranscript - Transcript of the previous 20s window.
 * @property {string} runningTranscript - Full accumulated transcript for the session.
 * @property {string[]} askedQuestions - All question texts returned to the client so far.
 */

/** @type {Map<string, SessionState>} */
const sessionMap = new Map();

/**
 * Return the session state for a sessionId, creating a fresh one if needed.
 * @param {string} sessionId
 * @returns {SessionState}
 */
function getOrCreateSession(sessionId) {
    let session = sessionMap.get(sessionId);
    if (!session) {
        session = {
            lastFragment: null,
            lastFragmentMime: "audio/webm",
            lastWindowTranscript: "",
            runningTranscript: "",
            askedQuestions: [],
        };
        sessionMap.set(sessionId, session);
    }
    return session;
}

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
 * Write a Buffer to a named temp file, transcribe it, then delete the temp file.
 * Returns the raw transcript string.
 * @param {Buffer} audioBuffer
 * @param {string} mimeType
 * @param {Capabilities} capabilities
 * @returns {Promise<string>}
 */
async function transcribeBuffer(audioBuffer, mimeType, capabilities) {
    const ext = extensionForMime(mimeType);
    const randomHex = crypto.randomBytes(8).toString("hex");
    const tmpFile = path.join(os.tmpdir(), `diary-live-${randomHex}.${ext}`);

    try {
        await fsp.writeFile(tmpFile, audioBuffer);

        const fileStream = fs.createReadStream(tmpFile);

        // Wait for the file to be opened before calling the transcription service.
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

        return result.structured.transcript.trim();
    } finally {
        fsp.unlink(tmpFile).catch(() => {
            // Best-effort cleanup.
        });
    }
}

/**
 * Deduplicate questions by normalised text, keeping the first occurrence.
 * @param {Array<{text: string, intent: string}>} questions
 * @param {string[]} askedTexts
 * @returns {Array<{text: string, intent: string}>}
 */
function deduplicateQuestions(questions, askedTexts) {
    const normalise = (/** @type {string} */ s) =>
        s.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();

    const seen = new Set(askedTexts.map(normalise));
    /** @type {Array<{text: string, intent: string}>} */
    const result = [];
    for (const q of questions) {
        const key = normalise(q.text);
        if (!seen.has(key)) {
            seen.add(key);
            result.push(q);
        }
    }
    return result;
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
     *
     * The server maintains per-session state (in memory).  On the first fragment
     * it stores the audio and returns an empty questions array.  On every subsequent
     * fragment it:
     *   1. Concatenates the stored fragment with the new fragment to form a 20s window.
     *   2. Transcribes the 20s window.
     *   3. LLM-recombines with the previous window transcript (or uses it directly if
     *      none exists yet).
     *   4. Accumulates the merged result into a running transcript.
     *   5. Generates questions from the running transcript.
     *   6. Returns the deduplicated new questions.
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

        const session = getOrCreateSession(sessionId);
        const currentFragment = audioFile.buffer;

        if (session.lastFragment === null) {
            // First fragment: store it and wait for the next one.
            session.lastFragment = currentFragment;
            session.lastFragmentMime = mimeType;
            return res.json({ success: true, questions: [] });
        }

        // We have the previous fragment plus the current one: form a 20s window.
        const window20s = Buffer.concat([session.lastFragment, currentFragment]);

        // Advance the session's stored fragment to the current one for next call.
        session.lastFragment = currentFragment;
        session.lastFragmentMime = mimeType;

        let newWindowTranscript;
        try {
            newWindowTranscript = await transcribeBuffer(window20s, mimeType, capabilities);
        } catch (error) {
            capabilities.logger.logError(
                { sessionId, fragmentNumber, error: error instanceof Error ? error.message : String(error) },
                "Live diary transcription failed"
            );
            return res.json({ success: true, questions: [] });
        }

        if (!newWindowTranscript) {
            // Silent audio — nothing to recombine or question.
            return res.json({ success: true, questions: [] });
        }

        // Recombine with the previous window transcript (LLM-based, with fallback).
        let merged;
        if (session.lastWindowTranscript) {
            try {
                merged = await capabilities.aiTranscriptRecombination.recombineOverlap(
                    session.lastWindowTranscript,
                    newWindowTranscript
                );
            } catch (error) {
                capabilities.logger.logError(
                    { sessionId, error: error instanceof Error ? error.message : String(error) },
                    "Live diary recombination failed; using new window transcript directly"
                );
                merged = newWindowTranscript;
            }
        } else {
            merged = newWindowTranscript;
        }

        session.lastWindowTranscript = newWindowTranscript;

        // Accumulate the merged chunk into the running transcript, removing duplicates
        // at the boundary using the programmatic overlap algorithm.
        session.runningTranscript = session.runningTranscript
            ? programmaticRecombination(session.runningTranscript, merged)
            : merged;

        // Generate questions.
        let allQuestions;
        try {
            allQuestions = await capabilities.aiDiaryQuestions.generateQuestions(
                session.runningTranscript,
                session.askedQuestions
            );
        } catch (error) {
            capabilities.logger.logError(
                { sessionId, error: error instanceof Error ? error.message : String(error) },
                "Live diary question generation failed"
            );
            return res.json({ success: true, questions: [] });
        }

        const newQuestions = deduplicateQuestions(allQuestions, session.askedQuestions);

        // Record all returned question texts to prevent repetition.
        session.askedQuestions = [
            ...session.askedQuestions,
            ...newQuestions.map((q) => q.text),
        ];

        return res.json({ success: true, questions: newQuestions });
    });

    return router;
}

module.exports = { makeRouter };
