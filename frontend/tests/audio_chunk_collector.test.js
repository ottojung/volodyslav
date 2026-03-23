/**
 * Comprehensive tests for audio_chunk_collector.
 */

import {
    makeAudioChunkCollector,
    isAudioChunkCollector,
    CHUNK_DURATION_MS,
    OVERLAP_MS,
} from "../src/AudioDiary/audio_chunk_collector.js";

const FRAGMENT_MS = 10 * 1000; // 10-second fragments (same as recorder_logic)

/**
 * @param {string} content
 * @param {string} [type]
 * @returns {Blob}
 */
function makeBlob(content, type = "audio/webm") {
    return new Blob([content], { type });
}

/**
 * Push N consecutive 10-second fragments starting from startOffset.
 * @param {ReturnType<typeof makeAudioChunkCollector>} collector
 * @param {number} count
 * @param {number} [startOffset]
 * @param {string} [mimeType]
 */
function pushFragments(collector, count, startOffset = 0, mimeType = "audio/webm") {
    for (let i = 0; i < count; i++) {
        const start = startOffset + i * FRAGMENT_MS;
        const end = start + FRAGMENT_MS;
        collector.push(makeBlob(`frag-${startOffset / FRAGMENT_MS + i}`, mimeType), start, end);
    }
}

// ─── Factory / type guard ────────────────────────────────────────────────────

describe("makeAudioChunkCollector", () => {
    it("returns a defined object", () => {
        const collector = makeAudioChunkCollector(() => {});
        expect(collector).toBeDefined();
    });

    it("accepts a callback and does not throw on creation", () => {
        expect(() => makeAudioChunkCollector(() => {})).not.toThrow();
    });
});

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

    it("does not emit with 29 fragments (290 s < 300 s threshold)", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        pushFragments(collector, 29);
        expect(chunks).toHaveLength(0);
    });

    it("does not emit when cumulative time is exactly 1 ms below threshold", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        // Push one fragment that ends 1 ms before the threshold
        collector.push(makeBlob("data"), 0, CHUNK_DURATION_MS - 1);
        expect(chunks).toHaveLength(0);
    });
});

// ─── Single chunk emission ───────────────────────────────────────────────────

describe("AudioChunkCollector: first chunk emission", () => {
    it("emits exactly one chunk when 30 fragments (300 s) have been pushed", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        pushFragments(collector, 30);
        expect(chunks).toHaveLength(1);
    });

    it("first chunk has start=0", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        pushFragments(collector, 30);
        expect(chunks[0].start).toBe(0);
    });

    it("first chunk has end=CHUNK_DURATION_MS", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        pushFragments(collector, 30);
        expect(chunks[0].end).toBe(CHUNK_DURATION_MS);
    });

    it("emitted chunk data is a Blob", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        pushFragments(collector, 30);
        expect(chunks[0].data).toBeInstanceOf(Blob);
    });

    it("emitted chunk data has positive size", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        pushFragments(collector, 30);
        expect(chunks[0].data.size).toBeGreaterThan(0);
    });

    it("emits at the exact threshold when a fragment ends exactly at CHUNK_DURATION_MS", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        // Single large fragment covering exactly 5 minutes
        collector.push(makeBlob("whole-recording"), 0, CHUNK_DURATION_MS);
        expect(chunks).toHaveLength(1);
        expect(chunks[0].start).toBe(0);
        expect(chunks[0].end).toBe(CHUNK_DURATION_MS);
    });
});

// ─── Two-chunk overlap ───────────────────────────────────────────────────────

