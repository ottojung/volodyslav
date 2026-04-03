const { _runPullCycle } = require("../src/live_diary/pull_cycle");
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
