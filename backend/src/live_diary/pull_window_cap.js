/**
 * Pull-cycle window capping based on raw PCM byte budget.
 *
 * @module live_diary/pull_window_cap
 */

/**
 * Cap for assembled PCM bytes per pull cycle.
 *
 * Duration-only limits are format-sensitive: 20 minutes at 48kHz stereo
 * consumes ~219MB raw PCM, which can still trigger memory pressure.
 */
const MAX_WINDOW_PCM_BYTES = 40 * 1024 * 1024; // 40 MiB

/**
 * Cap the planned window end by a maximum raw PCM byte budget.
 *
 * @param {number} windowStartMs
 * @param {number} plannedWindowEndMs
 * @param {number} sampleRateHz
 * @param {number} channels
 * @param {number} bitDepth
 * @returns {number}
 */
function capWindowEndByPcmBudget(windowStartMs, plannedWindowEndMs, sampleRateHz, channels, bitDepth) {
    const bytesPerSample = bitDepth / 8;
    const bytesPerSecond = sampleRateHz * channels * bytesPerSample;
    if (bytesPerSecond <= 0) return plannedWindowEndMs;
    const maxDurationMs = Math.floor((MAX_WINDOW_PCM_BYTES * 1000) / bytesPerSecond);
    return Math.min(plannedWindowEndMs, windowStartMs + maxDurationMs);
}

module.exports = {
    MAX_WINDOW_PCM_BYTES,
    capWindowEndByPcmBudget,
};
