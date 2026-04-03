/**
 * Fragment ingestion for the cadence-agnostic live diary pipeline.
 *
 * Exports `ingestFragment` — the ingestion-only handler that stores timing
 * metadata for a newly uploaded PCM fragment in the live diary fragment index.
 * Binary PCM storage is handled by `uploadChunk` in the audio-session module.
 *
 * @module live_diary/ingest_fragment
 */

const { markSessionExists, validatePcmParams } = require("../audio_recording_session");
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
 * Binary PCM is already stored by `uploadChunk` in the audio-session sublevel;
 * this function only records the timing/hash metadata required for the pull cycle.
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

    // Validate PCM parameters.
    const pcmError = validatePcmParams(pcm, sampleRateHz, channels, bitDepth);
    if (pcmError !== null) {
        capabilities.logger.logWarning(
            { sessionId, sequence, error: pcmError },
            "Live diary ingest: invalid PCM parameters"
        );
        return { status: "invalid_pcm" };
    }

    // Validate timing.
    if (endMs <= startMs) {
        capabilities.logger.logWarning(
            { sessionId, sequence, startMs, endMs },
            "Live diary ingest: fragment has invalid duration (endMs <= startMs)"
        );
        return { status: "invalid_pcm" };
    }

    const contentHash = computeContentHash(pcm);
    const ingestedAtMs = capabilities.datetime.now().toMillis();

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
