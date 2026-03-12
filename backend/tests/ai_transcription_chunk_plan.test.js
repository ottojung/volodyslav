/**
 * Tests for the pure chunk-planning logic in transcription_chunk_plan.js.
 */

const {
    planChunks,
    shouldChunk,
    buildContinuityPrompt,
    MAX_SAFE_FILE_SIZE_BYTES,
    TARGET_CHUNK_DURATION_MS,
    MAX_CHUNK_DURATION_MS,
    OVERLAP_MS,
} = require("../src/ai/transcription_chunk_plan");

// ---------------------------------------------------------------------------
// shouldChunk
// ---------------------------------------------------------------------------

describe("shouldChunk", () => {
    test("returns false for small short file", () => {
        expect(shouldChunk(1024, 60_000)).toBe(false);
    });

    test("returns true when file size exceeds safe threshold", () => {
        expect(shouldChunk(MAX_SAFE_FILE_SIZE_BYTES + 1, 60_000)).toBe(true);
    });

    test("returns true when duration exceeds target chunk duration", () => {
        expect(shouldChunk(1024, TARGET_CHUNK_DURATION_MS + 1)).toBe(true);
    });

    test("returns false at exactly the safe file size", () => {
        expect(shouldChunk(MAX_SAFE_FILE_SIZE_BYTES, TARGET_CHUNK_DURATION_MS - 1)).toBe(false);
    });

    test("returns false at exactly the target duration", () => {
        expect(shouldChunk(1024, TARGET_CHUNK_DURATION_MS)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// planChunks – single chunk path
// ---------------------------------------------------------------------------

describe("planChunks – no split needed", () => {
    test("returns single spec covering full duration for small file", () => {
        const specs = planChunks(1024, 60_000);
        expect(specs).toHaveLength(1);
        expect(specs[0]).toEqual({ index: 0, startMs: 0, endMs: 60_000, overlapBeforeMs: 0 });
    });

    test("single spec has zero overlap", () => {
        const specs = planChunks(512, 30_000);
        expect(specs[0].overlapBeforeMs).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// planChunks – multi-chunk path
// ---------------------------------------------------------------------------

describe("planChunks – split needed", () => {
    /** 10-minute audio with a large file */
    const LONG_DURATION = 10 * 60 * 1000;
    const BIG_FILE = MAX_SAFE_FILE_SIZE_BYTES + 1024;

    test("produces more than one chunk for long audio", () => {
        const specs = planChunks(BIG_FILE, LONG_DURATION);
        expect(specs.length).toBeGreaterThan(1);
    });

    test("chunks are sorted by index ascending", () => {
        const specs = planChunks(BIG_FILE, LONG_DURATION);
        for (let i = 0; i < specs.length; i++) {
            expect(specs[i].index).toBe(i);
        }
    });

    test("first chunk has no overlap", () => {
        const specs = planChunks(BIG_FILE, LONG_DURATION);
        expect(specs[0].overlapBeforeMs).toBe(0);
    });

    test("subsequent chunks have OVERLAP_MS overlap", () => {
        const specs = planChunks(BIG_FILE, LONG_DURATION);
        for (let i = 1; i < specs.length; i++) {
            expect(specs[i].overlapBeforeMs).toBe(OVERLAP_MS);
        }
    });

    test("adjacent chunks overlap in time", () => {
        const specs = planChunks(BIG_FILE, LONG_DURATION);
        for (let i = 1; i < specs.length; i++) {
            expect(specs[i].startMs).toBeLessThan(specs[i - 1].endMs);
        }
    });

    test("every chunk ends at or before total duration", () => {
        const specs = planChunks(BIG_FILE, LONG_DURATION);
        for (const spec of specs) {
            expect(spec.endMs).toBeLessThanOrEqual(LONG_DURATION);
        }
    });

    test("no chunk exceeds MAX_CHUNK_DURATION_MS", () => {
        const specs = planChunks(BIG_FILE, LONG_DURATION);
        for (const spec of specs) {
            expect(spec.endMs - spec.startMs).toBeLessThanOrEqual(MAX_CHUNK_DURATION_MS);
        }
    });

    test("last chunk ends at total duration", () => {
        const specs = planChunks(BIG_FILE, LONG_DURATION);
        const last = specs[specs.length - 1];
        expect(last.endMs).toBe(LONG_DURATION);
    });

    test("deterministic output – same inputs produce identical specs", () => {
        const specA = planChunks(BIG_FILE, LONG_DURATION);
        const specB = planChunks(BIG_FILE, LONG_DURATION);
        expect(specA).toEqual(specB);
    });

    test("all of duration is covered (union of chunks spans 0 to total)", () => {
        const specs = planChunks(BIG_FILE, LONG_DURATION);
        expect(specs[0].startMs).toBe(0);
        expect(specs[specs.length - 1].endMs).toBe(LONG_DURATION);
    });
});

// ---------------------------------------------------------------------------
// planChunks – edge cases
// ---------------------------------------------------------------------------

describe("planChunks – edge cases", () => {
    test("handles exactly MAX_CHUNK_DURATION_MS duration without overlap trouble", () => {
        const specs = planChunks(BIG_FILE, MAX_CHUNK_DURATION_MS);
        expect(specs.length).toBeGreaterThanOrEqual(1);
        expect(specs[specs.length - 1].endMs).toBe(MAX_CHUNK_DURATION_MS);
    });

    test("very long audio produces many chunks", () => {
        const HOUR = 60 * 60 * 1000;
        const specs = planChunks(BIG_FILE, HOUR);
        expect(specs.length).toBeGreaterThan(5);
    });
});

const BIG_FILE = MAX_SAFE_FILE_SIZE_BYTES + 1024;

// ---------------------------------------------------------------------------
// buildContinuityPrompt
// ---------------------------------------------------------------------------

describe("buildContinuityPrompt", () => {
    test("returns full text when shorter than maxChars", () => {
        const text = "Hello world.";
        expect(buildContinuityPrompt(text, 200)).toBe("Hello world.");
    });

    test("trims to word boundary when text exceeds maxChars", () => {
        const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
        const result = buildContinuityPrompt(words, 50);
        expect(result.length).toBeLessThanOrEqual(50);
        expect(result).not.toMatch(/^\s/);
    });

    test("default maxChars is 224", () => {
        const longText = "a ".repeat(200);
        const result = buildContinuityPrompt(longText);
        expect(result.length).toBeLessThanOrEqual(224);
    });

    test("returns empty string for empty input", () => {
        expect(buildContinuityPrompt("")).toBe("");
    });

    test("never starts with a space", () => {
        const text = "one two three four five six seven eight nine ten eleven twelve";
        const result = buildContinuityPrompt(text, 20);
        expect(result).not.toMatch(/^\s/);
    });
});
