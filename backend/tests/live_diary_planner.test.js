/**
 * Unit tests for live_diary/planner.js.
 */

const { computeEffectiveOverlapMs, planWindow, MIN_OVERLAP_MS, OVERLAP_CAP_MS } = require("../src/live_diary/planner");

describe("computeEffectiveOverlapMs", () => {
    it("returns MIN_OVERLAP_MS when prevNewDurationMs is null (no prior pull)", () => {
        expect(computeEffectiveOverlapMs(null)).toBe(MIN_OVERLAP_MS);
    });

    it("returns MIN_OVERLAP_MS when prevNewDurationMs is zero", () => {
        expect(computeEffectiveOverlapMs(0)).toBe(MIN_OVERLAP_MS);
    });

    it("returns MIN_OVERLAP_MS when prevNewDurationMs is below the floor (5 seconds)", () => {
        expect(computeEffectiveOverlapMs(5_000)).toBe(MIN_OVERLAP_MS);
    });

    it("returns prevNewDurationMs when it is above the floor and below the cap", () => {
        expect(computeEffectiveOverlapMs(20_000)).toBe(20_000);
    });

    it("returns OVERLAP_CAP_MS when prevNewDurationMs exceeds the cap", () => {
        expect(computeEffectiveOverlapMs(120_000)).toBe(OVERLAP_CAP_MS);
    });

    it("returns exactly OVERLAP_CAP_MS at the cap boundary", () => {
        expect(computeEffectiveOverlapMs(OVERLAP_CAP_MS)).toBe(OVERLAP_CAP_MS);
    });

    it("returns exactly MIN_OVERLAP_MS at the floor boundary", () => {
        expect(computeEffectiveOverlapMs(MIN_OVERLAP_MS)).toBe(MIN_OVERLAP_MS);
    });

    it("clamps negative prevNewDurationMs to zero (treated as 0), applies floor", () => {
        expect(computeEffectiveOverlapMs(-5_000)).toBe(MIN_OVERLAP_MS);
    });
});

describe("planWindow", () => {
    it("returns window covering overlap and new range on first pull (null prevNewDurationMs)", () => {
        const result = planWindow({
            transcribedUntilMs: 0,
            processableEndMs: 20_000,
            prevNewDurationMs: null,
        });
        expect(result.effectiveOverlapMs).toBe(MIN_OVERLAP_MS);
        // windowStartMs = max(0, 0 - 10000) = 0
        expect(result.windowStartMs).toBe(0);
        expect(result.windowEndMs).toBe(20_000);
    });

    it("starts overlap at or above zero even when watermark - overlap would be negative", () => {
        const result = planWindow({
            transcribedUntilMs: 5_000,
            processableEndMs: 30_000,
            prevNewDurationMs: 60_000, // big prevDuration → overlap = 60s
        });
        // windowStartMs = max(0, 5000 - 60000) = 0
        expect(result.windowStartMs).toBe(0);
        expect(result.effectiveOverlapMs).toBe(OVERLAP_CAP_MS);
    });

    it("correctly sets windowStartMs when watermark exceeds effectiveOverlap", () => {
        const result = planWindow({
            transcribedUntilMs: 30_000,
            processableEndMs: 50_000,
            prevNewDurationMs: 20_000,
        });
        // effectiveOverlap = max(10000, min(60000, 20000)) = 20000
        // windowStartMs = max(0, 30000 - 20000) = 10000
        expect(result.windowStartMs).toBe(10_000);
        expect(result.windowEndMs).toBe(50_000);
        expect(result.effectiveOverlapMs).toBe(20_000);
    });

    it("always uses floor when previous duration is very short", () => {
        const result = planWindow({
            transcribedUntilMs: 50_000,
            processableEndMs: 60_000,
            prevNewDurationMs: 2_000,
        });
        expect(result.effectiveOverlapMs).toBe(MIN_OVERLAP_MS);
        expect(result.windowStartMs).toBe(40_000);
    });
});
