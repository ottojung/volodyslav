/**
 * Tests for backend/src/live_diary/service.js
 *
 * Covers:
 *  - Basic pushAudio behavior (first fragment → no questions, second → questions)
 *  - Session cleanup on new session start
 *  - Question deduplication
 *  - Backend reboot continuity (state persisted across separate capability instances
 *    that share the same working directory / LevelDB database)
 */

const { getMockedRootCapabilities } = require("./spies");
const {
    stubLogger,
    stubAiTranscriber,
    stubAiDiaryQuestions,
    stubAiTranscriptRecombination,
} = require("./stubs");
const { pushAudio, getPendingQuestions } = require("../src/live_diary");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { buildTestPcmBuffer } = require("./pcm_helpers");

function buildTestPcmInfo() {
    return { pcm: buildTestPcmBuffer(), sampleRateHz: 16000, channels: 1, bitDepth: 16 };
}

/** Temp dirs created during tests, cleaned up in afterAll. */
const tempDirs = [];

afterAll(() => {
    for (const dir of tempDirs) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch {
            // Best-effort cleanup.
        }
    }
});

// Build a capabilities object that stores its LevelDB in a controlled directory.
function makeCapabilitiesWithWorkDir(workDir) {
    const caps = getMockedRootCapabilities();
    // Override workingDirectory so the LevelDB lands inside workDir.
    caps.environment.workingDirectory = jest.fn().mockReturnValue(workDir);
    caps.environment.openaiAPIKey = jest.fn().mockReturnValue("test-key");
    caps.environment.geminiApiKey = jest.fn().mockReturnValue("test-gemini-key");
    stubLogger(caps);
    stubAiTranscriber(caps);
    stubAiDiaryQuestions(caps);
    stubAiTranscriptRecombination(caps);
    return caps;
}

function makeCapabilities() {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "live-diary-test-"));
    tempDirs.push(workDir);
    return makeCapabilitiesWithWorkDir(workDir);
}

const SHORT_TIMEOUT_MS = 10;

// ─── Basic behavior ──────────────────────────────────────────────────────────

