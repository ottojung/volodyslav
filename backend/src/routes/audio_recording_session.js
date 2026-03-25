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

/** @typedef {import('../environment').Environment} Environment */
/** @typedef {import('../logger').Logger} Logger */
/** @typedef {import('../temporary').Temporary} Temporary */

/**
 * @typedef {object} Capabilities
 * @property {Environment} environment
 * @property {Logger} logger
 * @property {Temporary} temporary
 */

/**
 * @param {Capabilities} capabilities
 * @returns {import('express').Router}
 */
function makeRouter(capabilities) {
    const router = express.Router();
    const upload = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB per chunk
    });

    // POST /audio-recording-session/start
    router.post("/audio-recording-session/start", express.json(), async (req, res) => {
        const { sessionId, mimeType } = req.body || {};

        if (typeof sessionId !== "string" || !sessionId) {
            return res.status(400).json({ success: false, error: "Missing or invalid sessionId" });
        }
        if (typeof mimeType !== "string" || !mimeType) {
            return res.status(400).json({ success: false, error: "Missing or invalid mimeType" });
        }

        try {
            const session = await startSession(capabilities, sessionId, mimeType);
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
            const { startMs, endMs, sequence, mimeType } = req.body || {};
            const chunkFile = req.file;

            if (!chunkFile) {
                return res.status(400).json({ success: false, error: "Missing chunk file" });
            }

            const startMsNum = Number(startMs);
            const endMsNum = Number(endMs);
            const sequenceNum = parseInt(String(sequence), 10);

            if (isNaN(startMsNum) || isNaN(endMsNum) || isNaN(sequenceNum)) {
                return res.status(400).json({ success: false, error: "Invalid startMs, endMs, or sequence" });
            }

            try {
                const result = await uploadChunk(capabilities, sessionId, {
                    chunk: chunkFile.buffer,
                    startMs: startMsNum,
                    endMs: endMsNum,
                    sequence: sequenceNum,
                    mimeType: typeof mimeType === "string" ? mimeType : chunkFile.mimetype || "audio/webm",
                });
                return res.json({ success: true, ...result });
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
                    elapsedSeconds: Math.round(meta.lastEndMs / 1000),
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

        const elapsedSecondsNum = typeof elapsedSeconds === "number" ? elapsedSeconds : Number(elapsedSeconds);

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
