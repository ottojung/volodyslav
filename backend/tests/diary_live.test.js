const request = require("supertest");
const expressApp = require("../src/express_app");
const { addRoutes } = require("../src/server");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubAiTranscriber, stubAiDiaryQuestions, stubAiTranscriptRecombination, stubDatetime } = require("./stubs");
const { buildTestPcmBuffer, TEST_PCM_FORMAT } = require("./pcm_helpers");

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
const LONG_TRANSCRIPTION_DELAY_MS = 60;

async function flushProcessing() {
    await new Promise((resolve) => setTimeout(resolve, PROCESSING_FLUSH_DELAY_MS));
}

/**
 * Helper: send a PCM fragment via the push-pcm endpoint.
 * @param {import('supertest').SuperTest<import('supertest').Test>} app
 * @param {string} sessionId
 * @param {number} i - Fragment number (1-based).
 * @returns {import('supertest').Test}
 */
function sendPcmFragment(app, sessionId, i) {
    return request(app)
        .post(`/api/audio-recording-session/${sessionId}/push-pcm`)
        .attach("pcm", buildTestPcmBuffer(), { filename: `f${i}.pcm`, contentType: "application/octet-stream" })
        .field("sequence", String(i - 1))
        .field("startMs", String((i - 1) * 10000))
        .field("endMs", String(i * 10000))
        .field("sampleRateHz", String(TEST_PCM_FORMAT.sampleRateHz))
        .field("channels", String(TEST_PCM_FORMAT.channels))
        .field("bitDepth", String(TEST_PCM_FORMAT.bitDepth));
}

// ─── POST /api/audio-recording-session/:sessionId/push-pcm ───────────────────