describe("pushAudio", () => {
    it("returns empty questions on the first fragment", async () => {
        const caps = makeCapabilities();
        const result = await pushAudio(caps, "sess-1", buildTestPcmInfo(), 1);
        expect(result.questions).toEqual([]);
        expect(result.status).toBe("empty_result");
        expect(caps.aiTranscription.transcribeStreamPreciseDetailed).not.toHaveBeenCalled();
    });

    it("transcribes the 20s window on the second fragment", async () => {
        const caps = makeCapabilities();
        await pushAudio(caps, "sess-2", buildTestPcmInfo(), 1);
        await pushAudio(caps, "sess-2", buildTestPcmInfo(), 2);
        expect(caps.aiTranscription.transcribeStreamPreciseDetailed).toHaveBeenCalledTimes(1);
    });

    it("returns questions on the second fragment when transcription succeeds", async () => {
        const caps = makeCapabilities();
        await pushAudio(caps, "sess-q", buildTestPcmInfo(), 1);
        const result = await pushAudio(caps, "sess-q", buildTestPcmInfo(), 2);
        // The stubbed generateQuestions returns 5 questions.
        expect(Array.isArray(result.questions)).toBe(true);
        expect(result.questions.length).toBeGreaterThan(0);
        expect(result.status).toBe("ok");
    });

    it("uses recombination on the third fragment (two windows available)", async () => {
        const caps = makeCapabilities();
        await pushAudio(caps, "sess-3", buildTestPcmInfo(), 1);
        await pushAudio(caps, "sess-3", buildTestPcmInfo(), 2);
        await pushAudio(caps, "sess-3", buildTestPcmInfo(), 3);
        expect(caps.aiTranscription.transcribeStreamPreciseDetailed).toHaveBeenCalledTimes(2);
        expect(caps.aiTranscriptRecombination.recombineOverlap).toHaveBeenCalledTimes(1);
    });

    it("removes the last word from the newer transcript before recombination when it has at least four words", async () => {
        const caps = makeCapabilities();
        caps.aiTranscription.transcribeStreamPreciseDetailed = jest
            .fn()
            .mockResolvedValueOnce({
                text: "one two three four five",
                provider: "Google",
                model: "mocked",
                finishReason: "STOP",
                finishMessage: null,
                candidateTokenCount: 0,
                usageMetadata: null,
                modelVersion: null,
                responseId: null,
                structured: { transcript: "one two three four five", coverage: "full", warnings: [], unclearAudio: false },
                rawResponse: null,
            })
            .mockResolvedValueOnce({
                text: "alpha beta gamma delta epsilon",
                provider: "Google",
                model: "mocked",
                finishReason: "STOP",
                finishMessage: null,
                candidateTokenCount: 0,
                usageMetadata: null,
                modelVersion: null,
                responseId: null,
                structured: { transcript: "alpha beta gamma delta epsilon", coverage: "full", warnings: [], unclearAudio: false },
                rawResponse: null,
            });

        await pushAudio(caps, "sess-trim", buildTestPcmInfo(), 1);
        await pushAudio(caps, "sess-trim", buildTestPcmInfo(), 2);
        await pushAudio(caps, "sess-trim", buildTestPcmInfo(), 3);

        expect(caps.aiTranscriptRecombination.recombineOverlap).toHaveBeenCalledWith(
            "one two three four five",
            "alpha beta gamma delta"
        );
    });

    it("keeps the newer transcript unchanged for recombination when it has fewer than two words", async () => {
        const caps = makeCapabilities();
        caps.aiTranscription.transcribeStreamPreciseDetailed = jest
            .fn()
            .mockResolvedValueOnce({
                text: "existing overlap transcript",
                provider: "Google",
                model: "mocked",
                finishReason: "STOP",
                finishMessage: null,
                candidateTokenCount: 0,
                usageMetadata: null,
                modelVersion: null,
                responseId: null,
                structured: { transcript: "existing overlap transcript", coverage: "full", warnings: [], unclearAudio: false },
                rawResponse: null,
            })
            .mockResolvedValueOnce({
                text: "aSingleLongWord",
                provider: "Google",
                model: "mocked",
                finishReason: "STOP",
                finishMessage: null,
                candidateTokenCount: 0,
                usageMetadata: null,
                modelVersion: null,
                responseId: null,
                structured: { transcript: "aSingleLongWord", coverage: "full", warnings: [], unclearAudio: false },
                rawResponse: null,
            });

        await pushAudio(caps, "sess-short", buildTestPcmInfo(), 1);
        await pushAudio(caps, "sess-short", buildTestPcmInfo(), 2);
        await pushAudio(caps, "sess-short", buildTestPcmInfo(), 3);

        expect(caps.aiTranscriptRecombination.recombineOverlap).toHaveBeenCalledWith(
            "existing overlap transcript",
            "aSingleLongWord"
        );
    });

    it("removes the last word when the newer transcript has exactly four words", async () => {
        const caps = makeCapabilities();
        caps.aiTranscription.transcribeStreamPreciseDetailed = jest
            .fn()
            .mockResolvedValueOnce({
                text: "first overlap window text",
                provider: "Google",
                model: "mocked",
                finishReason: "STOP",
                finishMessage: null,
                candidateTokenCount: 0,
                usageMetadata: null,
                modelVersion: null,
                responseId: null,
                structured: { transcript: "first overlap window text", coverage: "full", warnings: [], unclearAudio: false },
                rawResponse: null,
            })
            .mockResolvedValueOnce({
                text: "red blue green yellow",
                provider: "Google",
                model: "mocked",
                finishReason: "STOP",
                finishMessage: null,
                candidateTokenCount: 0,
                usageMetadata: null,
                modelVersion: null,
                responseId: null,
                structured: { transcript: "red blue green yellow", coverage: "full", warnings: [], unclearAudio: false },
                rawResponse: null,
            });

        await pushAudio(caps, "sess-four", buildTestPcmInfo(), 1);
        await pushAudio(caps, "sess-four", buildTestPcmInfo(), 2);
        await pushAudio(caps, "sess-four", buildTestPcmInfo(), 3);

        expect(caps.aiTranscriptRecombination.recombineOverlap).toHaveBeenCalledWith(
            "first overlap window text",
            "red blue green"
        );
    });

    it("appends the removed last word to recombination output", async () => {
        const caps = makeCapabilities();
        caps.aiTranscription.transcribeStreamPreciseDetailed = jest
            .fn()
            .mockResolvedValueOnce({
                text: "walking to the park now",
                provider: "Google",
                model: "mocked",
                finishReason: "STOP",
                finishMessage: null,
                candidateTokenCount: 0,
                usageMetadata: null,
                modelVersion: null,
                responseId: null,
                structured: { transcript: "walking to the park now", coverage: "full", warnings: [], unclearAudio: false },
                rawResponse: null,
            })
            .mockResolvedValueOnce({
                text: "going to the park for some very fresh morning air",
                provider: "Google",
                model: "mocked",
                finishReason: "STOP",
                finishMessage: null,
                candidateTokenCount: 0,
                usageMetadata: null,
                modelVersion: null,
                responseId: null,
                structured: { transcript: "going to the park for some very fresh morning air", coverage: "full", warnings: [], unclearAudio: false },
                rawResponse: null,
            });
        caps.aiTranscriptRecombination.recombineOverlap = jest
            .fn()
            .mockResolvedValue("walking to the park for fresh");

        await pushAudio(caps, "sess-append", buildTestPcmInfo(), 1);
        await pushAudio(caps, "sess-append", buildTestPcmInfo(), 2);
        const result = await pushAudio(caps, "sess-append", buildTestPcmInfo(), 3);

        // Running transcript generated at fragment 3 should include the appended boundary word.
        expect(caps.aiDiaryQuestions.generateQuestions).toHaveBeenLastCalledWith(
            expect.stringContaining("walking to the park for fresh air"),
            expect.any(Array),
            expect.any(Number)
        );
        expect(result.status).toBe("ok");
    });

    it("uses the removed last word as merged text when recombination output is empty", async () => {
        const caps = makeCapabilities();
        caps.aiTranscription.transcribeStreamPreciseDetailed = jest
            .fn()
            .mockResolvedValueOnce({
                text: "first second third fourth fifth",
                provider: "Google",
                model: "mocked",
                finishReason: "STOP",
                finishMessage: null,
                candidateTokenCount: 0,
                usageMetadata: null,
                modelVersion: null,
                responseId: null,
                structured: { transcript: "first second third fourth fifth", coverage: "full", warnings: [], unclearAudio: false },
                rawResponse: null,
            })
            .mockResolvedValueOnce({
                text: "this is the new overlap sentence that ends with word",
                provider: "Google",
                model: "mocked",
                finishReason: "STOP",
                finishMessage: null,
                candidateTokenCount: 0,
                usageMetadata: null,
                modelVersion: null,
                responseId: null,
                structured: { transcript: "this is the new overlap sentence that ends with word", coverage: "full", warnings: [], unclearAudio: false },
                rawResponse: null,
            })
            .mockResolvedValueOnce({
                text: "another overlap sentence adding more words for generation",
                provider: "Google",
                model: "mocked",
                finishReason: "STOP",
                finishMessage: null,
                candidateTokenCount: 0,
                usageMetadata: null,
                modelVersion: null,
                responseId: null,
                structured: { transcript: "another overlap sentence adding more words for generation", coverage: "full", warnings: [], unclearAudio: false },
                rawResponse: null,
            });
        caps.aiTranscriptRecombination.recombineOverlap = jest
            .fn()
            .mockResolvedValueOnce("   ")
            .mockImplementation(async (_existing, newer) => newer);

        await pushAudio(caps, "sess-empty-merge", buildTestPcmInfo(), 1);
        await pushAudio(caps, "sess-empty-merge", buildTestPcmInfo(), 2);
        await pushAudio(caps, "sess-empty-merge", buildTestPcmInfo(), 3);
        await pushAudio(caps, "sess-empty-merge", buildTestPcmInfo(), 4);

        expect(caps.aiDiaryQuestions.generateQuestions).toHaveBeenLastCalledWith(
            expect.stringContaining("word"),
            expect.any(Array),
            expect.any(Number)
        );
    });

    it("returns empty questions when transcription fails (non-fatal)", async () => {
        const caps = makeCapabilities();
        caps.aiTranscription.transcribeStreamPreciseDetailed = jest
            .fn()
            .mockRejectedValue(new Error("API error"));

        await pushAudio(caps, "sess-fail", buildTestPcmInfo(), 1);
        const result = await pushAudio(caps, "sess-fail", buildTestPcmInfo(), 2);
        expect(result.questions).toEqual([]);
        expect(result.status).toBe("degraded_transcription");
    });

    it("returns degraded_transcription if transcription takes too long", async () => {
        const caps = makeCapabilities();
        caps.aiTranscription.transcribeStreamPreciseDetailed = jest
            .fn()
            .mockImplementation(() => new Promise((resolve) => {
                setTimeout(() => {
                    resolve({
                        text: "late transcript",
                        provider: "Google",
                        model: "mocked",
                        finishReason: "STOP",
                        finishMessage: null,
                        candidateTokenCount: 0,
                        usageMetadata: null,
                        modelVersion: null,
                        responseId: null,
                        structured: { transcript: "late transcript", coverage: "full", warnings: [], unclearAudio: false },
                        rawResponse: null,
                    });
                }, 50);
            }));

        await pushAudio(caps, "sess-timeout-transcription", buildTestPcmInfo(), 1);
        const result = await pushAudio(
            caps,
            "sess-timeout-transcription",
            buildTestPcmInfo(),
            2,
            SHORT_TIMEOUT_MS
        );
        expect(result.questions).toEqual([]);
        expect(result.status).toBe("degraded_transcription");
    });

    it("returns empty questions when transcription returns empty string (silence)", async () => {
        const caps = makeCapabilities();
        caps.aiTranscription.transcribeStreamPreciseDetailed = jest.fn().mockResolvedValue({
            text: "",
            provider: "Google",
            model: "mocked",
            finishReason: "STOP",
            finishMessage: null,
            candidateTokenCount: 0,
            usageMetadata: null,
            modelVersion: null,
            responseId: null,
            structured: { transcript: "", coverage: "full", warnings: [], unclearAudio: false },
            rawResponse: null,
        });

        await pushAudio(caps, "sess-silent", buildTestPcmInfo(), 1);
        const result = await pushAudio(caps, "sess-silent", buildTestPcmInfo(), 2);
        expect(result.questions).toEqual([]);
        expect(result.status).toBe("ok");
    });

    it("skips question generation when cumulative word count since last question is below 10", async () => {
        const caps = makeCapabilities();
        caps.aiTranscription.transcribeStreamPreciseDetailed = jest.fn().mockResolvedValue({
            text: "only nine words in this very sparse",
            provider: "Google",
            model: "mocked",
            finishReason: "STOP",
            finishMessage: null,
            candidateTokenCount: 0,
            usageMetadata: null,
            modelVersion: null,
            responseId: null,
            structured: { transcript: "only nine words in this very sparse", coverage: "full", warnings: [], unclearAudio: false },
            rawResponse: null,
        });

        await pushAudio(caps, "sess-sparse-cumulative", buildTestPcmInfo(), 1);
        const result = await pushAudio(caps, "sess-sparse-cumulative", buildTestPcmInfo(), 2);
        expect(result.questions).toEqual([]);
        expect(result.status).toBe("ok");
        expect(caps.aiDiaryQuestions.generateQuestions).not.toHaveBeenCalled();
    });

    it("generates questions once cumulative word count across fragments reaches 10", async () => {
        const caps = makeCapabilities();
        let callCount = 0;
        caps.aiTranscription.transcribeStreamPreciseDetailed = jest.fn().mockImplementation(async () => {
            callCount += 1;
            // First two windows: 3 words each (cumulative 3, then 6, then 9 — never hits 10 alone).
            // Third window: 4 words → cumulative becomes 13 ≥ 10.
            const transcripts = ["one two three", "four five six", "seven eight nine ten"];
            const t = transcripts[Math.min(callCount - 1, transcripts.length - 1)];
            return {
                text: t,
                provider: "Google",
                model: "mocked",
                finishReason: "STOP",
                finishMessage: null,
                candidateTokenCount: 0,
                usageMetadata: null,
                modelVersion: null,
                responseId: null,
                structured: { transcript: t, coverage: "full", warnings: [], unclearAudio: false },
                rawResponse: null,
            };
        });

        await pushAudio(caps, "sess-cumulative-trigger", buildTestPcmInfo(), 1);
        // Fragment 2: 3 words cumulative — no questions.
        const r2 = await pushAudio(caps, "sess-cumulative-trigger", buildTestPcmInfo(), 2);
        expect(r2.questions).toHaveLength(0);
        expect(caps.aiDiaryQuestions.generateQuestions).not.toHaveBeenCalled();
        // Fragment 3: 3+3=6 cumulative — still no questions.
        const r3 = await pushAudio(caps, "sess-cumulative-trigger", buildTestPcmInfo(), 3);
        expect(r3.questions).toHaveLength(0);
        expect(caps.aiDiaryQuestions.generateQuestions).not.toHaveBeenCalled();
        // Fragment 4: 6+4=10 cumulative — questions generated.
        const r4 = await pushAudio(caps, "sess-cumulative-trigger", buildTestPcmInfo(), 4);
        expect(r4.status).toBe("ok");
        expect(caps.aiDiaryQuestions.generateQuestions).toHaveBeenCalledTimes(1);
    });

    it("deduplicates repeated questions across consecutive calls", async () => {
        const caps = makeCapabilities();
        caps.aiDiaryQuestions.generateQuestions = jest
            .fn()
            .mockResolvedValue([{ text: "Same question?", intent: "warm_reflective" }]);

        await pushAudio(caps, "sess-dedup", buildTestPcmInfo(), 1);

        // Fragment 2: first window → question returned.
        const r2 = await pushAudio(caps, "sess-dedup", buildTestPcmInfo(), 2);
        expect(r2.questions).toHaveLength(1);
        expect(r2.questions[0].text).toBe("Same question?");
        expect(r2.status).toBe("ok");

        // Fragment 3: same question → should be deduplicated out.
        const r3 = await pushAudio(caps, "sess-dedup", buildTestPcmInfo(), 3);
        expect(r3.questions).toHaveLength(0);
        expect(r3.status).toBe("ok");
    });

    it("returns degraded_question_generation if question generation takes too long", async () => {
        const caps = makeCapabilities();
        caps.aiTranscription.transcribeStreamPreciseDetailed = jest.fn().mockResolvedValue({
            text: "this is a steady and reliable transcript for testing time limits",
            provider: "Google",
            model: "mocked",
            finishReason: "STOP",
            finishMessage: null,
            candidateTokenCount: 0,
            usageMetadata: null,
            modelVersion: null,
            responseId: null,
            structured: { transcript: "this is a steady and reliable transcript for testing time limits", coverage: "full", warnings: [], unclearAudio: false },
            rawResponse: null,
        });
        caps.aiDiaryQuestions.generateQuestions = jest
            .fn()
            .mockImplementation(() => new Promise((resolve) => {
                setTimeout(() => {
                    resolve([{ text: "late question", intent: "warm_reflective" }]);
                }, 50);
            }));

        await pushAudio(caps, "sess-timeout-questions", buildTestPcmInfo(), 1, SHORT_TIMEOUT_MS);
        const result = await pushAudio(
            caps,
            "sess-timeout-questions",
            buildTestPcmInfo(),
            2,
            SHORT_TIMEOUT_MS
        );

        expect(result.questions).toEqual([]);
        expect(result.status).toBe("degraded_question_generation");
    });

    it("persists cumulative words when question generation degrades", async () => {
        const caps = makeCapabilities();
        caps.aiTranscription.transcribeStreamPreciseDetailed = jest.fn().mockResolvedValue({
            text: "this transcript has enough words to trigger question generation threshold",
            provider: "Google",
            model: "mocked",
            finishReason: "STOP",
            finishMessage: null,
            candidateTokenCount: 0,
            usageMetadata: null,
            modelVersion: null,
            responseId: null,
            structured: {
                transcript: "this transcript has enough words to trigger question generation threshold",
                coverage: "full",
                warnings: [],
                unclearAudio: false,
            },
            rawResponse: null,
        });
        caps.aiDiaryQuestions.generateQuestions = jest
            .fn()
            .mockRejectedValue(new Error("question generation failed"));

        await pushAudio(caps, "sess-persist-cumulative-on-degrade", buildTestPcmInfo(), 1);
        const result = await pushAudio(
            caps,
            "sess-persist-cumulative-on-degrade",
            buildTestPcmInfo(),
            2
        );

        expect(result.questions).toEqual([]);
        expect(result.status).toBe("degraded_question_generation");

        // Next fragment should trigger generation again because previous cumulative
        // count is preserved instead of lost.
        caps.aiDiaryQuestions.generateQuestions = jest
            .fn()
            .mockResolvedValue([{ text: "Recovered question?", intent: "warm_reflective" }]);
        const next = await pushAudio(
            caps,
            "sess-persist-cumulative-on-degrade",
            buildTestPcmInfo(),
            3
        );
        expect(next.status).toBe("ok");
        expect(next.questions).toHaveLength(1);
        expect(next.questions[0].text).toBe("Recovered question?");
    });

    it("persists cumulative words when generation returns zero new questions", async () => {
        const caps = makeCapabilities();
        const transcripts = [
            "one two three", // fragment 2 -> +3 (below threshold)
            "four five six seven eight nine ten", // fragment 3 -> +7 (reaches 10)
            "eleven", // fragment 4 -> should still trigger generation if 10 was preserved
        ];
        let transcribeCallCount = 0;
        caps.aiTranscription.transcribeStreamPreciseDetailed = jest.fn().mockImplementation(async () => {
            const text = transcripts[Math.min(transcribeCallCount, transcripts.length - 1)];
            transcribeCallCount += 1;
            return {
                text,
                provider: "Google",
                model: "mocked",
                finishReason: "STOP",
                finishMessage: null,
                candidateTokenCount: 0,
                usageMetadata: null,
                modelVersion: null,
                responseId: null,
                structured: { transcript: text, coverage: "full", warnings: [], unclearAudio: false },
                rawResponse: null,
            };
        });
        caps.aiDiaryQuestions.generateQuestions = jest
            .fn()
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{ text: "Follow-up after zero result?", intent: "clarifying" }]);

        await pushAudio(caps, "sess-persist-cumulative-on-zero", buildTestPcmInfo(), 1);
        const second = await pushAudio(caps, "sess-persist-cumulative-on-zero", buildTestPcmInfo(), 2);
        expect(second.status).toBe("ok");
        expect(second.questions).toEqual([]);
        expect(caps.aiDiaryQuestions.generateQuestions).not.toHaveBeenCalled();

        const third = await pushAudio(caps, "sess-persist-cumulative-on-zero", buildTestPcmInfo(), 3);
        expect(third.status).toBe("ok");
        expect(third.questions).toEqual([]);
        expect(caps.aiDiaryQuestions.generateQuestions).toHaveBeenCalledTimes(1);

        const fourth = await pushAudio(caps, "sess-persist-cumulative-on-zero", buildTestPcmInfo(), 4);
        expect(fourth.status).toBe("ok");
        expect(fourth.questions).toHaveLength(1);
        expect(fourth.questions[0].text).toBe("Follow-up after zero result?");
        expect(caps.aiDiaryQuestions.generateQuestions).toHaveBeenCalledTimes(2);
    });

    it("deduplicates non-ASCII (Cyrillic) questions using Unicode-aware normalization", async () => {
        const caps = makeCapabilities();
        // Simulate an AI returning the same Ukrainian question twice.
        caps.aiDiaryQuestions.generateQuestions = jest
            .fn()
            .mockResolvedValue([{ text: "Як ти почуваєшся?", intent: "warm_reflective" }]);

        await pushAudio(caps, "sess-unicode", buildTestPcmInfo(), 1);

        // Fragment 2: question returned for the first time.
        const r2 = await pushAudio(caps, "sess-unicode", buildTestPcmInfo(), 2);
        expect(r2.questions).toHaveLength(1);
        expect(r2.questions[0].text).toBe("Як ти почуваєшся?");

        // Fragment 3: the same Cyrillic question → must be deduplicated out.
        const r3 = await pushAudio(caps, "sess-unicode", buildTestPcmInfo(), 3);
        expect(r3.questions).toHaveLength(0);
    });

    it("returns invalid_pcm when bitDepth is not 16", async () => {
        const caps = makeCapabilities();
        await pushAudio(caps, "sess-bitdepth", buildTestPcmInfo(), 1);

        const result = await pushAudio(caps, "sess-bitdepth", { pcm: Buffer.from(new Int16Array(8).buffer), sampleRateHz: 16000, channels: 1, bitDepth: 24 }, 2);
        expect(result.questions).toEqual([]);
        expect(result.status).toBe("invalid_pcm");
        expect(caps.aiTranscription.transcribeStreamPreciseDetailed).not.toHaveBeenCalled();
    });

    it("logs lastFragmentBytes, currentFragmentBytes, and combinedBytes when forming the overlap window", async () => {
        const caps = makeCapabilities();
        const pcmInfo = buildTestPcmInfo();
        const pcmByteLength = pcmInfo.pcm.length; // 16 bytes (8 Int16 samples)

        await pushAudio(caps, "sess-logbytes", pcmInfo, 1);
        await pushAudio(caps, "sess-logbytes", pcmInfo, 2);

        expect(caps.logger.logDebug).toHaveBeenCalledWith(
            expect.objectContaining({
                lastFragmentBytes: pcmByteLength,
                currentFragmentBytes: pcmByteLength,
                combinedBytes: pcmByteLength * 2,
            }),
            expect.stringContaining("forming 20s PCM overlap window")
        );
    });
});