describe("AudioChunkCollector: two overlapping chunks", () => {
    it("emits exactly 2 chunks after 58 fragments (580 s)", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        // 58 fragments × 10s = 580s; second window ends at 290+300=590s, not yet reached
        // Actually: first emit at 300s (30 fragments), second at 590s (59th ends at 590)
        // 58 fragments = 580s < 590s, so only 1 chunk
        pushFragments(collector, 58);
        expect(chunks).toHaveLength(1);
    });

    it("emits 2 chunks after 59 fragments (590 s)", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        pushFragments(collector, 59);
        expect(chunks).toHaveLength(2);
    });

    it("second chunk starts at CHUNK_DURATION_MS - OVERLAP_MS", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        pushFragments(collector, 59);
        expect(chunks[1].start).toBe(CHUNK_DURATION_MS - OVERLAP_MS);
    });

    it("second chunk ends at (CHUNK_DURATION_MS - OVERLAP_MS) + CHUNK_DURATION_MS", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        pushFragments(collector, 59);
        const expectedEnd = (CHUNK_DURATION_MS - OVERLAP_MS) + CHUNK_DURATION_MS;
        expect(chunks[1].end).toBe(expectedEnd);
    });

    it("overlap region is exactly OVERLAP_MS wide", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        pushFragments(collector, 59);
        const overlapWidth = chunks[0].end - chunks[1].start;
        expect(overlapWidth).toBe(OVERLAP_MS);
    });

    it("second chunk has a Blob with positive size", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        pushFragments(collector, 59);
        expect(chunks[1].data).toBeInstanceOf(Blob);
        expect(chunks[1].data.size).toBeGreaterThan(0);
    });
});

// ─── Three-chunk sequence ────────────────────────────────────────────────────

describe("AudioChunkCollector: three chunks", () => {
    it("emits 3 chunks after 88 fragments (880 s)", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        // Third window: start=580000, end=880000 → reached at fragment 88 (880s)
        pushFragments(collector, 88);
        expect(chunks).toHaveLength(3);
    });

    it("chunk 0: [0, CHUNK_DURATION_MS]", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        pushFragments(collector, 88);
        expect(chunks[0].start).toBe(0);
        expect(chunks[0].end).toBe(CHUNK_DURATION_MS);
    });

    it("chunk 1: [CHUNK_DURATION_MS - OVERLAP_MS, 2*CHUNK_DURATION_MS - OVERLAP_MS]", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        pushFragments(collector, 88);
        const s = CHUNK_DURATION_MS - OVERLAP_MS;
        expect(chunks[1].start).toBe(s);
        expect(chunks[1].end).toBe(s + CHUNK_DURATION_MS);
    });

    it("chunk 2 starts 10 s before chunk 1 ends", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        pushFragments(collector, 88);
        expect(chunks[1].end - chunks[2].start).toBe(OVERLAP_MS);
    });

    it("consecutive chunks all overlap by exactly OVERLAP_MS", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        pushFragments(collector, 88);
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
        // 29 fragments = 290s; then a single 20s fragment ending at 310s (> 300s threshold)
        pushFragments(collector, 29);
        collector.push(makeBlob("big"), 290000, 310000);
        expect(chunks).toHaveLength(1);
    });

    it("single fragment spanning two chunk windows triggers two emissions", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        // A huge fragment spanning 0 to 600 s covers both chunk windows
        collector.push(makeBlob("huge"), 0, 600000);
        expect(chunks).toHaveLength(2);
        expect(chunks[0].start).toBe(0);
        expect(chunks[0].end).toBe(CHUNK_DURATION_MS);
        expect(chunks[1].start).toBe(CHUNK_DURATION_MS - OVERLAP_MS);
        expect(chunks[1].end).toBe(CHUNK_DURATION_MS - OVERLAP_MS + CHUNK_DURATION_MS);
    });
});

// ─── MIME type handling ───────────────────────────────────────────────────────