describe("POST /api/audio-recording-session/:sessionId/push-pcm", () => {
    it("returns 400 when pcm file is missing", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);

        const res = await request(app)
            .post("/api/audio-recording-session/test-session/push-pcm")
            .field("sequence", "0")
            .field("startMs", "0")
            .field("endMs", "1000")
            .field("sampleRateHz", "16000")
            .field("channels", "1")
            .field("bitDepth", "16");

        expect(res.statusCode).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/Missing pcm file/i);
    });

    it("returns 404 when session does not exist", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);

        const res = await request(app)
            .post("/api/audio-recording-session/test-session/push-pcm")
            .attach("pcm", buildTestPcmBuffer(), { filename: "f.pcm", contentType: "application/octet-stream" })
            .field("sequence", "0")
            .field("startMs", "0")
            .field("endMs", "1000")
            .field("sampleRateHz", "16000")
            .field("channels", "1")
            .field("bitDepth", "16");

        expect(res.statusCode).toBe(404);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/Session not found/i);
    });

    it("returns 400 when sequence is missing", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);

        const res = await request(app)
            .post("/api/audio-recording-session/test-session/push-pcm")
            .attach("pcm", buildTestPcmBuffer(), { filename: "f.pcm", contentType: "application/octet-stream" })
            .field("startMs", "0")
            .field("endMs", "1000")
            .field("sampleRateHz", "16000")
            .field("channels", "1")
            .field("bitDepth", "16");

        expect(res.statusCode).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/startMs, endMs, or sequence/i);
    });

    it("returns 404 when sequence is valid but session has not been started", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);

        const res = await sendPcmFragment(app, "test-session", 1);

        expect(res.statusCode).toBe(404);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/Session not found/i);
    });

    it("returns 200 with accepted status on the first fragment (AI processing is async)", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);

        await request(app)
            .post("/api/audio-recording-session/start")
            .send({ sessionId: "session-first" });
        const res = await sendPcmFragment(app, "session-first", 1);

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        // Push-pcm responds immediately; live diary status is "accepted" (async).
        expect(res.body.questions).toEqual([]);
        expect(res.body.status).toBe("accepted");

        // Wait for background processing then verify transcription was not called.
        await flushProcessing();
        expect(capabilities.aiTranscription.transcribeStreamPreciseDetailed).not.toHaveBeenCalled();
    });

    it("transcribes the overlap window and makes questions available via live-questions endpoint", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);
        const sessionId = "session-two-frags";

        await request(app)
            .post("/api/audio-recording-session/start")
            .send({ sessionId });

        // First fragment — stores but background processing finds no previous fragment.
        await sendPcmFragment(app, sessionId, 1);

        // Second fragment — push-pcm responds immediately (async processing queued).
        const res = await sendPcmFragment(app, sessionId, 2);

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.status).toBe("accepted");
        expect(res.body.questions).toEqual([]);

        // Wait for background AI processing to complete.
        await flushProcessing();

        // Transcription was called once (for the overlap window formed by fragments 1+2).
        expect(capabilities.aiTranscription.transcribeStreamPreciseDetailed).toHaveBeenCalledTimes(1);
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
            .send({ sessionId });
        for (let i = 1; i <= 3; i++) {
            await sendPcmFragment(app, sessionId, i);
        }

        // Wait for all background processing to complete.
        await flushProcessing();

        // Fragments 2: transcription(1+2) → first window. No recombination (no previous window).
        // Fragments 3: transcription(2+3) → second window. Recombination(window1, window2) called.
        expect(capabilities.aiTranscription.transcribeStreamPreciseDetailed).toHaveBeenCalledTimes(2);
        expect(capabilities.aiTranscriptRecombination.recombineOverlap).toHaveBeenCalledTimes(1);
    });

    it("returns empty live-questions when the transcript is silent (empty transcription)", async () => {
        const capabilities = getTestCapabilities();
        // Override transcription to return empty.
        capabilities.aiTranscription.transcribeStreamPreciseDetailed = jest.fn().mockResolvedValue({
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
            .send({ sessionId });

        // First fragment.
        await sendPcmFragment(app, sessionId, 1);

        // Second fragment — transcription returns empty string.
        const res = await sendPcmFragment(app, sessionId, 2);

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
        capabilities.aiTranscription.transcribeStreamPreciseDetailed = jest
            .fn()
            .mockRejectedValue(new Error("Transcription API error"));
        const app = await makeApp(capabilities);
        const sessionId = "session-trans-fail";
        await request(app)
            .post("/api/audio-recording-session/start")
            .send({ sessionId });

        await sendPcmFragment(app, sessionId, 1);

        const res = await sendPcmFragment(app, sessionId, 2);

        // Push-pcm responds immediately regardless of AI failure.
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
        capabilities.aiTranscription.transcribeStreamPreciseDetailed = jest
            .fn()
            .mockImplementation(async () => {
                transcribeCallCount += 1;
                if (transcribeCallCount === 2) {
                    return new Promise((resolve) => {
                        setTimeout(() => {
                            resolve({
                                text: "late transcript that came in after a long delay now",
                                provider: "Google",
                                model: "mocked",
                                finishReason: "STOP",
                                finishMessage: null,
                                candidateTokenCount: 0,
                                usageMetadata: null,
                                modelVersion: null,
                                responseId: null,
                                structured: { transcript: "late transcript that came in after a long delay now", coverage: "full", warnings: [], unclearAudio: false },
                                rawResponse: null,
                            });
                        }, LONG_TRANSCRIPTION_DELAY_MS);
                    });
                }
                const t = `this is a good and valid transcript number ${transcribeCallCount} from the recording`;
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
        const app = await makeApp(capabilities);
        const sessionId = "session-hanging-fragment";

        await request(app)
            .post("/api/audio-recording-session/start")
            .send({ sessionId });

        for (let i = 1; i <= 4; i++) {
            await sendPcmFragment(app, sessionId, i);
        }

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
            .send({ sessionId });

        for (let i = 1; i <= 3; i++) {
            await sendPcmFragment(app, sessionId, i);
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
            .send({ sessionId });

        const pollLiveQuestions = () =>
            request(app).get(`/api/audio-recording-session/${sessionId}/live-questions`);

        // Fragment 1: only stores the PCM (background: no previous fragment, no AI).
        await sendPcmFragment(app, sessionId, 1);
        await flushProcessing();
        const lq1 = await pollLiveQuestions();
        expect(lq1.body.questions).toHaveLength(0);

        // Fragment 2: first overlap window available — question is new, should appear.
        await sendPcmFragment(app, sessionId, 2);
        await flushProcessing();
        const lq2 = await pollLiveQuestions();
        expect(lq2.body.questions).toHaveLength(1);
        expect(lq2.body.questions[0].text).toBe("How are you?");

        // Fragment 3: same question returned by AI, but already asked — deduplicated out.
        await sendPcmFragment(app, sessionId, 3);
        await flushProcessing();
        const lq3 = await pollLiveQuestions();
        expect(lq3.body.questions).toHaveLength(0);

        // Fragment 4: still deduplicated.
        await sendPcmFragment(app, sessionId, 4);
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
            .send({ sessionId });

        for (let i = 1; i <= 2; i++) {
            await sendPcmFragment(app, sessionId, i);
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
            .send({ sessionId: "session-a" });
        await sendPcmFragment(app, "session-a", 1);

        await request(app)
            .post("/api/audio-recording-session/start")
            .send({ sessionId: "session-b" });
        await sendPcmFragment(app, "session-b", 1);

        // Wait for background processing.
        await flushProcessing();

        // Each new session starts fresh with no previous fragment to combine.
        expect(capabilities.aiTranscription.transcribeStreamPreciseDetailed).not.toHaveBeenCalled();
    });
});
