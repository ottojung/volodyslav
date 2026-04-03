/**
 * Fragment ingestion for the cadence-agnostic live diary pipeline.
 *
 * Exports `ingestFragment` — the ingestion-only handler that stores timing
 * metadata for a newly uploaded PCM fragment in the live diary fragment index.
 * Binary PCM storage is handled by `uploadChunk` in the audio-session module.
 *
 * @module live_diary/ingest_fragment
 */

const {
    getSession,
    markSessionExists,
    validatePcmParams,
    validateUploadChunkParams,
    AudioSessionChunkValidationError,
    AudioSessionConflictError,
} = require("../audio_recording_session");
const {
    computeContentHash,
    writeFragmentIndex,
    readFragmentIndex,
    readTranscribedUntilMs,
} = require("./session_state");

/** @typedef {import('../temporary').Temporary} Temporary */
/** @typedef {import('../logger').Logger} Logger */
/** @typedef {import('../datetime').Datetime} Datetime */

/**
 * @typedef {object} IngestCapabilities
 * @property {Temporary} temporary
 * @property {Logger} logger
 * @property {Datetime} datetime
 */

/**
 * @typedef {object} IngestFragmentParams
 * @property {Buffer} pcm - Raw PCM sample bytes (16-bit signed little-endian).
 * @property {number} sampleRateHz
 * @property {number} channels
 * @property {number} bitDepth
 * @property {number} startMs
 * @property {number} endMs
 * @property {number} sequence
 */

/**
 * @typedef {'accepted' | 'invalid_pcm' | 'duplicate_no_op' | 'duplicate_rejected'} IngestFragmentStatus
 */

/**
 * @typedef {object} IngestFragmentResult
 * @property {IngestFragmentStatus} status
 */

/**
 * Ingest a PCM fragment for a session — ingestion only, no AI processing.
 *
 * Stores fragment timing metadata in the live diary fragment index.
 * In the `push-pcm` route, this ingest step runs before `uploadChunk` so that
 * duplicate-below-watermark cases are rejected before any binary overwrite.
 * Pull processing therefore treats index-without-bytes as a degraded retry case
 * and must not advance the watermark until bytes are durable.
 *
 * Idempotent duplicate semantics:
 *   - Exact duplicates (same sequence + same contentHash + same timing) are accepted as no-op.
 *   - Non-identical duplicates below the watermark are rejected.
 *   - Non-identical duplicates above the watermark are accepted as replacements.
 *
 * @param {IngestCapabilities} capabilities
 * @param {string} sessionId
 * @param {IngestFragmentParams} params
 * @returns {Promise<IngestFragmentResult>}
 */
async function ingestFragment(capabilities, sessionId, params) {
    const { temporary } = capabilities;
    const { pcm, sampleRateHz, channels, bitDepth, startMs, endMs, sequence } = params;

    // Validate the same shape constraints as uploadChunk so ingestion and
    // binary storage cannot disagree about whether a fragment is valid.
    const uploadError = validateUploadChunkParams(params);
    if (uploadError !== null) {
        capabilities.logger.logWarning(
            { sessionId, sequence, error: uploadError },
            "Live diary ingest: invalid upload parameters"
        );
        return { status: "invalid_pcm" };
    }

    // Preserve explicit PCM validation log message for compatibility with
    // existing diagnostics.
    const pcmError = validatePcmParams(pcm, sampleRateHz, channels, bitDepth);
    if (pcmError !== null) {
        capabilities.logger.logWarning(
            { sessionId, sequence, error: pcmError },
            "Live diary ingest: invalid PCM parameters"
        );
        return { status: "invalid_pcm" };
    }

    const session = await getSession(capabilities, sessionId);
    if (session.status === "stopped") {
        throw new AudioSessionConflictError(
            `Cannot upload chunk to finalized session: ${sessionId}`,
            sessionId
        );
    }
    const formatMismatch = session.sampleRateHz !== 0 && (
        session.sampleRateHz !== sampleRateHz ||
        session.channels !== channels ||
        session.bitDepth !== bitDepth
    );
    if (formatMismatch) {
        throw new AudioSessionChunkValidationError(
            `PCM format mismatch: expected ${session.sampleRateHz}Hz/${session.channels}ch/${session.bitDepth}bit, ` +
            `got ${sampleRateHz}Hz/${channels}ch/${bitDepth}bit`
        );
    }

    const contentHash = computeContentHash(pcm);

    // Check for existing fragment with same sequence.
    const existing = await readFragmentIndex(temporary, sessionId, sequence);
    if (existing !== null) {
        const isIdentical =
            existing.contentHash === contentHash &&
            existing.startMs === startMs &&
            existing.endMs === endMs &&
            existing.sampleRateHz === sampleRateHz &&
            existing.channels === channels &&
            existing.bitDepth === bitDepth;

        if (isIdentical) {
            // Idempotent no-op.
            return { status: "duplicate_no_op" };
        }

        // Non-identical: check if below watermark.
        const transcribedUntilMs = await readTranscribedUntilMs(temporary, sessionId);
        if (existing.startMs < transcribedUntilMs) {
            capabilities.logger.logWarning(
                { sessionId, sequence, transcribedUntilMs, existingStartMs: existing.startMs },
                "Live diary ingest: rejecting non-identical duplicate below watermark"
            );
            return { status: "duplicate_rejected" };
        }
        // Above watermark — allow replacement.
    }

    const ingestedAtMs = existing === null
        ? capabilities.datetime.now().toMillis()
        : existing.ingestedAtMs;

    await markSessionExists(temporary, sessionId);
    await writeFragmentIndex(temporary, sessionId, {
        sequence,
        startMs,
        endMs,
        contentHash,
        ingestedAtMs,
        sampleRateHz,
        channels,
        bitDepth,
    });

    capabilities.logger.logDebug(
        { sessionId, sequence, startMs, endMs, contentHash },
        "Live diary fragment ingested"
    );

    return { status: "accepted" };
}

module.exports = {
    ingestFragment,
};
