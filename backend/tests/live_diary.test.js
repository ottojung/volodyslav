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

// ─── Basic behavior ──────────────────────────────────────────────────────────

describe("pushAudio", () => {
    it("returns empty questions on the first fragment", async () => {
        const caps = makeCapabilities();
        const result = await pushAudio(caps, "sess-1", Buffer.from("audio1"), "audio/webm", 1);
        expect(result.questions).toEqual([]);
        expect(result.status).toBe("empty_result");
        expect(caps.aiTranscription.transcribeStreamDetailed).not.toHaveBeenCalled();
    });

    it("transcribes the 20s window on the second fragment", async () => {
        const caps = makeCapabilities();
        await pushAudio(caps, "sess-2", Buffer.from("audio1"), "audio/webm", 1);
        await pushAudio(caps, "sess-2", Buffer.from("audio2"), "audio/webm", 2);
        expect(caps.aiTranscription.transcribeStreamDetailed).toHaveBeenCalledTimes(1);
    });

    it("returns questions on the second fragment when transcription succeeds", async () => {
        const caps = makeCapabilities();
        await pushAudio(caps, "sess-q", Buffer.from("audio1"), "audio/webm", 1);
        const result = await pushAudio(caps, "sess-q", Buffer.from("audio2"), "audio/webm", 2);
        // The stubbed generateQuestions returns 5 questions.
        expect(Array.isArray(result.questions)).toBe(true);
        expect(result.questions.length).toBeGreaterThan(0);
        expect(result.status).toBe("ok");
    });

    it("uses recombination on the third fragment (two windows available)", async () => {
        const caps = makeCapabilities();
        await pushAudio(caps, "sess-3", Buffer.from("a1"), "audio/webm", 1);
        await pushAudio(caps, "sess-3", Buffer.from("a2"), "audio/webm", 2);
        await pushAudio(caps, "sess-3", Buffer.from("a3"), "audio/webm", 3);
        expect(caps.aiTranscription.transcribeStreamDetailed).toHaveBeenCalledTimes(2);
        expect(caps.aiTranscriptRecombination.recombineOverlap).toHaveBeenCalledTimes(1);
    });

    it("removes the last word from the newer transcript before recombination when it has at least four words", async () => {
        const caps = makeCapabilities();
        caps.aiTranscription.transcribeStreamDetailed = jest
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

        await pushAudio(caps, "sess-trim", Buffer.from("a1"), "audio/webm", 1);
        await pushAudio(caps, "sess-trim", Buffer.from("a2"), "audio/webm", 2);
        await pushAudio(caps, "sess-trim", Buffer.from("a3"), "audio/webm", 3);

        expect(caps.aiTranscriptRecombination.recombineOverlap).toHaveBeenCalledWith(
            "one two three four five",
            "alpha beta gamma delta"
        );
    });

    it("keeps the newer transcript unchanged for recombination when it has fewer than two words", async () => {
        const caps = makeCapabilities();
        caps.aiTranscription.transcribeStreamDetailed = jest
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

        await pushAudio(caps, "sess-short", Buffer.from("a1"), "audio/webm", 1);
        await pushAudio(caps, "sess-short", Buffer.from("a2"), "audio/webm", 2);
        await pushAudio(caps, "sess-short", Buffer.from("a3"), "audio/webm", 3);

        expect(caps.aiTranscriptRecombination.recombineOverlap).toHaveBeenCalledWith(
            "existing overlap transcript",
            "aSingleLongWord"
        );
    });

    it("removes the last word when the newer transcript has exactly four words", async () => {
        const caps = makeCapabilities();
        caps.aiTranscription.transcribeStreamDetailed = jest
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

        await pushAudio(caps, "sess-four", Buffer.from("a1"), "audio/webm", 1);
        await pushAudio(caps, "sess-four", Buffer.from("a2"), "audio/webm", 2);
        await pushAudio(caps, "sess-four", Buffer.from("a3"), "audio/webm", 3);

        expect(caps.aiTranscriptRecombination.recombineOverlap).toHaveBeenCalledWith(
            "first overlap window text",
            "red blue green"
        );
    });

    it("appends the removed last word to recombination output", async () => {
        const caps = makeCapabilities();
        caps.aiTranscription.transcribeStreamDetailed = jest
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
                text: "to the park for fresh air",
                provider: "Google",
                model: "mocked",
                finishReason: "STOP",
                finishMessage: null,
                candidateTokenCount: 0,
                usageMetadata: null,
                modelVersion: null,
                responseId: null,
                structured: { transcript: "to the park for fresh air", coverage: "full", warnings: [], unclearAudio: false },
                rawResponse: null,
            });
        caps.aiTranscriptRecombination.recombineOverlap = jest
            .fn()
            .mockResolvedValue("walking to the park for fresh");

        await pushAudio(caps, "sess-append", Buffer.from("a1"), "audio/webm", 1);
        await pushAudio(caps, "sess-append", Buffer.from("a2"), "audio/webm", 2);
        const result = await pushAudio(caps, "sess-append", Buffer.from("a3"), "audio/webm", 3);

        // Running transcript generated at fragment 3 should include the appended boundary word.
        expect(caps.aiDiaryQuestions.generateQuestions).toHaveBeenLastCalledWith(
            expect.stringContaining("walking to the park for fresh air"),
            expect.any(Array)
        );
        expect(result.status).toBe("ok");
    });

    it("uses the removed last word as merged text when recombination output is empty", async () => {
        const caps = makeCapabilities();
        caps.aiTranscription.transcribeStreamDetailed = jest
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
                text: "new overlap sentence ending word",
                provider: "Google",
                model: "mocked",
                finishReason: "STOP",
                finishMessage: null,
                candidateTokenCount: 0,
                usageMetadata: null,
                modelVersion: null,
                responseId: null,
                structured: { transcript: "new overlap sentence ending word", coverage: "full", warnings: [], unclearAudio: false },
                rawResponse: null,
            });
        caps.aiTranscriptRecombination.recombineOverlap = jest.fn().mockResolvedValue("   ");

        await pushAudio(caps, "sess-empty-merge", Buffer.from("a1"), "audio/webm", 1);
        await pushAudio(caps, "sess-empty-merge", Buffer.from("a2"), "audio/webm", 2);
        await pushAudio(caps, "sess-empty-merge", Buffer.from("a3"), "audio/webm", 3);

        expect(caps.aiDiaryQuestions.generateQuestions).toHaveBeenLastCalledWith(
            expect.stringContaining("word"),
            expect.any(Array)
        );
    });

    it("returns empty questions when transcription fails (non-fatal)", async () => {
        const caps = makeCapabilities();
        caps.aiTranscription.transcribeStreamDetailed = jest
            .fn()
            .mockRejectedValue(new Error("API error"));

        await pushAudio(caps, "sess-fail", Buffer.from("a1"), "audio/webm", 1);
        const result = await pushAudio(caps, "sess-fail", Buffer.from("a2"), "audio/webm", 2);
        expect(result.questions).toEqual([]);
        expect(result.status).toBe("degraded_transcription");
    });

    it("returns degraded_transcription if transcription takes too long", async () => {
        const caps = makeCapabilities();
        caps.aiTranscription.transcribeStreamDetailed = jest
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

        await pushAudio(caps, "sess-timeout-transcription", Buffer.from("a1"), "audio/webm", 1);
        const result = await pushAudio(
            caps,
            "sess-timeout-transcription",
            Buffer.from("a2"),
            "audio/webm",
            2,
            10
        );
        expect(result.questions).toEqual([]);
        expect(result.status).toBe("degraded_transcription");
    });

    it("returns empty questions when transcription returns empty string (silence)", async () => {
        const caps = makeCapabilities();
        caps.aiTranscription.transcribeStreamDetailed = jest.fn().mockResolvedValue({
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

        await pushAudio(caps, "sess-silent", Buffer.from("a1"), "audio/webm", 1);
        const result = await pushAudio(caps, "sess-silent", Buffer.from("a2"), "audio/webm", 2);
        expect(result.questions).toEqual([]);
        expect(result.status).toBe("ok");
    });

    it("deduplicates repeated questions across consecutive calls", async () => {
        const caps = makeCapabilities();
        caps.aiDiaryQuestions.generateQuestions = jest
            .fn()
            .mockResolvedValue([{ text: "Same question?", intent: "warm_reflective" }]);

        await pushAudio(caps, "sess-dedup", Buffer.from("a1"), "audio/webm", 1);

        // Fragment 2: first window → question returned.
        const r2 = await pushAudio(caps, "sess-dedup", Buffer.from("a2"), "audio/webm", 2);
        expect(r2.questions).toHaveLength(1);
        expect(r2.questions[0].text).toBe("Same question?");
        expect(r2.status).toBe("ok");

        // Fragment 3: same question → should be deduplicated out.
        const r3 = await pushAudio(caps, "sess-dedup", Buffer.from("a3"), "audio/webm", 3);
        expect(r3.questions).toHaveLength(0);
        expect(r3.status).toBe("ok");
    });

    it("returns degraded_question_generation if question generation takes too long", async () => {
        const caps = makeCapabilities();
        caps.aiTranscription.transcribeStreamDetailed = jest.fn().mockResolvedValue({
            text: "steady transcript",
            provider: "Google",
            model: "mocked",
            finishReason: "STOP",
            finishMessage: null,
            candidateTokenCount: 0,
            usageMetadata: null,
            modelVersion: null,
            responseId: null,
            structured: { transcript: "steady transcript", coverage: "full", warnings: [], unclearAudio: false },
            rawResponse: null,
        });
        caps.aiDiaryQuestions.generateQuestions = jest
            .fn()
            .mockImplementation(() => new Promise((resolve) => {
                setTimeout(() => {
                    resolve([{ text: "late question", intent: "warm_reflective" }]);
                }, 50);
            }));

        await pushAudio(caps, "sess-timeout-questions", Buffer.from("a1"), "audio/webm", 1, 10);
        const result = await pushAudio(
            caps,
            "sess-timeout-questions",
            Buffer.from("a2"),
            "audio/webm",
            2,
            10
        );

        expect(result.questions).toEqual([]);
        expect(result.status).toBe("degraded_question_generation");
    });

    it("deduplicates non-ASCII (Cyrillic) questions using Unicode-aware normalization", async () => {
        const caps = makeCapabilities();
        // Simulate an AI returning the same Ukrainian question twice.
        caps.aiDiaryQuestions.generateQuestions = jest
            .fn()
            .mockResolvedValue([{ text: "Як ти почуваєшся?", intent: "warm_reflective" }]);

        await pushAudio(caps, "sess-unicode", Buffer.from("a1"), "audio/webm", 1);

        // Fragment 2: question returned for the first time.
        const r2 = await pushAudio(caps, "sess-unicode", Buffer.from("a2"), "audio/webm", 2);
        expect(r2.questions).toHaveLength(1);
        expect(r2.questions[0].text).toBe("Як ти почуваєшся?");

        // Fragment 3: the same Cyrillic question → must be deduplicated out.
        const r3 = await pushAudio(caps, "sess-unicode", Buffer.from("a3"), "audio/webm", 3);
        expect(r3.questions).toHaveLength(0);
    });

    it("returns unsupported_mime when a non-webm fragment is pushed after session bootstrap", async () => {
        const caps = makeCapabilities();
        await pushAudio(caps, "sess-mime", Buffer.from("a1"), "audio/webm", 1);

        const result = await pushAudio(caps, "sess-mime", Buffer.from("a2"), "audio/ogg", 2);
        expect(result.questions).toEqual([]);
        expect(result.status).toBe("unsupported_mime");
        expect(caps.aiTranscription.transcribeStreamDetailed).not.toHaveBeenCalled();
    });
});