// ─── Session cleanup ─────────────────────────────────────────────────────────

describe("session isolation across session ids", () => {
    it("keeps session data isolated when a new session id arrives", async () => {
        const caps = makeCapabilities();

        // Establish session A with two fragments (sets up full state in DB).
        await pushAudio(caps, "old-session", buildTestPcmInfo(), 1);
        await pushAudio(caps, "old-session", buildTestPcmInfo(), 2);

        // Start a completely new session B.
        const r = await pushAudio(caps, "new-session", buildTestPcmInfo(), 1);
        // First fragment of new session → no questions yet.
        expect(r.questions).toEqual([]);
        expect(r.status).toBe("empty_result");

        // The second push under new-session forms a window and transcribes independently of old-session state.
        await pushAudio(caps, "new-session", buildTestPcmInfo(), 2);

        // Total transcription calls: 1 (for old-session window) + 1 (for new-session window) = 2.
        expect(caps.aiTranscription.transcribeStreamPreciseDetailed).toHaveBeenCalledTimes(2);
    });
});

// ─── Backend reboot continuity ───────────────────────────────────────────────

describe("backend reboot continuity", () => {
    it("resumes from stored last fragment after simulated backend restart", async () => {
        const sharedWorkDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "live-diary-reboot-test-")
        );
        tempDirs.push(sharedWorkDir);

        // First backend instance: stores fragment 1.
        const caps1 = makeCapabilitiesWithWorkDir(sharedWorkDir);
        await pushAudio(caps1, "reboot-session", buildTestPcmInfo(), 1);

        // Simulate clean shutdown (releases LevelDB lock).
        await caps1.temporary.close();

        // Simulated reboot: brand new capability instance, same DB path.
        const caps2 = makeCapabilitiesWithWorkDir(sharedWorkDir);

        // Fragment 2 arrives at the new instance. It should find fragment 1 in DB and transcribe.
        await pushAudio(caps2, "reboot-session", buildTestPcmInfo(), 2);

        expect(caps2.aiTranscription.transcribeStreamPreciseDetailed).toHaveBeenCalledTimes(1);
        // caps1 should NOT have been asked to transcribe (it only stored fragment 1).
        expect(caps1.aiTranscription.transcribeStreamPreciseDetailed).not.toHaveBeenCalled();
    });

    it("persists running transcript across backend restarts", async () => {
        const sharedWorkDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "live-diary-reboot-transcript-test-")
        );
        tempDirs.push(sharedWorkDir);

        // First instance: establish running transcript via fragments 1+2.
        const caps1 = makeCapabilitiesWithWorkDir(sharedWorkDir);
        await pushAudio(caps1, "persist-session", buildTestPcmInfo(), 1);
        await pushAudio(caps1, "persist-session", buildTestPcmInfo(), 2);

        // Simulate clean shutdown.
        await caps1.temporary.close();

        // Second instance (reboot): fragment 3 should see the stored window transcript
        // and call recombination.
        const caps2 = makeCapabilitiesWithWorkDir(sharedWorkDir);
        await pushAudio(caps2, "persist-session", buildTestPcmInfo(), 3);

        // caps2 should have called transcription (for window f2+f3) and recombination
        // (because the last window transcript was persisted).
        expect(caps2.aiTranscription.transcribeStreamPreciseDetailed).toHaveBeenCalledTimes(1);
        expect(caps2.aiTranscriptRecombination.recombineOverlap).toHaveBeenCalledTimes(1);
    });

    it("deduplicates questions against those asked before restart", async () => {
        const sharedWorkDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "live-diary-reboot-dedup-test-")
        );
        tempDirs.push(sharedWorkDir);

        const sameQuestion = [{ text: "What matters most?", intent: "warm_reflective" }];

        // First instance: receive a question.
        const caps1 = makeCapabilitiesWithWorkDir(sharedWorkDir);
        caps1.aiDiaryQuestions.generateQuestions = jest.fn().mockResolvedValue(sameQuestion);
        await pushAudio(caps1, "dedup-session", buildTestPcmInfo(), 1);
        const r2 = await pushAudio(caps1, "dedup-session", buildTestPcmInfo(), 2);
        expect(r2.questions[0].text).toBe("What matters most?");

        // Simulate clean shutdown.
        await caps1.temporary.close();

        // Second instance: the same question is generated again but must be deduplicated.
        const caps2 = makeCapabilitiesWithWorkDir(sharedWorkDir);
        caps2.aiDiaryQuestions.generateQuestions = jest.fn().mockResolvedValue(sameQuestion);
        await pushAudio(caps2, "dedup-session", buildTestPcmInfo(), 3);
        const r4 = await pushAudio(caps2, "dedup-session", buildTestPcmInfo(), 4);
        expect(r4.questions).toHaveLength(0);
    });
});

