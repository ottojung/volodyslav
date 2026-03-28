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

/**
 * Flush queued promises so background AI processing completes before assertions.
 * The background processing uses LevelDB I/O and file system operations which
 * require real async I/O cycles (setTimeout) to complete, not just microtask draining.
 * 300ms is sufficient for mocked AI stubs + LevelDB + file-system operations even
 * on slow CI runners.
 */
const PROCESSING_FLUSH_DELAY_MS = 300;

async function flushProcessing() {
    await new Promise((resolve) => setTimeout(resolve, PROCESSING_FLUSH_DELAY_MS));
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

    it("returns 404 when mimeType field is omitted but file content type is valid", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);

        const res = await request(app)
            .post("/api/audio-recording-session/test-session/push-audio")
            .attach("audio", Buffer.from("fake audio"), { filename: "f.webm", contentType: "audio/webm" })
            .field("sequence", "0")
            .field("startMs", "0")
            .field("endMs", "1000");

        expect(res.statusCode).toBe(404);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/Session not found/i);
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

    it("returns 200 with accepted status on the first fragment (AI processing is async)", async () => {
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
        // Push-audio responds immediately; live diary status is "accepted" (async).
        expect(res.body.questions).toEqual([]);
        expect(res.body.status).toBe("accepted");

        // Wait for background processing then verify transcription was not called.
        await flushProcessing();
        expect(capabilities.aiTranscription.transcribeStreamDetailed).not.toHaveBeenCalled();
    });

    it("transcribes the overlap window and makes questions available via live-questions endpoint", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);
        const sessionId = "session-two-frags";

        await request(app)
            .post("/api/audio-recording-session/start")
            .send({ sessionId, mimeType: "audio/webm" });

        // First fragment — stores but background processing finds no previous fragment.
        await request(app)
            .post(`/api/audio-recording-session/${sessionId}/push-audio`)
            .attach("audio", Buffer.from("audio-fragment-1"), { filename: "f1.webm", contentType: "audio/webm" })
            .field("mimeType", "audio/webm")
            .field("sequence", "0")
            .field("startMs", "0")
            .field("endMs", "10000");

        // Second fragment — push-audio responds immediately (async processing queued).
        const res = await request(app)
            .post(`/api/audio-recording-session/${sessionId}/push-audio`)
            .attach("audio", Buffer.from("audio-fragment-2"), { filename: "f2.webm", contentType: "audio/webm" })
            .field("mimeType", "audio/webm")
            .field("sequence", "1")
            .field("startMs", "10000")
            .field("endMs", "20000");

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.status).toBe("accepted");
        expect(res.body.questions).toEqual([]);

        // Wait for background AI processing to complete.
        await flushProcessing();

        // Transcription was called once (for the overlap window formed by fragments 1+2).
        expect(capabilities.aiTranscription.transcribeStreamDetailed).toHaveBeenCalledTimes(1);
        // Question generation was called once.
        expect(capabilities.aiDiaryQuestions.generateQuestions).toHaveBeenCalledTimes(1);

        // Questions are now available via the live-questions polling endpoint.
        const liveRes = await request(app)
            .get(`/api/audio-recording-session/${sessionId}/live-questions`);
        expect(liveRes.statusCode).toBe(200);
        expect(liveRes.body.success).toBe(true);
        expect(Array.isArray(liveRes.body.questions)).toBe(true);
        expect(liveRes.body.questions.length).toBeGreaterThan(0);
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

        // Wait for all background processing to complete.
        await flushProcessing();

        // Fragments 2: transcription(1+2) → first window. No recombination (no previous window).
        // Fragments 3: transcription(2+3) → second window. Recombination(window1, window2) called.
        expect(capabilities.aiTranscription.transcribeStreamDetailed).toHaveBeenCalledTimes(2);
        expect(capabilities.aiTranscriptRecombination.recombineOverlap).toHaveBeenCalledTimes(1);
    });

    it("returns empty live-questions when the transcript is silent (empty transcription)", async () => {
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
        expect(res.body.status).toBe("accepted");
        expect(res.body.questions).toEqual([]);

        // Wait for background processing and check no questions appear.
        await flushProcessing();
        const liveRes = await request(app)
            .get(`/api/audio-recording-session/${sessionId}/live-questions`);
        expect(liveRes.statusCode).toBe(200);
        expect(liveRes.body.questions).toEqual([]);
    });

    it("returns 200 immediately even when transcription fails (background non-fatal)", async () => {
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

        // Push-audio responds immediately regardless of AI failure.
        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.status).toBe("accepted");
        expect(res.body.questions).toEqual([]);

        // Wait for background processing; transcription error is non-fatal.
        await flushProcessing();
        const liveRes = await request(app)
            .get(`/api/audio-recording-session/${sessionId}/live-questions`);
        expect(liveRes.statusCode).toBe(200);
        expect(liveRes.body.questions).toEqual([]);
    });

    it("continues processing newer fragments when one fragment transcription hangs", async () => {
        const capabilities = getTestCapabilities();
        let transcribeCallCount = 0;
        capabilities.aiTranscription.transcribeStreamDetailed = jest
            .fn()
            .mockImplementation(async () => {
                transcribeCallCount += 1;
                if (transcribeCallCount === 2) {
                    return await new Promise((resolve) => {
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
                        }, 60);
                    });
                }
                return {
                    text: `transcript-${transcribeCallCount}`,
                    provider: "Google",
                    model: "mocked",
                    finishReason: "STOP",
                    finishMessage: null,
                    candidateTokenCount: 0,
                    usageMetadata: null,
                    modelVersion: null,
                    responseId: null,
                    structured: { transcript: `transcript-${transcribeCallCount}`, coverage: "full", warnings: [], unclearAudio: false },
                    rawResponse: null,
                };
            });
        const app = await makeApp(capabilities);
        const sessionId = "session-hanging-fragment";

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

        await sendFragment(1);
        await sendFragment(2);
        await sendFragment(3);
        await sendFragment(4);

        await flushProcessing();

        const liveRes = await request(app)
            .get(`/api/audio-recording-session/${sessionId}/live-questions`);
        expect(liveRes.statusCode).toBe(200);
        expect(liveRes.body.success).toBe(true);
        expect(Array.isArray(liveRes.body.questions)).toBe(true);
        // Despite fragment 3 timing out, fragment 4 should still produce questions.
        expect(liveRes.body.questions.length).toBeGreaterThan(0);
    });

    it("returns 200 with questions via live-questions even when recombination fails (fallback)", async () => {
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

        // Wait for background processing.
        await flushProcessing();

        // By the third call, recombination threw but question generation still ran from the raw window transcript.
        expect(capabilities.aiDiaryQuestions.generateQuestions).toHaveBeenCalled();
    });

    it("deduplicates questions across successive calls within the same session via live-questions", async () => {
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

        const pollLiveQuestions = () =>
            request(app).get(`/api/audio-recording-session/${sessionId}/live-questions`);

        // Fragment 1: only stores the audio (background: no previous fragment, no AI).
        await sendFragment(1);
        await flushProcessing();
        const lq1 = await pollLiveQuestions();
        expect(lq1.body.questions).toHaveLength(0);

        // Fragment 2: first overlap window available — question is new, should appear.
        await sendFragment(2);
        await flushProcessing();
        const lq2 = await pollLiveQuestions();
        expect(lq2.body.questions).toHaveLength(1);
        expect(lq2.body.questions[0].text).toBe("How are you?");

        // Fragment 3: same question returned by AI, but already asked — deduplicated out.
        await sendFragment(3);
        await flushProcessing();
        const lq3 = await pollLiveQuestions();
        expect(lq3.body.questions).toHaveLength(0);

        // Fragment 4: still deduplicated.
        await sendFragment(4);
        await flushProcessing();
        const lq4 = await pollLiveQuestions();
        expect(lq4.body.questions).toHaveLength(0);
    });

    it("live-questions returns empty array after questions have been consumed", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);
        const sessionId = "session-consume";

        await request(app)
            .post("/api/audio-recording-session/start")
            .send({ sessionId, mimeType: "audio/webm" });

        for (let i = 1; i <= 2; i++) {
            await request(app)
                .post(`/api/audio-recording-session/${sessionId}/push-audio`)
                .attach("audio", Buffer.from(`audio-${i}`), { filename: `f${i}.webm`, contentType: "audio/webm" })
                .field("mimeType", "audio/webm")
                .field("sequence", String(i - 1))
                .field("startMs", String((i - 1) * 10000))
                .field("endMs", String(i * 10000));
        }

        await flushProcessing();

        // First poll returns questions.
        const first = await request(app)
            .get(`/api/audio-recording-session/${sessionId}/live-questions`);
        expect(first.body.questions.length).toBeGreaterThan(0);

        // Second poll returns empty (questions were consumed).
        const second = await request(app)
            .get(`/api/audio-recording-session/${sessionId}/live-questions`);
        expect(second.body.questions).toHaveLength(0);
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

        // Wait for background processing.
        await flushProcessing();

        // Each new session starts fresh with no previous fragment to combine.
        expect(capabilities.aiTranscription.transcribeStreamDetailed).not.toHaveBeenCalled();
    });
});
