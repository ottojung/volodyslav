/**
 * Router for audio recording session endpoints.
 *
 * Endpoints:
 *   POST   /audio-recording-session/start
 *   POST   /audio-recording-session/:sessionId/push-audio
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
    uploadChunk: pushAudioFragment,
    getSession,
    stopSession,
    fetchFinalAudio,
    discardSession,
    isAudioSessionNotFoundError,
    isAudioSessionChunkValidationError,
    isAudioSessionConflictError,
    isAudioSessionFinalizeError,
    parseAudioMimeType,
} = require("../audio_recording_session");
const { pushAudio: pushLiveDiaryAudio, getPendingQuestions: getLiveDiaryPendingQuestions } = require("../live_diary");

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
 * Per-session promise chain for serializing live-diary AI processing.
 * Storing the tail promise per session ensures that fragments are processed
 * in order without blocking the HTTP response.
 *
 * @type {Map<string, Promise<void>>}
 */
const processingQueues = new Map();

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

    // POST /audio-recording-session/:sessionId/push-audio
    router.post(
        "/audio-recording-session/:sessionId/push-audio",
        upload.fields([{ name: "audio", maxCount: 1 }, { name: "analysisAudio", maxCount: 1 }]),
        async (req, res) => {
            const { sessionId } = req.params;
            if (!sessionId) {
                return res.status(400).json({ success: false, error: "Missing session ID" });
            }
            const { startMs, endMs, sequence, mimeType, analysisMimeType } = req.body || {};
            const filesMap = req.files;
            const chunkFile = (filesMap && !(filesMap instanceof Array)) ? filesMap["audio"]?.[0] : undefined;
            const analysisFile = (filesMap && !(filesMap instanceof Array)) ? filesMap["analysisAudio"]?.[0] : undefined;

            if (!chunkFile) {
                return res.status(400).json({ success: false, error: "Missing audio file" });
            }

            // Accept only plain base-10 non-negative integer strings for sequence
            // and plain non-negative numeric strings for startMs/endMs.
            // This rejects scientific notation ("1e3"), empty strings, and floats for sequence.
            // Sequence is limited to 6 digits to stay compatible with 6-digit zero-padding
            // and lexicographic sort order used when concatenating persisted fragments.
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
                const result = await pushAudioFragment(capabilities, sessionId, {
                    chunk: chunkFile.buffer,
                    startMs: startMsNum,
                    endMs: endMsNum,
                    sequence: sequenceNum,
                    mimeType: normalizedChunkMimeType,
                });

                // analysisBuffer is non-null only when the upload includes a valid WAV
                // analysis fragment; live-diary AI processing is skipped otherwise.
                const analysisBuffer = (analysisFile && typeof analysisMimeType === "string" && parseAudioMimeType(analysisMimeType) === "audio/wav") ? analysisFile.buffer : null;

                capabilities.logger.logDebug(
                    { sessionId, sequence: sequenceNum, chunkSizeBytes: chunkFile.buffer.length },
                    "Push-audio: audio fragment stored; queuing live diary AI processing"
                );

                // Queue live diary AI processing asynchronously to avoid HTTP gateway timeout.
                // The AI pipeline (transcription + recombination + question generation) can take
                // 30-90 seconds, which would exceed typical proxy timeouts.  By running it in
                // the background and storing results in the pending-questions state, the client
                // can poll GET /live-questions to retrieve generated questions.
                // Chaining through `.catch(() => Promise.resolve())` ensures rejections in a
                // previous fragment's processing do not break subsequent fragments' chains.
                if (analysisBuffer) {
                    const existingQueue = (processingQueues.get(sessionId) ?? Promise.resolve()).catch(() => Promise.resolve());
                    const nextQueue = existingQueue.then(async () => {
                        try {
                            await pushLiveDiaryAudio(
                                capabilities,
                                sessionId,
                                analysisBuffer,
                                "audio/wav",
                                sequenceNum + 1
                            );
                            capabilities.logger.logDebug(
                                { sessionId, sequence: sequenceNum },
                                "Live diary AI processing completed for fragment"
                            );
                        } catch (error) {
                            capabilities.logger.logError(
                                {
                                    sessionId,
                                    sequence: sequenceNum,
                                    error: error instanceof Error ? error.message : String(error),
                                    stack: error instanceof Error ? error.stack : undefined,
                                },
                                "Live diary AI processing failed for fragment"
                            );
                        }
                    });
                    processingQueues.set(sessionId, nextQueue);
                }

                // Respond immediately — questions will be available via GET /live-questions.
                return res.json({ success: true, ...result, questions: [], status: "accepted" });
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
                    "Failed to push audio fragment"
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
    router.post("/audio-recording-session/:sessionId/stop", async (req, res) => {
        const { sessionId } = req.params;

        try {
            const result = await stopSession(capabilities, sessionId);
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

    // GET /audio-recording-session/:sessionId/restore — unified restore payload
    // Returns all information needed to restore the UI without a second round-trip.
    router.get("/audio-recording-session/:sessionId/restore", async (req, res) => {
        const { sessionId } = req.params;

        try {
            const meta = await getSession(capabilities, sessionId);
            const hasFinalAudio = meta.status === "stopped";
            return res.json({
                success: true,
                restore: {
                    status: meta.status,
                    mimeType: meta.mimeType,
                    elapsedSeconds: hasFinalAudio
                        ? meta.elapsedSeconds
                        : Math.floor(meta.lastEndMs / 1000),
                    lastSequence: meta.lastSequence,
                    hasFinalAudio,
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
                "Failed to build restore payload"
            );
            return res.status(500).json({ success: false, error: "Internal error" });
        }
    });

    // GET /audio-recording-session/:sessionId/live-questions — poll for pending diary questions
    // Returns questions generated by the background live diary AI pipeline since the last poll.
    // Questions are cleared after being returned (consume-once semantics).
    router.get("/audio-recording-session/:sessionId/live-questions", async (req, res) => {
        const { sessionId } = req.params;

        try {
            const questions = await getLiveDiaryPendingQuestions(capabilities, sessionId);
            return res.json({ success: true, questions });
        } catch (error) {
            capabilities.logger.logError(
                { sessionId, error: error instanceof Error ? error.message : String(error) },
                "Failed to fetch live diary pending questions"
            );
            return res.status(500).json({ success: false, error: "Internal error" });
        }
    });

    // DELETE /audio-recording-session/:sessionId
    router.delete("/audio-recording-session/:sessionId", async (req, res) => {
        const { sessionId } = req.params;

        // Remove the queue tail reference so the map does not grow unboundedly.
        // Any in-flight AI processing for this session continues to completion but
        // subsequent fragments for this sessionId will not be processed.
        processingQueues.delete(sessionId);

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
