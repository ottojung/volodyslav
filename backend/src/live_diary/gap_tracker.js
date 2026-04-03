/**
 * Gap tracker for the cadence-agnostic live diary pull pipeline.
 *
 * Scans the fragment timeline starting from the current watermark and
 * identifies holes (gaps) in coverage.  Gaps are either "waiting" (recently
 * observed, possibly due to upload jitter) or "abandoned" (stale, treated as
 * permanently missing for this pull cycle).  Abandoned gaps are synthesized
 * as silence by the assembler.
 *
 * Configurable threshold:
 *   GAP_ABANDON_MS – age at which a gap is abandoned and crossed with silence (default 30 s).
 *
 * @module live_diary/gap_tracker
 */

/** @typedef {import('../temporary/database/types').LiveDiaryGap} LiveDiaryGap */
/** @typedef {import('../temporary/database/types').LiveDiaryFragmentIndexEntry} LiveDiaryFragmentIndexEntry */

/** Age at which an unresolved gap is abandoned. */
const GAP_ABANDON_MS = 30_000;

/**
 * @typedef {object} GapScanResult
 * @property {number} processableEndMs - The end of the processable contiguous range.
 *   Equals deadlineMs if all fragments up to the deadline are present.
 *   Stops before a waiting gap or at a still-waiting gap that begins exactly at the watermark.
 * @property {LiveDiaryGap[]} updatedGaps - Updated known-gaps list (new observations + status changes).
 * @property {boolean} blockedAtWatermark - True when the first gap begins exactly at
 *   transcribedUntilMs and is still in waiting state — pull should exit without advancing.
 * @property {boolean} hasDegradedGap - True when at least one abandoned gap was crossed.
 */

/**
 * Scan the fragment timeline and determine how far the pull can process.
 *
 * Any gap in fragment coverage blocks progress until the gap either resolves
 * (a filling fragment arrives) or is abandoned (age >= gapAbandonMs), at which
 * point the assembler fills it with silence.
 *
 * @param {object} params
 * @param {LiveDiaryFragmentIndexEntry[]} params.fragments - All known fragments sorted by (startMs, sequence).
 * @param {number} params.transcribedUntilMs - Current watermark.
 * @param {number} params.deadlineMs - Upper bound for this pull (usually Date.now()).
 * @param {LiveDiaryGap[]} params.knownGaps - Previously observed gaps.
 * @param {number} params.nowMs - Current wall-clock time (used for gap aging).
 * @param {number} [params.gapAbandonMs] - Override for GAP_ABANDON_MS.
 * @returns {GapScanResult}
 */
function scanGaps(params) {
    const {
        fragments,
        transcribedUntilMs,
        deadlineMs,
        knownGaps,
        nowMs,
        gapAbandonMs = GAP_ABANDON_MS,
    } = params;

    // Candidate fragments: those that intersect (transcribedUntilMs, deadlineMs].
    const candidates = fragments.filter(
        (f) => f.endMs > transcribedUntilMs && f.startMs < deadlineMs
    );

    if (candidates.length === 0) {
        return {
            processableEndMs: transcribedUntilMs,
            updatedGaps: knownGaps,
            blockedAtWatermark: false,
            hasDegradedGap: false,
        };
    }

    // Build a mutable copy of knownGaps keyed by startMs for fast lookup.
    // Using startMs as the key allows correct matching even when a later fragment
    // partially fills a previously observed gap (changing only the effective endMs).
    /** @type {Map<number, LiveDiaryGap>} */
    const gapMap = new Map(knownGaps.map((g) => [g.startMs, { ...g }]));

    let coveredUntilMs = transcribedUntilMs;
    let hasDegradedGap = false;
    let blockedAtWatermark = false;

    for (const frag of candidates) {
        const fragStart = frag.startMs;

        if (fragStart <= coveredUntilMs) {
            // Fragment covers (or overlaps) current position — extend coverage.
            coveredUntilMs = Math.max(coveredUntilMs, frag.endMs);
            continue;
        }

        // There is a gap: [coveredUntilMs, fragStart).
        // Key by startMs only so that partial fills update the existing record
        // instead of creating a fresh entry with a reset firstObservedAtMs.
        let gap = gapMap.get(coveredUntilMs);

        if (gap === undefined) {
            // First observation — register as waiting.
            gap = {
                startMs: coveredUntilMs,
                endMs: fragStart,
                firstObservedAtMs: nowMs,
                status: "waiting",
            };
            gapMap.set(coveredUntilMs, gap);
        } else {
            // Update endMs to reflect the new (possibly smaller) gap extent because
            // a fragment partially filled the gap.  Note: if the original gap was
            // [A, C] and a new fragment covers [B, C] (B > A), we now track [A, B].
            // Any remaining tail [D, C] where D > fragEnd will be detected as a
            // separate, fresh gap entry when the scan advances past fragEnd in a
            // future iteration — losing the original aging history for that tail.
            // This is an acceptable tradeoff for the initial implementation.
            gap.endMs = fragStart;
        }

        const gapAge = nowMs - gap.firstObservedAtMs;

        if (gap.status === "waiting" && gapAge >= gapAbandonMs) {
            // Age the gap to abandoned.
            gap.status = "abandoned";
        }

        if (gap.status === "abandoned") {
            // Cross the gap with synthetic silence.
            hasDegradedGap = true;
            coveredUntilMs = Math.max(coveredUntilMs, frag.endMs);
            continue;
        }

        // Gap is still waiting — stop here and block progress.
        if (coveredUntilMs === transcribedUntilMs) {
            blockedAtWatermark = true;
        }
        break;
    }

    const processableEndMs = Math.min(coveredUntilMs, deadlineMs);

    // Build the updated gaps list from the map.
    const updatedGaps = Array.from(gapMap.values());

    return {
        processableEndMs,
        updatedGaps,
        blockedAtWatermark,
        hasDegradedGap,
    };
}

module.exports = {
    GAP_ABANDON_MS,
    scanGaps,
};
