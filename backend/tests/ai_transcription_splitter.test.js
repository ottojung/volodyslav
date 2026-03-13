/**
 * Tests for the audio splitter module.
 * All external commands (ffprobe / ffmpeg) are mocked so no real binaries are required.
 */

const path = require("path");
const {
    parseSilenceEvents,
    pickCutPoint,
    getAudioInfo,
    splitIntoChunks,
} = require("../src/ai/transcription_splitter");
const {
    planChunks,
    MAX_SAFE_FILE_SIZE_BYTES,
    TARGET_CHUNK_DURATION_MS,
    MAX_CHUNK_DURATION_MS,
    OVERLAP_MS,
} = require("../src/ai/transcription_chunk_plan");

// ---------------------------------------------------------------------------
// Helpers: build minimal mock capabilities
// ---------------------------------------------------------------------------

/**
 * Creates a mock SplitterCapabilities object.
 * @param {object} overrides
 * @returns {object}
 */
function makeCaps(overrides = {}) {
    return {
        ffprobe: {
            call: jest.fn().mockResolvedValue({ stdout: '{"format":{"duration":"60.0","size":"1048576"}}', stderr: "" }),
        },
        ffmpeg: {
            call: jest.fn().mockResolvedValue({ stdout: "", stderr: "" }),
        },
        creator: {
            createTemporaryDirectory: jest.fn().mockResolvedValue("/tmp/fake"),
        },
        checker: {
            // Simulate successful file existence check, returning a minimal ExistingFile-like object
            fileExists: jest.fn().mockImplementation((p) => Promise.resolve({ path: p })),
        },
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// parseSilenceEvents – pure function
// ---------------------------------------------------------------------------

describe("parseSilenceEvents", () => {
    const sampleStderr = `
[silencedetect @ 0x] silence_start: 5.000000
[silencedetect @ 0x] silence_end: 5.500000 | silence_duration: 0.500000
[silencedetect @ 0x] silence_start: 12.000000
[silencedetect @ 0x] silence_end: 12.800000 | silence_duration: 0.800000
`;

    test("parses silence start and end events", () => {
        const events = parseSilenceEvents(sampleStderr);
        expect(events).toHaveLength(2);
    });

    test("converts to milliseconds", () => {
        const events = parseSilenceEvents(sampleStderr);
        expect(events[0].startMs).toBe(5000);
        expect(events[0].endMs).toBe(5500);
    });

    test("second silence event is correct", () => {
        const events = parseSilenceEvents(sampleStderr);
        expect(events[1].startMs).toBe(12000);
        expect(events[1].endMs).toBe(12800);
    });

    test("returns empty array for empty stderr", () => {
        expect(parseSilenceEvents("")).toEqual([]);
    });

    test("handles mismatched starts/ends gracefully", () => {
        const partial = "[silencedetect] silence_start: 3.0\n";
        const events = parseSilenceEvents(partial);
        // Only 1 start, 0 ends – should return 0 complete events
        expect(events).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// pickCutPoint – pure function
// ---------------------------------------------------------------------------

describe("pickCutPoint", () => {
    const silences = [
        { startMs: 4500, endMs: 5500 },   // mid = 5000ms
        { startMs: 11500, endMs: 12500 },  // mid = 12000ms
    ];

    test("picks silence midpoint closest to target within tolerance", () => {
        const cut = pickCutPoint(silences, 5000, 2000);
        expect(cut).toBe(5000);
    });

    test("returns hard target when no silence is within tolerance", () => {
        const cut = pickCutPoint(silences, 8000, 1000);
        expect(cut).toBe(8000);
    });

    test("picks the closer of two nearby silences", () => {
        const cut = pickCutPoint(silences, 11800, 3000);
        expect(cut).toBe(12000);
    });

    test("returns target unchanged when silences list is empty", () => {
        expect(pickCutPoint([], 7000, 2000)).toBe(7000);
    });
});

// ---------------------------------------------------------------------------
// getAudioInfo
// ---------------------------------------------------------------------------

describe("getAudioInfo", () => {
    test("parses duration and size from ffprobe JSON output", async () => {
        const caps = makeCaps();
        const info = await getAudioInfo(caps, "/fake/audio.mp3");
        expect(info.durationMs).toBe(60000);
        expect(info.sizeBytes).toBe(1048576);
    });

    test("calls ffprobe with the file path", async () => {
        const caps = makeCaps();
        await getAudioInfo(caps, "/fake/audio.mp3");
        expect(caps.ffprobe.call).toHaveBeenCalledWith(
            "-v", "quiet",
            "-print_format", "json",
            "-show_format",
            "/fake/audio.mp3"
        );
    });

    test("throws SplitterError when ffprobe fails", async () => {
        const caps = makeCaps({
            ffprobe: { call: jest.fn().mockRejectedValue(new Error("not found")) },
        });
        await expect(getAudioInfo(caps, "/fake/audio.mp3")).rejects.toThrow("ffprobe failed");
    });

    test("throws SplitterError when ffprobe returns invalid JSON", async () => {
        const caps = makeCaps({
            ffprobe: { call: jest.fn().mockResolvedValue({ stdout: "not-json", stderr: "" }) },
        });
        await expect(getAudioInfo(caps, "/fake/audio.mp3")).rejects.toThrow("not valid JSON");
    });
});

// ---------------------------------------------------------------------------
// splitIntoChunks (mocked ffmpeg)
// ---------------------------------------------------------------------------

describe("splitIntoChunks", () => {
    /**
     * Helper: build chunk specs for a given duration via planChunks.
     * @param {number} fileSizeBytes
     * @param {number} durationMs
     */
    function specs(fileSizeBytes, durationMs) {
        return planChunks(fileSizeBytes, durationMs);
    }

    test("returns single path for short audio (no split needed)", async () => {
        const caps = makeCaps();
        const plan = specs(512, 30_000);
        const paths = await splitIntoChunks(caps, "/audio.mp3", plan, "/tmp/out");
        expect(paths).toHaveLength(1);
        expect(caps.ffmpeg.call).toHaveBeenCalledTimes(1);
    });

    test("returns multiple paths for long audio", async () => {
        const caps = makeCaps();
        const plan = specs(MAX_SAFE_FILE_SIZE_BYTES + 1, TARGET_CHUNK_DURATION_MS * 3);
        const paths = await splitIntoChunks(caps, "/audio.mp3", plan, "/tmp/out");
        expect(paths.length).toBe(plan.length);
        expect(caps.ffmpeg.call).toHaveBeenCalledTimes(plan.length);
    });

    test("paths are ordered by chunk index", async () => {
        const caps = makeCaps();
        const plan = specs(MAX_SAFE_FILE_SIZE_BYTES + 1, TARGET_CHUNK_DURATION_MS * 2);
        const paths = await splitIntoChunks(caps, "/audio.mp3", plan, "/tmp/out");
        for (let i = 0; i < paths.length; i++) {
            expect(paths[i]).toContain(`chunk_${i}`);
        }
    });

    test("each ffmpeg call uses the correct time slice", async () => {
        const caps = makeCaps();
        const BIG = MAX_SAFE_FILE_SIZE_BYTES + 1;
        // Use a duration that yields exactly 2 chunks
        const plan = specs(BIG, MAX_CHUNK_DURATION_MS + 1000);
        await splitIntoChunks(caps, "/audio.mp3", plan, "/tmp/out");

        const firstCall = caps.ffmpeg.call.mock.calls[0];
        const ssIndex = firstCall.indexOf("-ss");
        expect(ssIndex).toBeGreaterThan(-1);
        expect(firstCall[ssIndex + 1]).toBe("0.000");  // chunk 0 starts at 0
    });

    test("preserves file extension in output paths", async () => {
        const caps = makeCaps();
        const plan = specs(MAX_SAFE_FILE_SIZE_BYTES + 1, TARGET_CHUNK_DURATION_MS * 2);
        const paths = await splitIntoChunks(caps, "/audio.flac", plan, "/tmp/out");
        for (const p of paths) {
            expect(path.extname(p)).toBe(".flac");
        }
    });
});

// ---------------------------------------------------------------------------
// Integration: chunk plan + split (file that doesn't need chunking)
// ---------------------------------------------------------------------------

describe("splitter integration – no chunking", () => {
    test("single chunk covers full duration with overlap 0", async () => {
        const plan = planChunks(1024, 30_000);
        expect(plan).toHaveLength(1);
        expect(plan[0]).toEqual({ index: 0, startMs: 0, endMs: 30_000, overlapBeforeMs: 0 });
    });
});

// ---------------------------------------------------------------------------
// Integration: chunk plan + split (file that splits on hard time boundary)
// ---------------------------------------------------------------------------

describe("splitter integration – hard time boundary split", () => {
    test("all chunks have correct overlap size", () => {
        const BIG = MAX_SAFE_FILE_SIZE_BYTES + 1;
        const LONG = TARGET_CHUNK_DURATION_MS * 3;
        const plan = planChunks(BIG, LONG);
        for (let i = 1; i < plan.length; i++) {
            expect(plan[i].overlapBeforeMs).toBe(OVERLAP_MS);
        }
    });

    test("adjacent chunks overlap by OVERLAP_MS in time", () => {
        const BIG = MAX_SAFE_FILE_SIZE_BYTES + 1;
        const LONG = TARGET_CHUNK_DURATION_MS * 3;
        const plan = planChunks(BIG, LONG);
        for (let i = 1; i < plan.length; i++) {
            const overlapActual = plan[i - 1].endMs - plan[i].startMs;
            expect(overlapActual).toBe(OVERLAP_MS);
        }
    });

    test("total covered range is 0 to full duration", () => {
        const BIG = MAX_SAFE_FILE_SIZE_BYTES + 1;
        const LONG = TARGET_CHUNK_DURATION_MS * 4;
        const plan = planChunks(BIG, LONG);
        expect(plan[0].startMs).toBe(0);
        expect(plan[plan.length - 1].endMs).toBe(LONG);
    });
});

// ---------------------------------------------------------------------------
// Integration: multilingual fixture names
// ---------------------------------------------------------------------------

describe("splitter – multilingual path handling", () => {
    test("handles file with non-ASCII characters in path", async () => {
        const caps = makeCaps();
        const plan = planChunks(1024, 30_000);
        const paths = await splitIntoChunks(caps, "/録音/フォルダ/audio.mp3", plan, "/tmp/out");
        expect(paths).toHaveLength(1);
    });
});
