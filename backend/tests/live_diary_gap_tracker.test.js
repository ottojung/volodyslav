/**
 * Unit tests for live_diary/gap_tracker.js.
 */

const { scanGaps, GAP_ABANDON_MS } = require("../src/live_diary/gap_tracker");

/** Build a minimal fragment index entry. */
function makeFragment(sequence, startMs, endMs) {
    return {
        sequence,
        startMs,
        endMs,
        contentHash: "deadbeef",
        ingestedAtMs: 0,
        sampleRateHz: 16000,
        channels: 1,
        bitDepth: 16,
    };
}

const NOW = 1_000_000; // arbitrary stable "now" for tests
const DEADLINE = Number.MAX_SAFE_INTEGER;

describe("scanGaps — no gaps", () => {
    it("returns processableEndMs = last fragment end when all fragments are contiguous", () => {
        const fragments = [
            makeFragment(0, 0, 10_000),
            makeFragment(1, 10_000, 20_000),
            makeFragment(2, 20_000, 30_000),
        ];
        const result = scanGaps({
            fragments,
            transcribedUntilMs: 0,
            deadlineMs: DEADLINE,
            knownGaps: [],
            nowMs: NOW,
        });
        expect(result.processableEndMs).toBe(30_000);
        expect(result.blockedAtWatermark).toBe(false);
        expect(result.hasDegradedGap).toBe(false);
        expect(result.updatedGaps).toHaveLength(0);
    });

    it("clips processableEndMs to deadlineMs when deadline is smaller", () => {
        const fragments = [makeFragment(0, 0, 10_000)];
        const result = scanGaps({
            fragments,
            transcribedUntilMs: 0,
            deadlineMs: 5_000,
            knownGaps: [],
            nowMs: NOW,
        });
        expect(result.processableEndMs).toBe(5_000);
    });

    it("returns transcribedUntilMs when there are no candidates", () => {
        const result = scanGaps({
            fragments: [],
            transcribedUntilMs: 50_000,
            deadlineMs: DEADLINE,
            knownGaps: [],
            nowMs: NOW,
        });
        expect(result.processableEndMs).toBe(50_000);
        expect(result.blockedAtWatermark).toBe(false);
        expect(result.hasDegradedGap).toBe(false);
    });
});

describe("scanGaps — waiting gaps", () => {
    it("stops before a newly observed gap (blocking until gap resolves)", () => {
        // Fragment 0 ends at 10_000; fragment 1 starts at 15_000 — gap [10000, 15000).
        const fragments = [
            makeFragment(0, 0, 10_000),
            makeFragment(1, 15_000, 25_000),
        ];
        const result = scanGaps({
            fragments,
            transcribedUntilMs: 0,
            deadlineMs: DEADLINE,
            knownGaps: [],
            nowMs: NOW,
            gapAbandonMs: GAP_ABANDON_MS,
        });
        // Should stop at fragment 0 end (10_000) because the gap has not yet been abandoned.
        expect(result.processableEndMs).toBe(10_000);
        expect(result.blockedAtWatermark).toBe(false);
        expect(result.hasDegradedGap).toBe(false);
        // Gap should be registered as 'waiting'.
        expect(result.updatedGaps).toHaveLength(1);
        expect(result.updatedGaps[0].startMs).toBe(10_000);
        expect(result.updatedGaps[0].endMs).toBe(15_000);
        expect(result.updatedGaps[0].status).toBe("waiting");
    });

    it("sets blockedAtWatermark when the gap starts exactly at the watermark", () => {
        // No fragments before the gap: gap starts right at watermark=0.
        const fragments = [makeFragment(0, 5_000, 15_000)];
        const result = scanGaps({
            fragments,
            transcribedUntilMs: 0,
            deadlineMs: DEADLINE,
            knownGaps: [],
            nowMs: NOW,
            gapAbandonMs: GAP_ABANDON_MS,
        });
        expect(result.blockedAtWatermark).toBe(true);
        expect(result.processableEndMs).toBe(0);
    });

    it("does not register a gap when a fragment overlaps the previous coverage", () => {
        // Fragment 0: [0, 15000]; Fragment 1: [10000, 25000] — overlap, no gap.
        const fragments = [
            makeFragment(0, 0, 15_000),
            makeFragment(1, 10_000, 25_000),
        ];
        const result = scanGaps({
            fragments,
            transcribedUntilMs: 0,
            deadlineMs: DEADLINE,
            knownGaps: [],
            nowMs: NOW,
        });
        expect(result.processableEndMs).toBe(25_000);
        expect(result.updatedGaps).toHaveLength(0);
        expect(result.hasDegradedGap).toBe(false);
    });
});

describe("scanGaps — abandoned gaps", () => {
    it("crosses an abandoned gap with silence and marks hasDegradedGap", () => {
        const fragments = [
            makeFragment(0, 0, 10_000),
            makeFragment(1, 15_000, 25_000),
        ];
        // Gap [10000, 15000) was observed long ago (older than GAP_ABANDON_MS).
        const oldGap = {
            startMs: 10_000,
            endMs: 15_000,
            firstObservedAtMs: NOW - GAP_ABANDON_MS - 1,
            status: "waiting",
        };
        const result = scanGaps({
            fragments,
            transcribedUntilMs: 0,
            deadlineMs: DEADLINE,
            knownGaps: [oldGap],
            nowMs: NOW,
            gapAbandonMs: GAP_ABANDON_MS,
        });
        expect(result.hasDegradedGap).toBe(true);
        expect(result.processableEndMs).toBe(25_000);
        // Gap should now be marked 'abandoned'.
        const gap = result.updatedGaps.find((g) => g.startMs === 10_000);
        expect(gap).toBeDefined();
        expect(gap.status).toBe("abandoned");
    });

    it("ages a gap from waiting to abandoned when gapAge >= gapAbandonMs", () => {
        const fragments = [
            makeFragment(0, 0, 10_000),
            makeFragment(1, 15_000, 20_000),
        ];
        const borderGap = {
            startMs: 10_000,
            endMs: 15_000,
            firstObservedAtMs: NOW - GAP_ABANDON_MS,
            status: "waiting",
        };
        const result = scanGaps({
            fragments,
            transcribedUntilMs: 0,
            deadlineMs: DEADLINE,
            knownGaps: [borderGap],
            nowMs: NOW,
            gapAbandonMs: GAP_ABANDON_MS,
        });
        const gap = result.updatedGaps.find((g) => g.startMs === 10_000);
        expect(gap.status).toBe("abandoned");
        expect(result.hasDegradedGap).toBe(true);
        expect(result.processableEndMs).toBe(20_000);
    });

    it("preserves already-abandoned gaps from knownGaps list", () => {
        const fragments = [
            makeFragment(0, 0, 10_000),
            makeFragment(1, 15_000, 20_000),
        ];
        const abandonedGap = {
            startMs: 10_000,
            endMs: 15_000,
            firstObservedAtMs: 0,
            status: "abandoned",
        };
        const result = scanGaps({
            fragments,
            transcribedUntilMs: 0,
            deadlineMs: DEADLINE,
            knownGaps: [abandonedGap],
            nowMs: NOW,
        });
        expect(result.hasDegradedGap).toBe(true);
        expect(result.processableEndMs).toBe(20_000);
    });
});
