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
const { pushAudio } = require("../src/live_diary");
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
        const questions = await pushAudio(caps, "sess-1", Buffer.from("audio1"), "audio/webm", 1);
        expect(questions).toEqual([]);
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
        const questions = await pushAudio(caps, "sess-q", Buffer.from("audio2"), "audio/webm", 2);
        // The stubbed generateQuestions returns 5 questions.
        expect(Array.isArray(questions)).toBe(true);
        expect(questions.length).toBeGreaterThan(0);
    });

    it("uses recombination on the third fragment (two windows available)", async () => {
        const caps = makeCapabilities();
        await pushAudio(caps, "sess-3", Buffer.from("a1"), "audio/webm", 1);
        await pushAudio(caps, "sess-3", Buffer.from("a2"), "audio/webm", 2);
        await pushAudio(caps, "sess-3", Buffer.from("a3"), "audio/webm", 3);
        expect(caps.aiTranscription.transcribeStreamDetailed).toHaveBeenCalledTimes(2);
        expect(caps.aiTranscriptRecombination.recombineOverlap).toHaveBeenCalledTimes(1);
    });

    it("returns empty questions when transcription fails (non-fatal)", async () => {
        const caps = makeCapabilities();
        caps.aiTranscription.transcribeStreamDetailed = jest
            .fn()
            .mockRejectedValue(new Error("API error"));

        await pushAudio(caps, "sess-fail", Buffer.from("a1"), "audio/webm", 1);
        const questions = await pushAudio(caps, "sess-fail", Buffer.from("a2"), "audio/webm", 2);
        expect(questions).toEqual([]);
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
        const questions = await pushAudio(caps, "sess-silent", Buffer.from("a2"), "audio/webm", 2);
        expect(questions).toEqual([]);
    });

    it("deduplicates repeated questions across consecutive calls", async () => {
        const caps = makeCapabilities();
        caps.aiDiaryQuestions.generateQuestions = jest
            .fn()
            .mockResolvedValue([{ text: "Same question?", intent: "warm_reflective" }]);

        await pushAudio(caps, "sess-dedup", Buffer.from("a1"), "audio/webm", 1);

        // Fragment 2: first window → question returned.
        const q2 = await pushAudio(caps, "sess-dedup", Buffer.from("a2"), "audio/webm", 2);
        expect(q2).toHaveLength(1);
        expect(q2[0].text).toBe("Same question?");

        // Fragment 3: same question → should be deduplicated out.
        const q3 = await pushAudio(caps, "sess-dedup", Buffer.from("a3"), "audio/webm", 3);
        expect(q3).toHaveLength(0);
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
        const q = await pushAudio(caps, "new-session", Buffer.from("b1"), "audio/webm", 1);
        // First fragment of new session → no questions yet.
        expect(q).toEqual([]);

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
        const q2 = await pushAudio(caps1, "dedup-session", Buffer.from("f2"), "audio/webm", 2);
        expect(q2[0].text).toBe("What matters most?");

        // Simulate clean shutdown.
        await caps1.temporary.close();

        // Second instance: the same question is generated again but must be deduplicated.
        const caps2 = makeCapabilitiesWithWorkDir(sharedWorkDir);
        caps2.aiDiaryQuestions.generateQuestions = jest.fn().mockResolvedValue(sameQuestion);
        await pushAudio(caps2, "dedup-session", Buffer.from("f3"), "audio/webm", 3);
        const q4 = await pushAudio(caps2, "dedup-session", Buffer.from("f4"), "audio/webm", 4);
        expect(q4).toHaveLength(0);
    });
});
