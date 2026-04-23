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
 * Maximum duration of a single transcription window.
 *
 * Caps the total window size (overlap + new audio) so that each pull cycle
 * loads at most a bounded amount of PCM into memory.  Without this cap, a
 * stalled watermark (e.g. due to repeated transcription failures) combined
 * with an ever-growing fragment list causes the window — and therefore the
 * in-memory PCM buffer — to grow without bound, eventually triggering an OOM
 * crash.
 *
 * At 16 kHz / 16-bit / mono the cap translates to ~38.4 MB of raw PCM per
 * pull cycle, well within normal operating memory bounds.
 */
const MAX_WINDOW_DURATION_MS = 20 * 60_000; // 20 minutes

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
 * @property {number} windowEndMs - End of the transcription window (capped at windowStartMs + MAX_WINDOW_DURATION_MS).
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
    // Cap the window so PCM assembly never allocates more than MAX_WINDOW_DURATION_MS
    // worth of audio.  Without this cap a stalled watermark (e.g. repeated
    // transcription failures) causes the window to grow without bound as new
    // fragments arrive, eventually causing an OOM crash.
    const windowEndMs = Math.min(processableEndMs, windowStartMs + MAX_WINDOW_DURATION_MS);
    return {
        windowStartMs,
        windowEndMs,
        effectiveOverlapMs,
    };
}

module.exports = {
    MIN_OVERLAP_MS,
    OVERLAP_CAP_MS,
    MAX_WINDOW_DURATION_MS,
    computeEffectiveOverlapMs,
    planWindow,
};
