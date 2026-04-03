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
                    "push-pcm: validated, storing PCM fragment"
                );

                // Store binary PCM via audio-session service.
                const result = await pushAudioFragment(capabilities, sessionId, {
                    pcm: pcmFile.buffer,
                    sampleRateHz: sampleRateHzNum,
                    channels: channelsNum,
                    bitDepth: bitDepthNum,
                    startMs: startMsNum,
                    endMs: endMsNum,
                    sequence: sequenceNum,
                });

                // Await ingestion so that the fragment index entry is durable before
                // this response is sent.  The client may immediately call /live-questions,
                // which triggers a pull cycle — if the index entry is not yet written the
                // pull cycle will miss this fragment.
                try {
                    await ingestLiveDiaryFragment(capabilities, sessionId, {
                        pcm: pcmFile.buffer,
                        sampleRateHz: sampleRateHzNum,
                        channels: channelsNum,
                        bitDepth: bitDepthNum,
                        startMs: startMsNum,
                        endMs: endMsNum,
                        sequence: sequenceNum,
                    });
                } catch (ingestErr) {
                    // Non-fatal: the binary PCM is already stored by pushAudioFragment.
                    // The fragment index entry may be missing, causing it to be absent
                    // from the next pull cycle, but this is recoverable on retry.
                    capabilities.logger.logError(
                        {
                            sessionId,
                            sequence: sequenceNum,
                            error: ingestErr instanceof Error ? ingestErr.message : String(ingestErr),
                        },
                        "push-pcm: live diary ingestion failed (non-fatal)"
                    );
                }

                capabilities.logger.logDebug(
                    {
                        sessionId,
                        sequence: sequenceNum,
                        fragmentCount: result.session.fragmentCount,
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
