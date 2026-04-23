/**
 * Overlap planner for the cadence-agnostic live diary pull pipeline.
 *
 * Computes how many milliseconds of previously transcribed audio to include
 * at the start of the next transcription window ("overlap").  The overlap
 * stabilises text stitching at pull boundaries.
 *
 * Rules (from the spec):
 *   MIN_OVERLAP_MS = 10_000
 *   OVERLAP_CAP_MS = 60_000
 *
 *   smallestBoundarySufficientOverlapMs = clamp(prevNewDurationMs, 0, OVERLAP_CAP_MS)
 *   effectiveOverlapMs = max(MIN_OVERLAP_MS, smallestBoundarySufficientOverlapMs)
 *
 * Interpretation:
 *   - If previous new region was short, the 10 s floor dominates.
 *   - If previous new region was longer, overlap grows only as much as required
 *     by the prior boundary size.
 *   - Overlap is never below 10 s and never above 60 s.
 *
 * @module live_diary/planner
 */

const MIN_OVERLAP_MS = 10_000;
const OVERLAP_CAP_MS = 60_000;

/**
 * Maximum duration of NEW audio (i.e. beyond the current watermark) that one
 * pull cycle may transcribe.  Bounding this prevents unbounded PCM allocation
 * when transcription keeps failing and the watermark never advances: without a
 * cap the window would grow to cover the entire recording session.
 *
 * At 16 kHz / 16-bit / mono, 5 minutes of new audio costs
 *   5 × 60 × 16 000 × 2 = 9.6 MB of PCM.
 * The pull cycle needs to hold the assembled PCM plus the WAV twice in memory
 * at peak (source buffer + WAV header copy), so the per-cycle allocation stays
 * well under 30 MB even at the cap.
 */
const MAX_NEW_AUDIO_MS = 5 * 60 * 1_000; // 5 minutes

/**
 * @typedef {object} PlannerInput
 * @property {number} transcribedUntilMs - High-watermark already integrated into the running transcript.
 * @property {number} processableEndMs - End of the new contiguous range to transcribe this pull.
 * @property {number | null} prevNewDurationMs - Duration of the previous pull's new fragment range (ms),
 *   or null when there has been no prior pull.
 */

/**
 * @typedef {object} PlannerResult
 * @property {number} windowStartMs - Start of the transcription window (includes overlap).
 * @property {number} windowEndMs - End of the transcription window.  Equals
 *   `processableEndMs` when the new-audio duration fits within `MAX_NEW_AUDIO_MS`;
 *   otherwise capped at `transcribedUntilMs + MAX_NEW_AUDIO_MS` so that each
 *   pull cycle allocates a bounded amount of PCM.
 * @property {number} effectiveOverlapMs - Overlap duration actually used.
 */

/**
 * Compute the effective overlap duration for the next pull.
 *
 * @param {number | null} prevNewDurationMs - Duration (ms) of the new-fragment region
 *   transcribed in the previous pull.  Pass null for the very first pull.
 * @returns {number} effectiveOverlapMs
 */
function computeEffectiveOverlapMs(prevNewDurationMs) {
    const durationMs = prevNewDurationMs !== null ? prevNewDurationMs : 0;
    const smallestBoundarySufficientOverlapMs = Math.min(Math.max(durationMs, 0), OVERLAP_CAP_MS);
    return Math.max(MIN_OVERLAP_MS, smallestBoundarySufficientOverlapMs);
}

/**
 * Plan the transcription window for a pull cycle.
 *
 * @param {PlannerInput} input
 * @returns {PlannerResult}
 */
function planWindow(input) {
    const { transcribedUntilMs, processableEndMs, prevNewDurationMs } = input;
    const effectiveOverlapMs = computeEffectiveOverlapMs(prevNewDurationMs);
    const windowStartMs = Math.max(0, transcribedUntilMs - effectiveOverlapMs);
    // Cap new-audio duration to MAX_NEW_AUDIO_MS so that each pull cycle
    // allocates a bounded amount of PCM regardless of how much audio has
    // accumulated without a successful transcription.
    const windowEndMs = Math.min(processableEndMs, transcribedUntilMs + MAX_NEW_AUDIO_MS);
    return {
        windowStartMs,
        windowEndMs,
        effectiveOverlapMs,
    };
}

module.exports = {
    MIN_OVERLAP_MS,
    OVERLAP_CAP_MS,
    MAX_NEW_AUDIO_MS,
    computeEffectiveOverlapMs,
    planWindow,
};
