/**
 * Router for audio recording session endpoints.
 *
 * Endpoints:
 *   POST   /audio-recording-session/start
 *   POST   /audio-recording-session/:sessionId/push-pcm
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
} = require("../audio_recording_session");
const { getPendingQuestions: getLiveDiaryPendingQuestions, generateInitialQuestionsAndPush } = require("../live_diary");
const { enqueueAnalysis, dequeueSession } = require("./audio_recording_session_analysis_queue");

/** @typedef {import('../environment').Environment} Environment */
/** @typedef {import('../logger').Logger} Logger */
/** @typedef {import('../temporary').Temporary} Temporary */
/** @typedef {import('../datetime').Datetime} Datetime */
/** @typedef {import('../ai/transcription').AITranscription} AITranscription */
/** @typedef {import('../ai/diary_questions').AIDiaryQuestions} AIDiaryQuestions */
/** @typedef {import('../ai/transcript_recombination').AITranscriptRecombination} AITranscriptRecombination */
/** @typedef {import('../generators').Interface} Interface */

/**
 * @typedef {object} Capabilities
 * @property {Environment} environment
 * @property {Logger} logger
 * @property {Temporary} temporary
 * @property {Datetime} datetime
 * @property {AITranscription} aiTranscription
 * @property {AIDiaryQuestions} aiDiaryQuestions
 * @property {AITranscriptRecombination} aiTranscriptRecombination
 * @property {Interface} interface
 */

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
        const { sessionId } = req.body || {};

        if (typeof sessionId !== "string" || !sessionId) {
            return res.status(400).json({ success: false, error: "Missing or invalid sessionId" });
        }

        try {
            const session = await startSession(capabilities, sessionId);
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

    const { registerPushPcmRoute } = require("./audio_recording_session_push_pcm");
    registerPushPcmRoute(
        router,
        capabilities,
        upload,
        pushAudioFragment,
        enqueueAnalysis,
        isAudioSessionChunkValidationError,
        isAudioSessionNotFoundError,
        isAudioSessionConflictError
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

    // POST /audio-recording-session/:sessionId/initialize-live-questions
    // Generates the initial set of diary questions from the diary summary using the
    // smart AI model and pushes them as pending questions for the client to fetch.
    // Should be called once when a new recording session starts (before any audio is pushed).
    router.post("/audio-recording-session/:sessionId/initialize-live-questions", async (req, res) => {
        const { sessionId } = req.params;

        try {
            await generateInitialQuestionsAndPush(capabilities, sessionId);
            return res.json({ success: true });
        } catch (error) {
            capabilities.logger.logError(
                { sessionId, error: error instanceof Error ? error.message : String(error) },
                "Failed to generate initial live diary questions"
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
        dequeueSession(sessionId);

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
