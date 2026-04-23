const { _runPullCycle } = require("../src/live_diary/pull_cycle");
const {
    writeFragmentIndex,
    writeKnownGaps,
    writeTranscribedUntilMs,
    readTranscribedUntilMs,
    readKnownGaps,
} = require("../src/live_diary/session_state");
const { MAX_NEW_AUDIO_MS } = require("../src/live_diary/planner");
const { startSession, chunksBinarySublevel, chunkKey } = require("../src/audio_recording_session");
const { getMockedRootCapabilities } = require("./spies");
const {
    stubEnvironment,
    stubLogger,
    stubDatetime,
    stubAiTranscriber,
    stubAiDiaryQuestions,
    stubAiTranscriptRecombination,
} = require("./stubs");
const { TEST_PCM_FORMAT } = require("./pcm_helpers");

const SESSION_ID = "pull-cycle-test-session";

// Low sample rate used by window-cap tests to keep PCM buffers tiny
// (100 Hz × 16-bit mono = 200 bytes per second).
const LOW_RATE_FORMAT = { sampleRateHz: 100, channels: 1, bitDepth: 16 };

function makeCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubAiTranscriber(capabilities);
    stubAiDiaryQuestions(capabilities);
    stubAiTranscriptRecombination(capabilities);
    return capabilities;
}

async function seedRangeWithGap(capabilities, nowMs = 1_000_000) {
    await startSession(capabilities, SESSION_ID);
    await writeTranscribedUntilMs(capabilities.temporary, SESSION_ID, 0);
    await writeKnownGaps(capabilities.temporary, SESSION_ID, []);
    await writeFragmentIndex(capabilities.temporary, SESSION_ID, {
        sequence: 0,
        startMs: 0,
        endMs: 10_000,
        contentHash: "frag-0",
        ingestedAtMs: nowMs - 5_000,
        sampleRateHz: TEST_PCM_FORMAT.sampleRateHz,
        channels: TEST_PCM_FORMAT.channels,
        bitDepth: TEST_PCM_FORMAT.bitDepth,
    });
    await writeFragmentIndex(capabilities.temporary, SESSION_ID, {
        sequence: 1,
        startMs: 20_000,
        endMs: 30_000,
        contentHash: "frag-1",
        ingestedAtMs: nowMs - 4_000,
        sampleRateHz: TEST_PCM_FORMAT.sampleRateHz,
        channels: TEST_PCM_FORMAT.channels,
        bitDepth: TEST_PCM_FORMAT.bitDepth,
    });
}

async function seedContiguousRange(capabilities, nowMs = 1_000_000) {
    await startSession(capabilities, SESSION_ID);
    await writeTranscribedUntilMs(capabilities.temporary, SESSION_ID, 0);
    await writeKnownGaps(capabilities.temporary, SESSION_ID, []);
    await writeFragmentIndex(capabilities.temporary, SESSION_ID, {
        sequence: 0,
        startMs: 0,
        endMs: 10_000,
        contentHash: "frag-0",
        ingestedAtMs: nowMs - 5_000,
        sampleRateHz: TEST_PCM_FORMAT.sampleRateHz,
        channels: TEST_PCM_FORMAT.channels,
        bitDepth: TEST_PCM_FORMAT.bitDepth,
    });
    await writeFragmentIndex(capabilities.temporary, SESSION_ID, {
        sequence: 1,
        startMs: 10_000,
        endMs: 20_000,
        contentHash: "frag-1",
        ingestedAtMs: nowMs - 4_000,
        sampleRateHz: TEST_PCM_FORMAT.sampleRateHz,
        channels: TEST_PCM_FORMAT.channels,
        bitDepth: TEST_PCM_FORMAT.bitDepth,
    });
}

async function seedRangeWithPreAgedGap(capabilities, nowMs = 1_000_000) {
    await startSession(capabilities, SESSION_ID);
    await writeTranscribedUntilMs(capabilities.temporary, SESSION_ID, 0);
    await writeKnownGaps(capabilities.temporary, SESSION_ID, [
        { startMs: 10_000, endMs: 20_000, firstObservedAtMs: nowMs - 60_000, status: "waiting" },
    ]);
    await writeFragmentIndex(capabilities.temporary, SESSION_ID, {
        sequence: 0,
        startMs: 0,
        endMs: 10_000,
        contentHash: "frag-0",
        ingestedAtMs: nowMs - 5_000,
        sampleRateHz: TEST_PCM_FORMAT.sampleRateHz,
        channels: TEST_PCM_FORMAT.channels,
        bitDepth: TEST_PCM_FORMAT.bitDepth,
    });
    await writeFragmentIndex(capabilities.temporary, SESSION_ID, {
        sequence: 1,
        startMs: 20_000,
        endMs: 30_000,
        contentHash: "frag-1",
        ingestedAtMs: nowMs - 4_000,
        // Intentional mismatch vs sequence 0 to force assembler format failure.
        sampleRateHz: 44_100,
        channels: TEST_PCM_FORMAT.channels,
        bitDepth: TEST_PCM_FORMAT.bitDepth,
    });
}