// ─── getPendingQuestions ─────────────────────────────────────────────────────

describe("getPendingQuestions", () => {
    it("returns empty array when no questions have been generated yet", async () => {
        const caps = makeCapabilities();
        const questions = await getPendingQuestions(caps, "sess-pending-empty");
        expect(questions).toEqual([]);
    });

    it("returns questions generated by pushAudio", async () => {
        const caps = makeCapabilities();
        await pushAudio(caps, "sess-pending", buildTestPcmInfo(), 1);
        await pushAudio(caps, "sess-pending", buildTestPcmInfo(), 2);

        const questions = await getPendingQuestions(caps, "sess-pending");
        expect(Array.isArray(questions)).toBe(true);
        expect(questions.length).toBeGreaterThan(0);
        expect(typeof questions[0].text).toBe("string");
    });

    it("clears pending questions after they are fetched (consume-once)", async () => {
        const caps = makeCapabilities();
        await pushAudio(caps, "sess-consume", buildTestPcmInfo(), 1);
        await pushAudio(caps, "sess-consume", buildTestPcmInfo(), 2);

        // First fetch: returns questions.
        const first = await getPendingQuestions(caps, "sess-consume");
        expect(first.length).toBeGreaterThan(0);

        // Second fetch: questions have been cleared.
        const second = await getPendingQuestions(caps, "sess-consume");
        expect(second).toEqual([]);
    });

    it("accumulates questions from multiple fragments before they are fetched", async () => {
        const caps = makeCapabilities();
        caps.aiTranscription.transcribeStreamPreciseDetailed = jest
            .fn()
            .mockResolvedValueOnce({
                text: "one two three four five six seven eight nine ten",
                provider: "Google",
                model: "mocked",
                finishReason: "STOP",
                finishMessage: null,
                candidateTokenCount: 0,
                usageMetadata: null,
                modelVersion: null,
                responseId: null,
                structured: {
                    transcript: "one two three four five six seven eight nine ten",
                    coverage: "full",
                    warnings: [],
                    unclearAudio: false,
                },
                rawResponse: null,
            })
            .mockResolvedValueOnce({
                text: "alpha beta gamma delta epsilon zeta eta theta iota kappa",
                provider: "Google",
                model: "mocked",
                finishReason: "STOP",
                finishMessage: null,
                candidateTokenCount: 0,
                usageMetadata: null,
                modelVersion: null,
                responseId: null,
                structured: {
                    transcript: "alpha beta gamma delta epsilon zeta eta theta iota kappa",
                    coverage: "full",
                    warnings: [],
                    unclearAudio: false,
                },
                rawResponse: null,
            });
        // Return distinct questions for each generation to avoid deduplication.
        caps.aiDiaryQuestions.generateQuestions = jest
            .fn()
            .mockResolvedValueOnce([{ text: "Question A?", intent: "warm_reflective" }])
            .mockResolvedValueOnce([{ text: "Question B?", intent: "clarifying" }]);

        await pushAudio(caps, "sess-multi", buildTestPcmInfo(), 1);
        await pushAudio(caps, "sess-multi", buildTestPcmInfo(), 2);
        await pushAudio(caps, "sess-multi", buildTestPcmInfo(), 3);

        // Neither generation has been fetched yet — both should be pending.
        const pending = await getPendingQuestions(caps, "sess-multi");
        const texts = pending.map((q) => q.text);
        expect(texts).toContain("Question A?");
        expect(texts).toContain("Question B?");
    });
});
