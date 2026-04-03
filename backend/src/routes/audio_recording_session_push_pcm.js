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
 * @param {Function} ingestLiveDiaryFragment
 * @param {Function} isAudioSessionChunkValidationError
 * @param {Function} isAudioSessionNotFoundError
 * @param {Function} isAudioSessionConflictError
 */
function registerPushPcmRoute(router, capabilities, upload, pushAudioFragment, ingestLiveDiaryFragment, isAudioSessionChunkValidationError, isAudioSessionNotFoundError, isAudioSessionConflictError) {
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

            const UINT_RE = /^\d{1,6}$/;
            const UFLOAT_RE = /^\d+(\.\d+)?$/;
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
                    "push-pcm: validated, checking live diary index before storing PCM"
                );

                // Check the live diary index BEFORE writing the binary PCM chunk.
                // If the ingestor rejects the fragment (duplicate_rejected), we must
                // not overwrite the already-transcribed binary chunk — doing so would
                // corrupt the final audio assembly for the session.
                const ingestResult = await ingestLiveDiaryFragment(capabilities, sessionId, {
                    pcm: pcmFile.buffer,
                    sampleRateHz: sampleRateHzNum,
                    channels: channelsNum,
                    bitDepth: bitDepthNum,
                    startMs: startMsNum,
                    endMs: endMsNum,
                    sequence: sequenceNum,
                });

                if (ingestResult.status === "invalid_pcm") {
                    return res.status(400).json({
                        success: false,
                        error: "Fragment rejected by live diary indexer: invalid PCM or timing",
                    });
                }

                if (ingestResult.status === "duplicate_rejected") {
                    return res.status(409).json({
                        success: false,
                        error: "Non-identical duplicate fragment rejected: already transcribed",
                    });
                }

                // Store binary PCM via audio-session service.  Only reached when
                // ingest accepted or no-op'd (exact duplicate — safe to overwrite).
                const result = await pushAudioFragment(capabilities, sessionId, {
                    pcm: pcmFile.buffer,
                    sampleRateHz: sampleRateHzNum,
                    channels: channelsNum,
                    bitDepth: bitDepthNum,
                    startMs: startMsNum,
                    endMs: endMsNum,
                    sequence: sequenceNum,
                });

                capabilities.logger.logDebug(
                    {
                        sessionId,
                        sequence: sequenceNum,
                        fragmentCount: result.session.fragmentCount,
                        ingestStatus: ingestResult.status,
                    },
                    "push-pcm: fragment stored, live diary fragment ingested"
                );

                return res.json({ success: true, ...result, questions: [], status: "accepted" });
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
                    "Failed to push PCM fragment"
                );
                return res.status(500).json({ success: false, error: "Internal error" });
            }
        }
    );
}

module.exports = { registerPushPcmRoute };
