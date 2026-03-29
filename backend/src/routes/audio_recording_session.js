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
const { getPendingQuestions: getLiveDiaryPendingQuestions } = require("../live_diary");
const { enqueueAnalysis, dequeueSession } = require("./audio_recording_session_analysis_queue");

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

    // POST /audio-recording-session/:sessionId/push-pcm
    router.post(
        "/audio-recording-session/:sessionId/push-pcm",
        (req, res, next) => {
            capabilities.logger.logDebug(
                { sessionId: req.params.sessionId, contentType: req.headers["content-type"] },
                "push-pcm: request received, processing multipart upload"
            );
            upload.fields([{ name: "pcm", maxCount: 1 }])(req, res, (err) => {
                if (err) {
                    capabilities.logger.logError(
                        {
                            sessionId: req.params.sessionId,
                            error: err.message,
                            code: err.code,
                            stack: err.stack,
                        },
                        "push-pcm: multipart parse error"
                    );
                    res.status(400).json({ success: false, error: `Multipart parse error: ${err.message}` });
                    return;
                }
                next();
            });
        },
        async (req, res) => {
            const { sessionId } = req.params;
            if (!sessionId) {
                return res.status(400).json({ success: false, error: "Missing session ID" });
            }
            const { startMs, endMs, sequence, sampleRateHz, channels, bitDepth } = req.body || {};
            const filesMap = req.files;
            const pcmFile = (filesMap && !(filesMap instanceof Array)) ? filesMap["pcm"]?.[0] : undefined;

            if (!pcmFile) {
                return res.status(400).json({ success: false, error: "Missing pcm file" });
            }

            // Accept only plain base-10 non-negative integer strings for sequence
            // and plain non-negative numeric strings for startMs/endMs.
            // This rejects scientific notation ("1e3"), empty strings, and floats for sequence.
            // Sequence is limited to 6 digits to stay compatible with 6-digit zero-padding
            // and lexicographic sort order used when concatenating persisted fragments.
            const UINT_RE = /^\d{1,6}$/;
            const UFLOAT_RE = /^\d+(\.\d+)?$/;
            // Positive integer (no zero), limited to 6 digits to avoid overly large values
            const POSINT_RE = /^[1-9]\d{0,5}$/;

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

            if (
                typeof sampleRateHz !== "string" ||
                typeof channels !== "string" ||
                typeof bitDepth !== "string" ||
                !POSINT_RE.test(sampleRateHz) ||
                !POSINT_RE.test(channels) ||
                !POSINT_RE.test(bitDepth)
            ) {
                return res.status(400).json({ success: false, error: "Invalid sampleRateHz, channels, or bitDepth" });
            }

            const startMsNum = Number(startMs);
            const endMsNum = Number(endMs);
            const sequenceNum = Number(sequence);
            const sampleRateHzNum = Number(sampleRateHz);
            const channelsNum = Number(channels);
            const bitDepthNum = Number(bitDepth);

            if (bitDepthNum !== 16) {
                return res.status(400).json({ success: false, error: "bitDepth must be 16" });
            }

            try {
                capabilities.logger.logDebug(
                    {
                        sessionId,
                        sequence: sequenceNum,
                        sampleRateHz: sampleRateHzNum,
                        channels: channelsNum,
                        bitDepth: bitDepthNum,
                        pcmBytes: pcmFile.buffer.length,
                        startMs: startMsNum,
                        endMs: endMsNum,
                    },
                    "push-pcm: validated, storing PCM fragment"
                );

                const result = await pushAudioFragment(capabilities, sessionId, {
                    pcm: pcmFile.buffer,
                    sampleRateHz: sampleRateHzNum,
                    channels: channelsNum,
                    bitDepth: bitDepthNum,
                    startMs: startMsNum,
                    endMs: endMsNum,
                    sequence: sequenceNum,
                });

                // Queue live diary AI processing asynchronously to avoid HTTP gateway timeout.
                // The AI pipeline (transcription + recombination + question generation) can take
                // 30-90 seconds, which would exceed typical proxy timeouts.  By running it in
                // the background and storing results in the pending-questions state, the client
                // can poll GET /live-questions to retrieve generated questions.
                enqueueAnalysis(capabilities, sessionId, {
                    pcm: pcmFile.buffer,
                    sampleRateHz: sampleRateHzNum,
                    channels: channelsNum,
                    bitDepth: bitDepthNum,
                }, sequenceNum);

                capabilities.logger.logDebug(
                    {
                        sessionId,
                        sequence: sequenceNum,
                        fragmentCount: result.session.fragmentCount,
                    },
                    "push-pcm: fragment stored, AI analysis queued"
                );

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
                    {
                        sessionId,
                        sequence: sequenceNum,
                        error: error instanceof Error ? error.message : String(error),
                        stack: error instanceof Error ? error.stack : undefined,
                    },
                    "Failed to push PCM fragment"
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
