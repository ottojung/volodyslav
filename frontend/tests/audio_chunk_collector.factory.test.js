/**
 * Tests for audio_chunk_collector factory, type guard, and exported constants.
 */

import {
    makeAudioChunkCollector,
    isAudioChunkCollector,
    CHUNK_DURATION_MS,
    OVERLAP_MS,
} from "./audio_chunk_collector.helpers.js";

// ─── Factory ─────────────────────────────────────────────────────────────────

describe("makeAudioChunkCollector", () => {
    it("returns a defined object", () => {
        const collector = makeAudioChunkCollector(() => {});
        expect(collector).toBeDefined();
    });

    it("accepts a callback and does not throw on creation", () => {
        expect(() => makeAudioChunkCollector(() => {})).not.toThrow();
    });
});

// ─── Type guard ──────────────────────────────────────────────────────────────

describe("isAudioChunkCollector", () => {
    it("returns true for an instance created by makeAudioChunkCollector", () => {
        const collector = makeAudioChunkCollector(() => {});
        expect(isAudioChunkCollector(collector)).toBe(true);
    });

    it("returns false for null", () => {
        expect(isAudioChunkCollector(null)).toBe(false);
    });

    it("returns false for a plain object", () => {
        expect(isAudioChunkCollector({ push: () => {} })).toBe(false);
    });

    it("returns false for a number", () => {
        expect(isAudioChunkCollector(42)).toBe(false);
    });

    it("returns false for undefined", () => {
        expect(isAudioChunkCollector(undefined)).toBe(false);
    });
});

// ─── Exported constants ──────────────────────────────────────────────────────

describe("exported constants", () => {
    it("CHUNK_DURATION_MS equals 5 minutes in milliseconds", () => {
        expect(CHUNK_DURATION_MS).toBe(5 * 60 * 1000);
    });

    it("OVERLAP_MS equals 10 seconds in milliseconds", () => {
        expect(OVERLAP_MS).toBe(10 * 1000);
    });

    it("OVERLAP_MS is less than CHUNK_DURATION_MS", () => {
        expect(OVERLAP_MS).toBeLessThan(CHUNK_DURATION_MS);
    });
});
