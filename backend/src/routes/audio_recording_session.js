/**
 * Router for audio recording session endpoints.
 *
 * Endpoints:
 *   POST   /audio-recording-session/start
 *   POST   /audio-recording-session/:sessionId/chunks
 *   GET    /audio-recording-session/:sessionId
 *   POST   /audio-recording-session/:sessionId/stop
 *   GET    /audio-recording-session/:sessionId/final-audio
 *   DELETE /audio-recording-session/:sessionId
 *
 * @module routes/audio_recording_session
 */

const express = require("express");
const multer = require("multer");
const {
    startSession,
    uploadChunk,
    getSession,
    stopSession,
    fetchFinalAudio,
    discardSession,
    isAudioSessionNotFoundError,
    isAudioSessionChunkValidationError,
    isAudioSessionConflictError,
    isAudioSessionFinalizeError,
} = require("../audio_recording_session");
const { pushAudio: pushLiveDiaryAudio } = require("../live_diary");

/** @typedef {import('../environment').Environment} Environment */
/** @typedef {import('../logger').Logger} Logger */
/** @typedef {import('../temporary').Temporary} Temporary */
/** @typedef {import('../datetime').Datetime} Datetime */
/** @typedef {import('../ai/transcription').AITranscription} AITranscription */
/** @typedef {import('../ai/diary_questions').AIDiaryQuestions} AIDiaryQuestions */
/** @typedef {import('../ai/transcript_recombination').AITranscriptRecombination} AITranscriptRecombination */

/**
 * @typedef {object} Capabilities
 * @property {Environment} environment
 * @property {Logger} logger
 * @property {Temporary} temporary
 * @property {Datetime} datetime
 * @property {AITranscription} aiTranscription
 * @property {AIDiaryQuestions} aiDiaryQuestions
 * @property {AITranscriptRecombination} aiTranscriptRecombination
 */

/**
 * Validate and normalize a MIME type.
 * Accepts only audio/* types; strips parameter suffixes (e.g., "; codecs=vp9").
 * Returns the normalized type string, or null if invalid.
 * Shape-only check: ensures client and server agree on the expected format.
 * @param {unknown} mimeType
 * @returns {string | null}
 */
function parseAudioMimeType(mimeType) {
    if (typeof mimeType !== "string" || !mimeType) {
        return null;
    }
    // Strip parameters (everything after the first semicolon) and normalize case.
    const base = (mimeType.split(";")[0] || "").trim().toLowerCase();
    const match = /^audio\/([^\s;]+)$/.exec(base);
    if (!match) {
        return null;
    }
    return `audio/${match[1]}`;
}

/**
 * @param {Capabilities} capabilities
 * @returns {import('express').Router}
 */
