/**
 * Tests for audio_chunk_collector emission timing and overlap geometry.
 */

import {
    makeAudioChunkCollector,
    CHUNK_DURATION_MS,
    OVERLAP_MS,
    FRAGMENT_MS,
    makeBlob,
    pushFragments,
} from "./audio_chunk_collector.helpers.js";

// Computed fragment counts — derived from timing constants so tests remain valid
// when FRAGMENT_MS changes.
const frags1Chunk = Math.ceil(CHUNK_DURATION_MS / FRAGMENT_MS);
const frags2Chunks = Math.ceil((2 * CHUNK_DURATION_MS - OVERLAP_MS) / FRAGMENT_MS);
const frags3Chunks = Math.ceil((3 * CHUNK_DURATION_MS - 2 * OVERLAP_MS) / FRAGMENT_MS);

// ─── No emission before threshold ───────────────────────────────────────────

describe("AudioChunkCollector: no emission before 5 minutes", () => {
    it("does not emit with zero fragments", () => {
        const chunks = [];
        makeAudioChunkCollector((c) => chunks.push(c));
        expect(chunks).toHaveLength(0);
    });

    it("does not emit with one fragment", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        collector.push(makeBlob("data"), 0, FRAGMENT_MS);
        expect(chunks).toHaveLength(0);
    });

    it(`does not emit with ${frags1Chunk - 1} fragments (below 300 s threshold)`, () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        pushFragments(collector, frags1Chunk - 1);
        expect(chunks).toHaveLength(0);
    });

    it("does not emit when cumulative time is exactly 1 ms below threshold", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        collector.push(makeBlob("data"), 0, CHUNK_DURATION_MS - 1);
        expect(chunks).toHaveLength(0);
    });
});

// ─── Single chunk emission ───────────────────────────────────────────────────

describe("AudioChunkCollector: first chunk emission", () => {
    it(`emits exactly one chunk when ${frags1Chunk} fragments fill the 300 s window`, () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        pushFragments(collector, frags1Chunk);
        expect(chunks).toHaveLength(1);
    });

    it("first chunk has start=0", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        pushFragments(collector, frags1Chunk);
        expect(chunks[0].start).toBe(0);
    });

    it("first chunk has end=CHUNK_DURATION_MS", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        pushFragments(collector, frags1Chunk);
        expect(chunks[0].end).toBe(CHUNK_DURATION_MS);
    });

    it("emitted chunk data is a Blob", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        pushFragments(collector, frags1Chunk);
        expect(chunks[0].data).toBeInstanceOf(Blob);
    });

    it("emitted chunk data has positive size", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        pushFragments(collector, frags1Chunk);
        expect(chunks[0].data.size).toBeGreaterThan(0);
    });

    it("emits at the exact threshold when a fragment ends exactly at CHUNK_DURATION_MS", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        collector.push(makeBlob("whole-recording"), 0, CHUNK_DURATION_MS);
        expect(chunks).toHaveLength(1);
        expect(chunks[0].start).toBe(0);
        expect(chunks[0].end).toBe(CHUNK_DURATION_MS);
    });
});

// ─── Two-chunk overlap ───────────────────────────────────────────────────────

describe("AudioChunkCollector: two overlapping chunks", () => {
    it(`emits only 1 chunk after ${frags2Chunks - 1} fragments (below second window threshold)`, () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        // frags2Chunks - 1 fragments: first chunk has fired but second has not yet
        pushFragments(collector, frags2Chunks - 1);
        expect(chunks).toHaveLength(1);
    });

    it(`emits 2 chunks after ${frags2Chunks} fragments (reaches second window threshold)`, () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        pushFragments(collector, frags2Chunks);
        expect(chunks).toHaveLength(2);
    });

    it("second chunk starts at CHUNK_DURATION_MS - OVERLAP_MS", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        pushFragments(collector, frags2Chunks);
        expect(chunks[1].start).toBe(CHUNK_DURATION_MS - OVERLAP_MS);
    });

    it("second chunk ends at (CHUNK_DURATION_MS - OVERLAP_MS) + CHUNK_DURATION_MS", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        pushFragments(collector, frags2Chunks);
        const expectedEnd = (CHUNK_DURATION_MS - OVERLAP_MS) + CHUNK_DURATION_MS;
        expect(chunks[1].end).toBe(expectedEnd);
    });

    it("overlap region is exactly OVERLAP_MS wide", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        pushFragments(collector, frags2Chunks);
        const overlapWidth = chunks[0].end - chunks[1].start;
        expect(overlapWidth).toBe(OVERLAP_MS);
    });

    it("second chunk has a Blob with positive size", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        pushFragments(collector, frags2Chunks);
        expect(chunks[1].data).toBeInstanceOf(Blob);
        expect(chunks[1].data.size).toBeGreaterThan(0);
    });
});

// ─── Three-chunk sequence ────────────────────────────────────────────────────

describe("AudioChunkCollector: three chunks", () => {
    it(`emits 3 chunks after ${frags3Chunks} fragments (reaches third window threshold)`, () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        pushFragments(collector, frags3Chunks);
        expect(chunks).toHaveLength(3);
    });

    it("chunk 0: [0, CHUNK_DURATION_MS]", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        pushFragments(collector, frags3Chunks);
        expect(chunks[0].start).toBe(0);
        expect(chunks[0].end).toBe(CHUNK_DURATION_MS);
    });

    it("chunk 1: [CHUNK_DURATION_MS - OVERLAP_MS, 2*CHUNK_DURATION_MS - OVERLAP_MS]", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        pushFragments(collector, frags3Chunks);
        const s = CHUNK_DURATION_MS - OVERLAP_MS;
        expect(chunks[1].start).toBe(s);
        expect(chunks[1].end).toBe(s + CHUNK_DURATION_MS);
    });

    it("chunk 2 starts 10 s before chunk 1 ends", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        pushFragments(collector, frags3Chunks);
        expect(chunks[1].end - chunks[2].start).toBe(OVERLAP_MS);
    });

    it("consecutive chunks all overlap by exactly OVERLAP_MS", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        pushFragments(collector, frags3Chunks);
        for (let i = 1; i < chunks.length; i++) {
            const overlapWidth = chunks[i - 1].end - chunks[i].start;
            expect(overlapWidth).toBe(OVERLAP_MS);
        }
    });
});

// ─── Fragment spanning chunk boundary ────────────────────────────────────────

describe("AudioChunkCollector: fragment spanning boundary", () => {
    it("triggers emission when a large fragment crosses the threshold", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        pushFragments(collector, 29);
        collector.push(makeBlob("big"), 290000, 310000);
        expect(chunks).toHaveLength(1);
    });

    it("single fragment spanning two chunk windows produces two chunks with actual fragment coverage", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        // A single fragment spanning 0–600 s: both windows include it, so
        // declared bounds reflect actual fragment coverage (not the ideal window).
        collector.push(makeBlob("huge"), 0, 600000);
        expect(chunks).toHaveLength(2);
        expect(chunks[0].start).toBe(0);
        expect(chunks[0].end).toBe(600000); // actual fragment end (not CHUNK_DURATION_MS)
        expect(chunks[1].start).toBe(0);    // actual fragment start (not CHUNK_DURATION_MS - OVERLAP_MS)
        expect(chunks[1].end).toBe(600000); // actual fragment end
    });
});