async function putChunk(temporary, sessionId, sequence, byteLength = 16000) {
    const chunks = chunksBinarySublevel(temporary, sessionId);
    await chunks.put(chunkKey(sequence), Buffer.alloc(byteLength, 0x01));
}

describe("_runPullCycle degraded exits", () => {
    it("does not advance watermark when a planned-window fragment index exists but binary chunk is missing", async () => {
        const caps = makeCapabilities();
        const nowMs = 1_000_000;
        await seedContiguousRange(caps, nowMs);
        await putChunk(caps.temporary, SESSION_ID, 0);
        // Sequence 1 intentionally has index metadata but no stored binary.

        const result = await _runPullCycle(caps, SESSION_ID, 30_000, nowMs, 10_000);

        expect(result.status).toBe("degraded_transcription");
        expect(await readTranscribedUntilMs(caps.temporary, SESSION_ID)).toBe(0);
        expect(await readKnownGaps(caps.temporary, SESSION_ID)).toEqual([]);
    });

    it("persists updated gaps on assembler failure without advancing watermark", async () => {
        const caps = makeCapabilities();
        const nowMs = 1_000_000;
        await seedRangeWithPreAgedGap(caps, nowMs);
        await putChunk(caps.temporary, SESSION_ID, 0);
        await putChunk(caps.temporary, SESSION_ID, 1);

        const result = await _runPullCycle(caps, SESSION_ID, 30_000, nowMs, 10_000);

        expect(result.status).toBe("degraded_transcription");
        expect(await readTranscribedUntilMs(caps.temporary, SESSION_ID)).toBe(0);

        const gaps = await readKnownGaps(caps.temporary, SESSION_ID);
        expect(gaps).toHaveLength(1);
        expect(gaps[0]?.startMs).toBe(10_000);
        expect(gaps[0]?.endMs).toBe(20_000);
    });

    it("persists updated gaps on transcription failure without advancing watermark", async () => {
        const caps = makeCapabilities();
        const nowMs = 1_000_000;
        await seedRangeWithGap(caps, nowMs);
        await putChunk(caps.temporary, SESSION_ID, 0);
        await putChunk(caps.temporary, SESSION_ID, 1);
        caps.aiTranscription.transcribeStreamPreciseDetailed = jest.fn().mockRejectedValue(new Error("transcribe failed"));

        const result = await _runPullCycle(caps, SESSION_ID, 30_000, nowMs, 10_000);

        expect(result.status).toBe("degraded_transcription");
        expect(await readTranscribedUntilMs(caps.temporary, SESSION_ID)).toBe(0);

        const gaps = await readKnownGaps(caps.temporary, SESSION_ID);
        expect(gaps).toHaveLength(1);
        expect(gaps[0]?.startMs).toBe(10_000);
        expect(gaps[0]?.endMs).toBe(20_000);
    });

    it("persists updated gaps on question-generation failure without advancing watermark", async () => {
        const caps = makeCapabilities();
        const nowMs = 1_000_000;
        await seedRangeWithGap(caps, nowMs);
        await putChunk(caps.temporary, SESSION_ID, 0);
        await putChunk(caps.temporary, SESSION_ID, 1);
        caps.aiTranscription.transcribeStreamPreciseDetailed = jest.fn().mockResolvedValue({
            text: "this transcript should absolutely trigger question generation now because it has many words",
            provider: "Google",
            model: "mocked",
            finishReason: "STOP",
            finishMessage: null,
            candidateTokenCount: 0,
            usageMetadata: null,
            modelVersion: null,
            responseId: null,
            structured: { transcript: "this transcript should absolutely trigger question generation now because it has many words", coverage: "full", warnings: [], unclearAudio: false },
            rawResponse: null,
        });
        caps.aiDiaryQuestions.generateQuestions = jest.fn().mockRejectedValue(new Error("qgen failed"));

        const result = await _runPullCycle(caps, SESSION_ID, 30_000, nowMs, 10_000);

        expect(result.status).toBe("degraded_question_generation");
        expect(await readTranscribedUntilMs(caps.temporary, SESSION_ID)).toBe(0);

        const gaps = await readKnownGaps(caps.temporary, SESSION_ID);
        expect(gaps).toHaveLength(1);
        expect(gaps[0]?.startMs).toBe(10_000);
        expect(gaps[0]?.endMs).toBe(20_000);
    });
});