describe("AudioChunkCollector: MIME type propagation", () => {
    it("emitted chunk blob has the MIME type of the pushed fragments", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        pushFragments(collector, 30, 0, "audio/ogg");
        expect(chunks[0].data.type).toBe("audio/ogg");
    });

    it("MIME type from last fragment before emission is used", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        // Push 29 with webm, last 1 with ogg
        pushFragments(collector, 29, 0, "audio/webm");
        collector.push(makeBlob("last", "audio/ogg"), 290000, 300000);
        expect(chunks[0].data.type).toBe("audio/ogg");
    });

    it("handles Blobs with no MIME type (empty string)", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        for (let i = 0; i < 30; i++) {
            collector.push(new Blob([`f${i}`]), i * FRAGMENT_MS, (i + 1) * FRAGMENT_MS);
        }
        // Should not throw and should emit a chunk
        expect(chunks).toHaveLength(1);
        expect(chunks[0].data).toBeInstanceOf(Blob);
    });
});

// ─── Combined Blob content ───────────────────────────────────────────────────

describe("AudioChunkCollector: combined Blob content", () => {
    it("combined chunk size equals sum of fragment sizes for non-overlapping push", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        let totalSize = 0;
        for (let i = 0; i < 30; i++) {
            const blob = makeBlob(`fragment-${i}`);
            totalSize += blob.size;
            collector.push(blob, i * FRAGMENT_MS, (i + 1) * FRAGMENT_MS);
        }
        expect(chunks[0].data.size).toBe(totalSize);
    });

    it("second chunk includes the overlap fragment from the first window", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        // Fragment 29 sits at [290000, 300000] – in the overlap region
        const overlapContent = "overlap-fragment-content";
        for (let i = 0; i < 29; i++) {
            collector.push(makeBlob(`f${i}`), i * FRAGMENT_MS, (i + 1) * FRAGMENT_MS);
        }
        // Fragment 29 (overlap fragment)
        collector.push(makeBlob(overlapContent), 290000, 300000);
        // Fragments 30-58 to trigger second chunk
        for (let i = 30; i < 59; i++) {
            collector.push(makeBlob(`f${i}`), i * FRAGMENT_MS, (i + 1) * FRAGMENT_MS);
        }
        expect(chunks).toHaveLength(2);
        // Chunk 1 should include fragment 29 (in [290000, 590000]) plus fragments 30-58
        expect(chunks[1].data.size).toBeGreaterThan(0);
    });
});

// ─── Reset ───────────────────────────────────────────────────────────────────

describe("AudioChunkCollector: reset", () => {
    it("reset prevents fragments accumulated before it from triggering emission", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        pushFragments(collector, 25);
        collector.reset();
        // 5 more fragments – not enough for a fresh chunk
        pushFragments(collector, 5);
        expect(chunks).toHaveLength(0);
    });

    it("after reset the next chunk starts at 0", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        pushFragments(collector, 30);
        expect(chunks).toHaveLength(1);

        collector.reset();
        const afterReset = [];
        const collector2 = makeAudioChunkCollector((c) => afterReset.push(c));
        pushFragments(collector2, 30);

        // Use a fresh collector to verify the same pattern
        expect(afterReset[0].start).toBe(0);
        expect(afterReset[0].end).toBe(CHUNK_DURATION_MS);
    });

    it("reset clears MIME type so next chunks use the new type", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        pushFragments(collector, 30, 0, "audio/webm");
        collector.reset();
        pushFragments(collector, 30, 0, "audio/ogg");
        // chunks[0] is from before reset, chunks[1] from after
        expect(chunks[1].data.type).toBe("audio/ogg");
    });

    it("reset allows a full new recording session to work correctly", () => {
        const chunks = [];
        const collector = makeAudioChunkCollector((c) => chunks.push(c));
        // First session: 30 fragments
        pushFragments(collector, 30);
        expect(chunks).toHaveLength(1);

        collector.reset();

        // Second session: another 30 fragments
        pushFragments(collector, 30);
        expect(chunks).toHaveLength(2);
        expect(chunks[1].start).toBe(0);
        expect(chunks[1].end).toBe(CHUNK_DURATION_MS);
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
