const request = require("supertest");
const expressApp = require("../src/express_app");
const { addRoutes } = require("../src/server");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubAiTranscriber, stubAiDiaryQuestions, stubAiTranscriptRecombination, stubDatetime } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubAiTranscriber(capabilities);
    stubAiDiaryQuestions(capabilities);
    stubAiTranscriptRecombination(capabilities);
    stubDatetime(capabilities);
    return capabilities;
}

async function makeApp(capabilities) {
    const app = expressApp.make();
    await capabilities.logger.setup();
    await capabilities.logger.enableHttpCallsLogging(app);
    await addRoutes(capabilities, app);
    return app;
}

// ─── POST /api/audio-recording-session/:sessionId/push-audio ─────────────────

describe("POST /api/audio-recording-session/:sessionId/push-audio", () => {
    it("returns 400 when audio file is missing", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);

        const res = await request(app)
            .post("/api/audio-recording-session/test-session/push-audio")
            .field("mimeType", "audio/webm")
            .field("sequence", "0")
            .field("startMs", "0")
            .field("endMs", "1000");

        expect(res.statusCode).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/Missing audio file/i);
    });

    it("returns 404 when session does not exist", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);

        const res = await request(app)
            .post("/api/audio-recording-session/test-session/push-audio")
            .attach("audio", Buffer.from("fake audio"), { filename: "f.webm", contentType: "audio/webm" })
            .field("mimeType", "audio/webm")
            .field("sequence", "0")
            .field("startMs", "0")
            .field("endMs", "1000");

        expect(res.statusCode).toBe(404);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/Session not found/i);
    });

    it("returns 400 when mimeType is missing", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);

        const res = await request(app)
            .post("/api/audio-recording-session/test-session/push-audio")
            .attach("audio", Buffer.from("fake audio"), { filename: "f.webm", contentType: "audio/webm" })
            .field("sequence", "0")
            .field("startMs", "0")
            .field("endMs", "1000");

        expect(res.statusCode).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/mimeType/i);
    });

    it("returns 400 when sequence is missing", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);

        const res = await request(app)
            .post("/api/audio-recording-session/test-session/push-audio")
            .attach("audio", Buffer.from("fake audio"), { filename: "f.webm", contentType: "audio/webm" })
            .field("mimeType", "audio/webm")
            .field("startMs", "0")
            .field("endMs", "1000");

        expect(res.statusCode).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/startMs, endMs, or sequence/i);
    });

    it("returns 404 when sequence is valid but session has not been started", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);

        const res = await request(app)
            .post("/api/audio-recording-session/test-session/push-audio")
            .attach("audio", Buffer.from("fake audio"), { filename: "f.webm", contentType: "audio/webm" })
            .field("mimeType", "audio/webm")
            .field("sequence", "0")
            .field("startMs", "0")
            .field("endMs", "1000");

        expect(res.statusCode).toBe(404);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/Session not found/i);
    });

    it("returns empty questions on the first fragment (not enough context yet)", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);

        await request(app)
            .post("/api/audio-recording-session/start")
            .send({ sessionId: "session-first", mimeType: "audio/webm" });
        const res = await request(app)
            .post("/api/audio-recording-session/session-first/push-audio")
            .attach("audio", Buffer.from("fake audio 1"), { filename: "f1.webm", contentType: "audio/webm" })
            .field("mimeType", "audio/webm")
            .field("sequence", "0")
            .field("startMs", "0")
            .field("endMs", "10000");

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.questions).toEqual([]);
        expect(res.body.status).toBe("empty_result");
        // Transcription should NOT have been called — we don't have two fragments yet.
        expect(capabilities.aiTranscription.transcribeStreamDetailed).not.toHaveBeenCalled();
    });

    it("transcribes the overlap window and returns questions on the second fragment", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);
        const sessionId = "session-two-frags";

        await request(app)
            .post("/api/audio-recording-session/start")
            .send({ sessionId, mimeType: "audio/webm" });
        // First fragment — stores but returns no questions.
        await request(app)
            .post(`/api/audio-recording-session/${sessionId}/push-audio`)
            .attach("audio", Buffer.from("audio-fragment-1"), { filename: "f1.webm", contentType: "audio/webm" })
            .field("mimeType", "audio/webm")
            .field("sequence", "0")
            .field("startMs", "0")
            .field("endMs", "10000");

        // Second fragment — triggers transcription + question generation.
        const res = await request(app)
            .post(`/api/audio-recording-session/${sessionId}/push-audio`)
            .attach("audio", Buffer.from("audio-fragment-2"), { filename: "f2.webm", contentType: "audio/webm" })
            .field("mimeType", "audio/webm")
            .field("sequence", "1")
            .field("startMs", "10000")
            .field("endMs", "20000");

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.status).toBe("ok");
        expect(Array.isArray(res.body.questions)).toBe(true);
        // Transcription was called once (for the overlap window formed by fragments 1+2).
        expect(capabilities.aiTranscription.transcribeStreamDetailed).toHaveBeenCalledTimes(1);
        // Question generation was called once.
        expect(capabilities.aiDiaryQuestions.generateQuestions).toHaveBeenCalledTimes(1);
    });

    it("calls recombination when a second window is available (third fragment)", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);
        const sessionId = "session-three-frags";

        await request(app)
            .post("/api/audio-recording-session/start")
            .send({ sessionId, mimeType: "audio/webm" });
        for (let i = 1; i <= 3; i++) {
            await request(app)
                .post(`/api/audio-recording-session/${sessionId}/push-audio`)
                .attach("audio", Buffer.from(`audio-fragment-${i}`), { filename: `f${i}.webm`, contentType: "audio/webm" })
                .field("mimeType", "audio/webm")
                .field("sequence", String(i - 1))
                .field("startMs", String((i - 1) * 10000))
                .field("endMs", String(i * 10000));
        }

        // Fragments 2: transcription(1+2) → first window. No recombination (no previous window).
        // Fragments 3: transcription(2+3) → second window. Recombination(window1, window2) called.
        expect(capabilities.aiTranscription.transcribeStreamDetailed).toHaveBeenCalledTimes(2);
        expect(capabilities.aiTranscriptRecombination.recombineOverlap).toHaveBeenCalledTimes(1);
    });

    it("returns empty questions when the transcript is silent (empty transcription)", async () => {
        const capabilities = getTestCapabilities();
        // Override transcription to return empty.
        capabilities.aiTranscription.transcribeStreamDetailed = jest.fn().mockResolvedValue({
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
        const app = await makeApp(capabilities);
        const sessionId = "session-silent";
        await request(app)
            .post("/api/audio-recording-session/start")
            .send({ sessionId, mimeType: "audio/webm" });

        // First fragment.
        await request(app)
            .post(`/api/audio-recording-session/${sessionId}/push-audio`)
            .attach("audio", Buffer.from("silence"), { filename: "s1.webm", contentType: "audio/webm" })
            .field("mimeType", "audio/webm")
            .field("sequence", "0")
            .field("startMs", "0")
            .field("endMs", "10000");

        // Second fragment — transcription returns empty string.
        const res = await request(app)
            .post(`/api/audio-recording-session/${sessionId}/push-audio`)
            .attach("audio", Buffer.from("silence"), { filename: "s2.webm", contentType: "audio/webm" })
            .field("mimeType", "audio/webm")
            .field("sequence", "1")
            .field("startMs", "10000")
            .field("endMs", "20000");

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.questions).toEqual([]);
        expect(res.body.status).toBe("ok");
    });

    it("returns 200 with empty questions when transcription fails (non-fatal)", async () => {
        const capabilities = getTestCapabilities();
        capabilities.aiTranscription.transcribeStreamDetailed = jest
            .fn()
            .mockRejectedValue(new Error("Transcription API error"));
        const app = await makeApp(capabilities);
        const sessionId = "session-trans-fail";
        await request(app)
            .post("/api/audio-recording-session/start")
            .send({ sessionId, mimeType: "audio/webm" });

        await request(app)
            .post(`/api/audio-recording-session/${sessionId}/push-audio`)
            .attach("audio", Buffer.from("audio1"), { filename: "f1.webm", contentType: "audio/webm" })
            .field("mimeType", "audio/webm")
            .field("sequence", "0")
            .field("startMs", "0")
            .field("endMs", "10000");

        const res = await request(app)
            .post(`/api/audio-recording-session/${sessionId}/push-audio`)
            .attach("audio", Buffer.from("audio2"), { filename: "f2.webm", contentType: "audio/webm" })
            .field("mimeType", "audio/webm")
            .field("sequence", "1")
            .field("startMs", "10000")
            .field("endMs", "20000");

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.questions).toEqual([]);
        expect(res.body.status).toBe("degraded_transcription");
    });

    it("returns 200 with questions even when recombination fails (fallback)", async () => {
        const capabilities = getTestCapabilities();
        // Override recombination to throw.
        capabilities.aiTranscriptRecombination.recombineOverlap = jest
            .fn()
            .mockRejectedValue(new Error("LLM unavailable"));
        const app = await makeApp(capabilities);
        const sessionId = "session-recomb-fail";
        await request(app)
            .post("/api/audio-recording-session/start")
            .send({ sessionId, mimeType: "audio/webm" });

        for (let i = 1; i <= 3; i++) {
            await request(app)
                .post(`/api/audio-recording-session/${sessionId}/push-audio`)
                .attach("audio", Buffer.from(`audio-${i}`), { filename: `f${i}.webm`, contentType: "audio/webm" })
                .field("mimeType", "audio/webm")
                .field("sequence", String(i - 1))
                .field("startMs", String((i - 1) * 10000))
                .field("endMs", String(i * 10000));
        }

        // No assertion failure — the route should have returned 200 for each call.
        // By the third call, recombination threw but we still got questions from the raw window transcript.
        expect(capabilities.aiDiaryQuestions.generateQuestions).toHaveBeenCalled();
    });

    it("deduplicates questions across successive calls within the same session", async () => {
        const capabilities = getTestCapabilities();
        // generateQuestions always returns the same question.
        capabilities.aiDiaryQuestions.generateQuestions = jest
            .fn()
            .mockResolvedValue([{ text: "How are you?", intent: "warm_reflective" }]);
        const app = await makeApp(capabilities);
        const sessionId = "session-dedup";
        await request(app)
            .post("/api/audio-recording-session/start")
            .send({ sessionId, mimeType: "audio/webm" });

        const sendFragment = (i) => request(app)
            .post(`/api/audio-recording-session/${sessionId}/push-audio`)
            .attach("audio", Buffer.from(`audio-${i}`), { filename: `f${i}.webm`, contentType: "audio/webm" })
            .field("mimeType", "audio/webm")
            .field("sequence", String(i - 1))
            .field("startMs", String((i - 1) * 10000))
            .field("endMs", String(i * 10000));

        // Fragment 1: only stores the audio, no questions yet.
        await sendFragment(1);

        // Fragment 2: first overlap window available — question is new, should be returned.
        const res2 = await sendFragment(2);
        expect(res2.body.questions).toHaveLength(1);
        expect(res2.body.questions[0].text).toBe("How are you?");

        // Fragment 3: same question returned by AI, but already asked — deduplicated out.
        const res3 = await sendFragment(3);
        expect(res3.body.questions).toHaveLength(0);

        // Fragment 4: still deduplicated.
        const res4 = await sendFragment(4);
        expect(res4.body.questions).toHaveLength(0);
    });

    it("new session cleanup resets previous live state", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);

        await request(app)
            .post("/api/audio-recording-session/start")
            .send({ sessionId: "session-a", mimeType: "audio/webm" });
        await request(app)
            .post("/api/audio-recording-session/session-a/push-audio")
            .attach("audio", Buffer.from("audio-a"), { filename: "fa.webm", contentType: "audio/webm" })
            .field("mimeType", "audio/webm")
            .field("sequence", "0")
            .field("startMs", "0")
            .field("endMs", "10000");

        await request(app)
            .post("/api/audio-recording-session/start")
            .send({ sessionId: "session-b", mimeType: "audio/webm" });
        await request(app)
            .post("/api/audio-recording-session/session-b/push-audio")
            .attach("audio", Buffer.from("audio-b"), { filename: "fb.webm", contentType: "audio/webm" })
            .field("mimeType", "audio/webm")
            .field("sequence", "0")
            .field("startMs", "0")
            .field("endMs", "10000");

        // Each new session starts fresh with no previous fragment to combine.
        expect(capabilities.aiTranscription.transcribeStreamDetailed).not.toHaveBeenCalled();
    });
});
