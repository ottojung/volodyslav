/**
 * @typedef {import('./session_state').LastTranscribedRange} LastTranscribedRange
 * @typedef {import('../temporary/database/types').LiveDiaryFragmentIndexEntry} LiveDiaryFragmentIndexEntry
 */

/**
 * Compute the last-transcribed-range metadata from the current pull's fragments.
 * Clamps firstStartMs to transcribedUntilMs so that already-transcribed audio
 * is not counted in the new region (which would inflate the overlap estimate).
 * Returns null if there are no new fragments in the processable range.
 *
 * @param {LiveDiaryFragmentIndexEntry[]} candidates
 * @param {number} transcribedUntilMs
 * @param {number} processableEndMs
 * @returns {LastTranscribedRange | null}
 */
function computeNewLastRange(candidates, transcribedUntilMs, processableEndMs) {
    const newFragments = candidates.filter(
        (f) => f.startMs < processableEndMs && f.endMs > transcribedUntilMs
    );
    if (newFragments.length === 0) return null;
    const firstNewFrag = newFragments[0];
    const lastNewFrag = newFragments[newFragments.length - 1];
    if (firstNewFrag === undefined || lastNewFrag === undefined) return null;
    return {
        firstStartMs: Math.max(firstNewFrag.startMs, transcribedUntilMs),
        lastEndMs: Math.min(lastNewFrag.endMs, processableEndMs),
        fragmentCount: newFragments.length,
    };
}

module.exports = {
    computeNewLastRange,
};
