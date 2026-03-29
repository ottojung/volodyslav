const { UINT_RE, UFLOAT_RE, POSINT_RE } = require("../audio_recording_session");

/**
 * @typedef {import('../logger').Logger} Logger
 * @typedef {object} AudioRouterCapabilities
 * @property {Logger} logger
 * @property {import('../temporary').Temporary} temporary
 * @property {import('../datetime').Datetime} datetime
 * @property {import('../ai/transcription').AITranscription} aiTranscription
 * @property {import('../ai/diary_questions').AIDiaryQuestions} aiDiaryQuestions
 * @property {import('../ai/transcript_recombination').AITranscriptRecombination} aiTranscriptRecombination
 *
 * @param {import('express').Router} router
 * @param {AudioRouterCapabilities} capabilities
 * @param {import('multer').Multer} upload
 * @param {Function} pushAudioFragment
 * @param {Function} enqueueAnalysis
 * @param {Function} isAudioSessionChunkValidationError
 * @param {Function} isAudioSessionNotFoundError
 * @param {Function} isAudioSessionConflictError
 */
function registerPushChunkRoute(router, capabilities, upload, pushAudioFragment, enqueueAnalysis, isAudioSessionChunkValidationError, isAudioSessionNotFoundError, isAudioSessionConflictError) {
    /**
     * Shared handler for both /push-chunk and /push-pcm (alias).
     * @param {import('express').Request} req
     * @param {import('express').Response} res
     */
    async function handlePushChunk(req, res) {
        const sessionId = req.params["sessionId"];
        if (!sessionId) {
            return res.status(400).json({ success: false, error: "Missing session ID" });
        }
        const { startMs, endMs, sequence, sampleRateHz, channels, bitDepth, mediaMimeType, captureId, hasRestoreBoundary } = req.body || {};
        const filesMap = req.files;

        const pcmFile = (filesMap && !(filesMap instanceof Array)) ? filesMap["pcm"]?.[0] : undefined;
        const mediaFile = (filesMap && !(filesMap instanceof Array)) ? filesMap["media"]?.[0] : undefined;

        const hasPcm = pcmFile !== undefined;
        const hasMedia = mediaFile !== undefined && mediaFile.buffer.length > 0;

        if (!hasPcm && !hasMedia) {
            return res.status(400).json({ success: false, error: "At least one of pcm or media must be provided" });
        }

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

        if (hasPcm) {
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

            const bitDepthNum = Number(bitDepth);
            if (bitDepthNum !== 16) {
                return res.status(400).json({ success: false, error: "bitDepth must be 16" });
            }
        }

        const startMsNum = Number(startMs);
        const endMsNum = Number(endMs);
        const sequenceNum = Number(sequence);
        const sampleRateHzNum = hasPcm ? Number(sampleRateHz) : undefined;
        const channelsNum = hasPcm ? Number(channels) : undefined;
        const bitDepthNum = hasPcm ? Number(bitDepth) : undefined;
        const hasRestoreBoundaryBool = hasRestoreBoundary === "true" || hasRestoreBoundary === "1";

        try {
            capabilities.logger.logDebug(
                {
                    sessionId,
                    sequence: sequenceNum,
                    hasPcm,
                    hasMedia,
                    sampleRateHz: sampleRateHzNum,
                    channels: channelsNum,
                    bitDepth: bitDepthNum,
                    pcmBytes: hasPcm ? pcmFile.buffer.length : 0,
                    mediaBytes: hasMedia ? mediaFile.buffer.length : 0,
                    startMs: startMsNum,
                    endMs: endMsNum,
                },
                "push-chunk: validated, storing fragment"
            );

            /** @type {{ startMs: number, endMs: number, sequence: number, hasRestoreBoundary: boolean, pcm?: Buffer, sampleRateHz?: number, channels?: number, bitDepth?: number, media?: Buffer, mediaMimeType?: string, captureId?: string }} */
            const params = {
                startMs: startMsNum,
                endMs: endMsNum,
                sequence: sequenceNum,
                hasRestoreBoundary: hasRestoreBoundaryBool,
            };

            if (hasPcm) {
                params.pcm = pcmFile.buffer;
                params.sampleRateHz = sampleRateHzNum;
                params.channels = channelsNum;
                params.bitDepth = bitDepthNum;
            }

            if (hasMedia) {
                params.media = mediaFile.buffer;
                params.mediaMimeType = typeof mediaMimeType === "string" ? mediaMimeType : "";
                params.captureId = typeof captureId === "string" ? captureId : "";
            }

            const result = await pushAudioFragment(capabilities, sessionId, params);

            if (hasPcm) {
                enqueueAnalysis(capabilities, sessionId, {
                    pcm: pcmFile.buffer,
                    sampleRateHz: sampleRateHzNum,
                    channels: channelsNum,
                    bitDepth: bitDepthNum,
                }, sequenceNum);
            }

            capabilities.logger.logDebug(
                {
                    sessionId,
                    sequence: sequenceNum,
                    fragmentCount: result.session.fragmentCount,
                    hasPcm: result.hasPcm,
                    hasMedia: result.hasMedia,
                    mediaContiguousEligible: result.mediaContiguousEligible,
                },
                "push-chunk: fragment stored"
            );

            return res.json({
                success: true,
                ...result,
                status: "accepted",
                hasPcm: result.hasPcm,
                hasMedia: result.hasMedia,
                mediaContiguousEligible: result.mediaContiguousEligible,
            });
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            if (isAudioSessionChunkValidationError(error)) {
                return res.status(400).json({ success: false, error: msg });
            }
            if (isAudioSessionNotFoundError(error)) {
                return res.status(404).json({ success: false, error: msg });
            }
            if (isAudioSessionConflictError(error)) {
                return res.status(409).json({ success: false, error: msg });
            }
            capabilities.logger.logError(
                {
                    sessionId,
                    sequence: sequenceNum,
                    error: msg,
                    stack: error instanceof Error ? error.stack : undefined,
                },
                "Failed to push chunk"
            );
            return res.status(500).json({ success: false, error: "Internal error" });
        }
    }

    // POST /audio-recording-session/:sessionId/push-chunk
    router.post(
        "/audio-recording-session/:sessionId/push-chunk",
        (req, res, next) => {
            capabilities.logger.logDebug(
                { sessionId: req.params["sessionId"], contentType: req.headers["content-type"] },
                "push-chunk: request received, processing multipart upload"
            );
            upload.fields([
                { name: "pcm", maxCount: 1 },
                { name: "media", maxCount: 1 },
            ])(req, res, (err) => {
                if (err) {
                    capabilities.logger.logError(
                        {
                            sessionId: req.params["sessionId"],
                            error: err.message,
                            code: err.code,
                            stack: err.stack,
                        },
                        "push-chunk: multipart parse error"
                    );
                    res.status(400).json({ success: false, error: `Multipart parse error: ${err.message}` });
                    return;
                }
                next();
            });
        },
        handlePushChunk
    );
}

module.exports = { registerPushChunkRoute };