// ─── Session cleanup ─────────────────────────────────────────────────────────

describe("session cleanup on new session", () => {
    it("cleans up old session data when a new session id arrives", async () => {
        const caps = makeCapabilities();

        // Establish session A with two fragments (sets up full state in DB).
        await pushAudio(caps, "old-session", Buffer.from("a1"), "audio/webm", 1);
        await pushAudio(caps, "old-session", Buffer.from("a2"), "audio/webm", 2);

        // Start a completely new session B. Old session data should be cleaned.
        const r = await pushAudio(caps, "new-session", Buffer.from("b1"), "audio/webm", 1);
        // First fragment of new session → no questions yet.
        expect(r.questions).toEqual([]);
        expect(r.status).toBe("empty_result");

        // The second push under new-session forms a window and transcribes — not old-session state.
        await pushAudio(caps, "new-session", Buffer.from("b2"), "audio/webm", 2);

        // Total transcription calls: 1 (for old-session window) + 1 (for new-session window) = 2.
        expect(caps.aiTranscription.transcribeStreamDetailed).toHaveBeenCalledTimes(2);
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
        await pushAudio(caps1, "reboot-session", Buffer.from("fragment-1"), "audio/webm", 1);

        // Simulate clean shutdown (releases LevelDB lock).
        await caps1.temporary.close();

        // Simulated reboot: brand new capability instance, same DB path.
        const caps2 = makeCapabilitiesWithWorkDir(sharedWorkDir);

        // Fragment 2 arrives at the new instance. It should find fragment 1 in DB and transcribe.
        await pushAudio(caps2, "reboot-session", Buffer.from("fragment-2"), "audio/webm", 2);

        expect(caps2.aiTranscription.transcribeStreamDetailed).toHaveBeenCalledTimes(1);
        // caps1 should NOT have been asked to transcribe (it only stored fragment 1).
        expect(caps1.aiTranscription.transcribeStreamDetailed).not.toHaveBeenCalled();
    });

    it("persists running transcript across backend restarts", async () => {
        const sharedWorkDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "live-diary-reboot-transcript-test-")
        );
        tempDirs.push(sharedWorkDir);

        // First instance: establish running transcript via fragments 1+2.
        const caps1 = makeCapabilitiesWithWorkDir(sharedWorkDir);
        await pushAudio(caps1, "persist-session", Buffer.from("f1"), "audio/webm", 1);
        await pushAudio(caps1, "persist-session", Buffer.from("f2"), "audio/webm", 2);

        // Simulate clean shutdown.
        await caps1.temporary.close();

        // Second instance (reboot): fragment 3 should see the stored window transcript
        // and call recombination.
        const caps2 = makeCapabilitiesWithWorkDir(sharedWorkDir);
        await pushAudio(caps2, "persist-session", Buffer.from("f3"), "audio/webm", 3);

        // caps2 should have called transcription (for window f2+f3) and recombination
        // (because the last window transcript was persisted).
        expect(caps2.aiTranscription.transcribeStreamDetailed).toHaveBeenCalledTimes(1);
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
        await pushAudio(caps1, "dedup-session", Buffer.from("f1"), "audio/webm", 1);
        const r2 = await pushAudio(caps1, "dedup-session", Buffer.from("f2"), "audio/webm", 2);
        expect(r2.questions[0].text).toBe("What matters most?");

        // Simulate clean shutdown.
        await caps1.temporary.close();

        // Second instance: the same question is generated again but must be deduplicated.
        const caps2 = makeCapabilitiesWithWorkDir(sharedWorkDir);
        caps2.aiDiaryQuestions.generateQuestions = jest.fn().mockResolvedValue(sameQuestion);
        await pushAudio(caps2, "dedup-session", Buffer.from("f3"), "audio/webm", 3);
        const r4 = await pushAudio(caps2, "dedup-session", Buffer.from("f4"), "audio/webm", 4);
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
        await pushAudio(caps, "sess-pending", Buffer.from("f1"), "audio/webm", 1);
        await pushAudio(caps, "sess-pending", Buffer.from("f2"), "audio/webm", 2);

        const questions = await getPendingQuestions(caps, "sess-pending");
        expect(Array.isArray(questions)).toBe(true);
        expect(questions.length).toBeGreaterThan(0);
        expect(typeof questions[0].text).toBe("string");
    });

    it("clears pending questions after they are fetched (consume-once)", async () => {
        const caps = makeCapabilities();
        await pushAudio(caps, "sess-consume", Buffer.from("f1"), "audio/webm", 1);
        await pushAudio(caps, "sess-consume", Buffer.from("f2"), "audio/webm", 2);

        // First fetch: returns questions.
        const first = await getPendingQuestions(caps, "sess-consume");
        expect(first.length).toBeGreaterThan(0);

        // Second fetch: questions have been cleared.
        const second = await getPendingQuestions(caps, "sess-consume");
        expect(second).toEqual([]);
    });

    it("accumulates questions from multiple fragments before they are fetched", async () => {
        const caps = makeCapabilities();
        // Return distinct questions for each generation to avoid deduplication.
        caps.aiDiaryQuestions.generateQuestions = jest
            .fn()
            .mockResolvedValueOnce([{ text: "Question A?", intent: "warm_reflective" }])
            .mockResolvedValueOnce([{ text: "Question B?", intent: "clarifying" }]);

        await pushAudio(caps, "sess-multi", Buffer.from("f1"), "audio/webm", 1);
        await pushAudio(caps, "sess-multi", Buffer.from("f2"), "audio/webm", 2);
        await pushAudio(caps, "sess-multi", Buffer.from("f3"), "audio/webm", 3);

        // Neither generation has been fetched yet — both should be pending.
        const pending = await getPendingQuestions(caps, "sess-multi");
        const texts = pending.map((q) => q.text);
        expect(texts).toContain("Question A?");
        expect(texts).toContain("Question B?");
    });
});
