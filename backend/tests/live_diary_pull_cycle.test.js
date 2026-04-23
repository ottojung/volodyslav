const { _runPullCycle } = require("../src/live_diary/pull_cycle");
const { MAX_WINDOW_DURATION_MS } = require("../src/live_diary/planner");
const { MAX_WINDOW_PCM_BYTES } = require("../src/live_diary/pull_window_cap");
const {
    writeFragmentIndex,
    writeKnownGaps,
    writeTranscribedUntilMs,
    readTranscribedUntilMs,
    readKnownGaps,
} = require("../src/live_diary/session_state");
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

async function seedSingleLargeFragment(capabilities, params) {
    const {
        startMs = 0,
        endMs = 10 * 60 * 60 * 1000,
        sampleRateHz = TEST_PCM_FORMAT.sampleRateHz,
        channels = TEST_PCM_FORMAT.channels,
        bitDepth = TEST_PCM_FORMAT.bitDepth,
        nowMs = 1_000_000,
    } = params;
    await startSession(capabilities, SESSION_ID);
    await writeTranscribedUntilMs(capabilities.temporary, SESSION_ID, 0);
    await writeKnownGaps(capabilities.temporary, SESSION_ID, []);
    await writeFragmentIndex(capabilities.temporary, SESSION_ID, {
        sequence: 0,
        startMs,
        endMs,
        contentHash: "frag-large",
        ingestedAtMs: nowMs - 5_000,
        sampleRateHz,
        channels,
        bitDepth,
    });
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

describe("_runPullCycle window caps", () => {
    it("advances watermark only to capped window end (not full processableEndMs)", async () => {
        const caps = makeCapabilities();
        const nowMs = 1_000_000;
        await seedSingleLargeFragment(caps, { nowMs });
        await putChunk(caps.temporary, SESSION_ID, 0);

        const result = await _runPullCycle(caps, SESSION_ID, 10 * 60 * 60 * 1000, nowMs, 10_000);

        expect(result.status).toBe("ok");
        expect(await readTranscribedUntilMs(caps.temporary, SESSION_ID)).toBe(MAX_WINDOW_DURATION_MS);
    });

    it("applies additional PCM-byte budget cap for high-rate formats", async () => {
        const caps = makeCapabilities();
        const nowMs = 1_000_000;
        await seedSingleLargeFragment(caps, {
            nowMs,
            sampleRateHz: 48_000,
            channels: 2,
            bitDepth: 16,
        });
        await putChunk(caps.temporary, SESSION_ID, 0);

        const result = await _runPullCycle(caps, SESSION_ID, 10 * 60 * 60 * 1000, nowMs, 10_000);

        expect(result.status).toBe("ok");
        const watermark = await readTranscribedUntilMs(caps.temporary, SESSION_ID);
        const expectedByPcmBudget = Math.floor((MAX_WINDOW_PCM_BYTES * 1000) / (48_000 * 2 * (16 / 8)));
        expect(watermark).toBe(expectedByPcmBudget);
        expect(watermark).toBeLessThan(MAX_WINDOW_DURATION_MS);
    });
});
