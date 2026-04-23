const { planWindow } = require("./planner");
const { capWindowEndByPcmBudget } = require("./pull_window_cap");

/**
 * @typedef {import('../temporary/database/types').LiveDiaryFragmentIndexEntry} LiveDiaryFragmentIndexEntry
 */

/**
 * Plan pull-cycle window and apply PCM-byte-budget cap.
 *
 * @param {{
 *   transcribedUntilMs: number,
 *   processableEndMs: number,
 *   prevNewDurationMs: number | null,
 *   candidates: LiveDiaryFragmentIndexEntry[],
 * }} input
 * @returns {{
 *   windowStartMs: number,
 *   plannedWindowEndMs: number,
 *   committedThroughMs: number,
 *   effectiveOverlapMs: number,
 *   sampleRateHz: number,
 *   channels: number,
 *   bitDepth: number,
 * } | null}
 */
function planWindowWithCaps(input) {
    const {
        transcribedUntilMs,
        processableEndMs,
        prevNewDurationMs,
        candidates,
    } = input;
    const firstCandidate = candidates[0];
    if (firstCandidate === undefined) return null;

    const { windowStartMs, windowEndMs, effectiveOverlapMs } = planWindow({
        transcribedUntilMs,
        processableEndMs,
        prevNewDurationMs,
    });

    const { sampleRateHz, channels, bitDepth } = firstCandidate;
    const cappedWindowEndMs = capWindowEndByPcmBudget(
        windowStartMs,
        windowEndMs,
        sampleRateHz,
        channels,
        bitDepth
    );
    return {
        windowStartMs,
        plannedWindowEndMs: windowEndMs,
        committedThroughMs: Math.min(processableEndMs, cappedWindowEndMs),
        effectiveOverlapMs,
        sampleRateHz,
        channels,
        bitDepth,
    };
}

module.exports = {
    planWindowWithCaps,
};