function makeRouter(capabilities) {
    const router = express.Router();
    const upload = multer({
        storage: multer.memoryStorage(),
    });

    // POST /audio-recording-session/start
    router.post("/audio-recording-session/start", express.json(), async (req, res) => {
        const { sessionId, mimeType } = req.body || {};

        if (typeof sessionId !== "string" || !sessionId) {
            return res.status(400).json({ success: false, error: "Missing or invalid sessionId" });
        }
        const normalizedMimeType = parseAudioMimeType(mimeType);
        if (normalizedMimeType !== "audio/webm") {
            return res.status(400).json({ success: false, error: "Missing or invalid mimeType: must be audio/webm" });
        }

        try {
            const session = await startSession(capabilities, sessionId, normalizedMimeType);
            return res.json({
                success: true,
                session: {
                    sessionId: session.sessionId,
                    status: session.status,
                    createdAt: session.createdAt,
                    fragmentCount: session.fragmentCount,
                },
            });
        } catch (error) {
            if (isAudioSessionChunkValidationError(error)) {
                return res.status(400).json({ success: false, error: error.message });
            }
            capabilities.logger.logError(
                { error: error instanceof Error ? error.message : String(error) },
                "Failed to start audio session"
            );
            return res.status(500).json({ success: false, error: "Internal error" });
        }
    });

    // POST /audio-recording-session/:sessionId/chunks
    router.post(
        "/audio-recording-session/:sessionId/chunks",
        upload.single("chunk"),
        async (req, res) => {
            const { sessionId } = req.params;
            if (!sessionId) {
                return res.status(400).json({ success: false, error: "Missing session ID" });
            }
            const { startMs, endMs, sequence, mimeType } = req.body || {};
            const chunkFile = req.file;

            if (!chunkFile) {
                return res.status(400).json({ success: false, error: "Missing chunk file" });
            }

            // Accept only plain base-10 non-negative integer strings for sequence
            // and plain non-negative numeric strings for startMs/endMs.
            // This rejects scientific notation ("1e3"), empty strings, and floats for sequence.
            // Sequence is limited to 6 digits to stay compatible with 6-digit zero-padding
            // and lexicographic sort order used when concatenating chunks.
            const UINT_RE = /^\d{1,6}$/;
            const UFLOAT_RE = /^\d+(\.\d+)?$/;

            if (
                typeof startMs !== "string" ||
                typeof endMs !== "string" ||
                typeof sequence !== "string" ||
                !UFLOAT_RE.test(startMs) ||
                !UFLOAT_RE.test(endMs) ||
                !UINT_RE.test(sequence)
            ) {
                return res.status(400).json({ success: false, error: "Invalid startMs, endMs, or sequence" });
            }

            const startMsNum = Number(startMs);
            const endMsNum = Number(endMs);
            const sequenceNum = Number(sequence);

            // Normalize mimeType: audio/webm is required for safe chunk assembly.
            const rawMimeType = typeof mimeType === "string" ? mimeType : String(chunkFile.mimetype || "");
            const normalizedChunkMimeType = parseAudioMimeType(rawMimeType);
            if (normalizedChunkMimeType !== "audio/webm") {
                return res.status(400).json({ success: false, error: "Missing or invalid mimeType: must be audio/webm" });
            }

            try {
                const result = await uploadChunk(capabilities, sessionId, {
                    chunk: chunkFile.buffer,
                    startMs: startMsNum,
                    endMs: endMsNum,
                    sequence: sequenceNum,
                    mimeType: normalizedChunkMimeType,
                });

                // Best-effort: invoke live diary questioning pipeline.
                // Fragment number is 1-based (sequence is 0-based).
                let liveQuestions = [];
                try {
                    const liveResult = await pushLiveDiaryAudio(
                        capabilities,
                        sessionId,
                        chunkFile.buffer,
                        normalizedChunkMimeType,
                        sequenceNum + 1
                    );
                    liveQuestions = liveResult.questions;
                } catch {
                    // Live questioning failure is non-fatal; chunk is stored successfully.
                }

                return res.json({ success: true, ...result, questions: liveQuestions });
            } catch (error) {
                if (isAudioSessionChunkValidationError(error)) {
                    return res.status(400).json({ success: false, error: error.message });
                }
                if (isAudioSessionNotFoundError(error)) {
                    return res.status(404).json({ success: false, error: error.message });
                }
                if (isAudioSessionConflictError(error)) {
                    return res.status(409).json({ success: false, error: error.message });
                }
                capabilities.logger.logError(
                    { error: error instanceof Error ? error.message : String(error) },
                    "Failed to upload audio chunk"
                );
                return res.status(500).json({ success: false, error: "Internal error" });
            }
        }
    );

    // GET /audio-recording-session/:sessionId
    router.get("/audio-recording-session/:sessionId", async (req, res) => {
        const { sessionId } = req.params;

        try {
            const meta = await getSession(capabilities, sessionId);
            return res.json({
                success: true,
                session: {
                    sessionId: meta.sessionId,
                    status: meta.status,
                    mimeType: meta.mimeType,
                    elapsedSeconds:
                        meta.status === "stopped"
                            ? meta.elapsedSeconds
                            : Math.floor(meta.lastEndMs / 1000),
                    lastEndMs: meta.lastEndMs,
                    fragmentCount: meta.fragmentCount,
                    lastSequence: meta.lastSequence,
                },
            });
        } catch (error) {
            if (isAudioSessionChunkValidationError(error)) {
                return res.status(400).json({ success: false, error: error.message });
            }
            if (isAudioSessionNotFoundError(error)) {
                return res.status(404).json({ success: false, error: error.message });
            }
            capabilities.logger.logError(
                { error: error instanceof Error ? error.message : String(error) },
                "Failed to get audio session"
            );
            return res.status(500).json({ success: false, error: "Internal error" });
        }
    });

    // POST /audio-recording-session/:sessionId/stop
    router.post("/audio-recording-session/:sessionId/stop", express.json(), async (req, res) => {
        const { sessionId } = req.params;
        const { elapsedSeconds } = req.body || {};

        const elapsedSecondsNum =
            elapsedSeconds === undefined
                ? 0
                : typeof elapsedSeconds === "number"
                ? elapsedSeconds
                : Number(elapsedSeconds);

        if (!Number.isFinite(elapsedSecondsNum) || elapsedSecondsNum < 0) {
            return res.status(400).json({
                success: false,
                error: "Invalid elapsedSeconds: must be a finite, non-negative number",
            });
        }

        try {
            const result = await stopSession(capabilities, sessionId, elapsedSecondsNum);
            return res.json({ success: true, session: result });
        } catch (error) {
            if (isAudioSessionChunkValidationError(error)) {
                return res.status(400).json({ success: false, error: error.message });
            }
            if (isAudioSessionNotFoundError(error)) {
                return res.status(404).json({ success: false, error: error.message });
            }
            if (isAudioSessionFinalizeError(error)) {
                return res.status(500).json({ success: false, error: error.message });
            }
            capabilities.logger.logError(
                { error: error instanceof Error ? error.message : String(error) },
                "Failed to stop audio session"
            );
            return res.status(500).json({ success: false, error: "Internal error" });
        }
    });

    // GET /audio-recording-session/:sessionId/final-audio
    router.get("/audio-recording-session/:sessionId/final-audio", async (req, res) => {
        const { sessionId } = req.params;

        try {
            const { buffer, mimeType } = await fetchFinalAudio(capabilities, sessionId);
            res.setHeader("Content-Type", mimeType || "audio/webm");
            res.setHeader("Content-Length", buffer.length);
            return res.send(buffer);
        } catch (error) {
            if (isAudioSessionChunkValidationError(error)) {
                return res.status(400).json({ success: false, error: error.message });
            }
            if (isAudioSessionNotFoundError(error)) {
                return res.status(404).json({ success: false, error: error.message });
            }
            if (isAudioSessionConflictError(error)) {
                return res.status(409).json({ success: false, error: "Session not yet finalized" });
            }
            if (isAudioSessionFinalizeError(error)) {
                return res.status(500).json({ success: false, error: error.message });
            }
            capabilities.logger.logError(
                { error: error instanceof Error ? error.message : String(error) },
                "Failed to fetch final audio"
            );
            return res.status(500).json({ success: false, error: "Internal error" });
        }
    });

    // DELETE /audio-recording-session/:sessionId
    router.delete("/audio-recording-session/:sessionId", async (req, res) => {
        const { sessionId } = req.params;

        try {
            await discardSession(capabilities, sessionId);
            return res.json({ success: true });
        } catch (error) {
            if (isAudioSessionChunkValidationError(error)) {
                return res.status(400).json({ success: false, error: error.message });
            }
            capabilities.logger.logError(
                { error: error instanceof Error ? error.message : String(error) },
                "Failed to discard audio session"
            );
            return res.status(500).json({ success: false, error: "Internal error" });
        }
    });

    return router;
}

module.exports = { makeRouter };