describe("_runPullCycle window cap", () => {
    // Helper: compute the PCM byte size for a given duration at the low-rate format.
    function pcmBytesForMs(durationMs) {
        return Math.ceil(durationMs * LOW_RATE_FORMAT.sampleRateHz / 1000) *
            (LOW_RATE_FORMAT.bitDepth / 8) * LOW_RATE_FORMAT.channels;
    }

    it("advances watermark only to transcribedUntilMs + MAX_NEW_AUDIO_MS when processableEndMs exceeds the cap", async () => {
        const caps = makeCapabilities();
        const nowMs = 1_000_000;
        await startSession(caps, SESSION_ID);
        await writeTranscribedUntilMs(caps.temporary, SESSION_ID, 0);
        await writeKnownGaps(caps.temporary, SESSION_ID, []);

        // One large fragment that spans from 0 to MAX_NEW_AUDIO_MS + 60 s.
        const bigEndMs = MAX_NEW_AUDIO_MS + 60_000;
        await writeFragmentIndex(caps.temporary, SESSION_ID, {
            sequence: 0,
            startMs: 0,
            endMs: bigEndMs,
            contentHash: "big-frag",
            ingestedAtMs: nowMs - 1_000,
            ...LOW_RATE_FORMAT,
        });
        // Provide enough binary PCM bytes to cover the full fragment duration.
        const pcmSize = pcmBytesForMs(bigEndMs);
        await chunksBinarySublevel(caps.temporary, SESSION_ID).put(chunkKey(0), Buffer.alloc(pcmSize, 0x01));

        const result = await _runPullCycle(caps, SESSION_ID, bigEndMs, nowMs, 10_000);

        expect(result.status).toBe("ok");
        // Watermark must NOT advance to bigEndMs; the cap limits it to MAX_NEW_AUDIO_MS.
        expect(await readTranscribedUntilMs(caps.temporary, SESSION_ID)).toBe(MAX_NEW_AUDIO_MS);
    });

    it("advances watermark to processableEndMs when the window is within the cap", async () => {
        const caps = makeCapabilities();
        const nowMs = 1_000_000;
        await startSession(caps, SESSION_ID);
        await writeTranscribedUntilMs(caps.temporary, SESSION_ID, 0);
        await writeKnownGaps(caps.temporary, SESSION_ID, []);

        const smallEndMs = 30_000; // Well within MAX_NEW_AUDIO_MS
        await writeFragmentIndex(caps.temporary, SESSION_ID, {
            sequence: 0,
            startMs: 0,
            endMs: smallEndMs,
            contentHash: "small-frag",
            ingestedAtMs: nowMs - 1_000,
            ...LOW_RATE_FORMAT,
        });
        const pcmSize = pcmBytesForMs(smallEndMs);
        await chunksBinarySublevel(caps.temporary, SESSION_ID).put(chunkKey(0), Buffer.alloc(pcmSize, 0x01));

        const result = await _runPullCycle(caps, SESSION_ID, smallEndMs, nowMs, 10_000);

        expect(result.status).toBe("ok");
        expect(await readTranscribedUntilMs(caps.temporary, SESSION_ID)).toBe(smallEndMs);
    });

    it("successive pull cycles catch up incrementally when a long backlog exists", async () => {
        const caps = makeCapabilities();
        const nowMs = 1_000_000;
        await startSession(caps, SESSION_ID);
        await writeTranscribedUntilMs(caps.temporary, SESSION_ID, 0);
        await writeKnownGaps(caps.temporary, SESSION_ID, []);

        // Two back-to-back fragments totalling 2 × MAX_NEW_AUDIO_MS.
        const mid = MAX_NEW_AUDIO_MS;
        const end = 2 * MAX_NEW_AUDIO_MS;
        await writeFragmentIndex(caps.temporary, SESSION_ID, {
            sequence: 0,
            startMs: 0,
            endMs: mid,
            contentHash: "frag-0",
            ingestedAtMs: nowMs - 2_000,
            ...LOW_RATE_FORMAT,
        });
        await writeFragmentIndex(caps.temporary, SESSION_ID, {
            sequence: 1,
            startMs: mid,
            endMs: end,
            contentHash: "frag-1",
            ingestedAtMs: nowMs - 1_000,
            ...LOW_RATE_FORMAT,
        });
        await chunksBinarySublevel(caps.temporary, SESSION_ID).put(chunkKey(0), Buffer.alloc(pcmBytesForMs(mid), 0x01));
        await chunksBinarySublevel(caps.temporary, SESSION_ID).put(chunkKey(1), Buffer.alloc(pcmBytesForMs(mid), 0x01));

        // First pull cycle: advances to MAX_NEW_AUDIO_MS.
        const r1 = await _runPullCycle(caps, SESSION_ID, end, nowMs, 10_000);
        expect(r1.status).toBe("ok");
        expect(await readTranscribedUntilMs(caps.temporary, SESSION_ID)).toBe(MAX_NEW_AUDIO_MS);

        // Second pull cycle: advances to 2 × MAX_NEW_AUDIO_MS.
        const r2 = await _runPullCycle(caps, SESSION_ID, end, nowMs, 10_000);
        expect(r2.status).toBe("ok");
        expect(await readTranscribedUntilMs(caps.temporary, SESSION_ID)).toBe(end);
    });
});
