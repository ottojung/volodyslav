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

        // Push two fragments — ingestion only, no AI processing yet.
        await sendPcmFragment(app, sessionId, 1);
        const res = await sendPcmFragment(app, sessionId, 2);

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.status).toBe("accepted");
        expect(res.body.questions).toEqual([]);

        // Transcription must NOT have been called during push (lazy architecture).
        expect(capabilities.aiTranscription.transcribeStreamPreciseDetailed).not.toHaveBeenCalled();

        // GET /live-questions triggers the pull cycle inline and returns questions.
        const liveRes = await request(app)
            .get(`/api/audio-recording-session/${sessionId}/live-questions`);
        expect(liveRes.statusCode).toBe(200);
        expect(liveRes.body.success).toBe(true);
        expect(Array.isArray(liveRes.body.questions)).toBe(true);
        expect(liveRes.body.questions.length).toBeGreaterThan(0);

        // Transcription was called once (for the window covering both fragments).
        expect(capabilities.aiTranscription.transcribeStreamPreciseDetailed).toHaveBeenCalledTimes(1);
        // Question generation was called once.
        expect(capabilities.aiDiaryQuestions.generateQuestions).toHaveBeenCalledTimes(1);
    });

    it("calls recombination when a second pull window follows a first (lazy pull)", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);
        const sessionId = "session-three-frags";

        await request(app)
            .post("/api/audio-recording-session/start")
            .send({ sessionId });

        // Push two fragments and trigger first pull.
        await sendPcmFragment(app, sessionId, 1);
        await sendPcmFragment(app, sessionId, 2);
        // First GET: processes fragments 1+2, no prior window → no recombination.
        await request(app).get(`/api/audio-recording-session/${sessionId}/live-questions`);
        expect(capabilities.aiTranscription.transcribeStreamPreciseDetailed).toHaveBeenCalledTimes(1);
        expect(capabilities.aiTranscriptRecombination.recombineOverlap).not.toHaveBeenCalled();

        // Push fragment 3 and trigger second pull (with overlap from pull 1).
        await sendPcmFragment(app, sessionId, 3);
        // Second GET: processes fragment 3 with overlap → recombination called.
        await request(app).get(`/api/audio-recording-session/${sessionId}/live-questions`);
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

        // Push two fragments — ingestion only, no AI.
        await sendPcmFragment(app, sessionId, 1);
        const res = await sendPcmFragment(app, sessionId, 2);

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.status).toBe("accepted");
        expect(res.body.questions).toEqual([]);

        // GET /live-questions triggers pull; transcription returns "" → no questions.
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

        // GET /live-questions triggers pull; transcription fails (non-fatal) → empty questions.
        const liveRes = await request(app)
            .get(`/api/audio-recording-session/${sessionId}/live-questions`);
        expect(liveRes.statusCode).toBe(200);
        expect(liveRes.body.questions).toEqual([]);
    });

    it("produces questions via live-questions even when transcription returns slowly", async () => {
        const capabilities = getTestCapabilities();
        capabilities.aiTranscription.transcribeStreamPreciseDetailed = jest
            .fn()
            .mockImplementation(async () => {
                const t = "this is a good and valid transcript from the recording session";
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

        // GET /live-questions triggers a single pull cycle across all 4 fragments.
        const liveRes = await request(app)
            .get(`/api/audio-recording-session/${sessionId}/live-questions`);
        expect(liveRes.statusCode).toBe(200);
        expect(liveRes.body.success).toBe(true);
        expect(Array.isArray(liveRes.body.questions)).toBe(true);
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

        // Push two fragments and run first pull (no recombination on first pull).
        await sendPcmFragment(app, sessionId, 1);
        await sendPcmFragment(app, sessionId, 2);
        const lq1 = await request(app).get(`/api/audio-recording-session/${sessionId}/live-questions`);
        expect(capabilities.aiDiaryQuestions.generateQuestions).toHaveBeenCalledTimes(1);
        expect(lq1.body.questions.length).toBeGreaterThan(0);

        // Push a third fragment; second pull has overlap and tries recombination (which fails),
        // but the system gracefully falls back to the raw window transcript.
        await sendPcmFragment(app, sessionId, 3);
        const lq2 = await request(app).get(`/api/audio-recording-session/${sessionId}/live-questions`);
        // Recombination was attempted for the second window.
        expect(capabilities.aiTranscriptRecombination.recombineOverlap).toHaveBeenCalled();
        // The route responded successfully even though recombination threw.
        expect(lq2.statusCode).toBe(200);
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

        // Push fragment 1; first GET triggers first pull → question generated and returned.
        await sendPcmFragment(app, sessionId, 1);
        const lq1 = await pollLiveQuestions();
        expect(lq1.body.questions).toHaveLength(1);
        expect(lq1.body.questions[0].text).toBe("How are you?");

        // Second GET with no new fragment: pull finds no new audio → no new questions.
        const lq2 = await pollLiveQuestions();
        expect(lq2.body.questions).toHaveLength(0);

        // Push fragment 2; same question returned by AI but already asked → deduplicated out.
        await sendPcmFragment(app, sessionId, 2);
        const lq3 = await pollLiveQuestions();
        expect(lq3.body.questions).toHaveLength(0);

        // Fragment 3: still deduplicated.
        await sendPcmFragment(app, sessionId, 3);
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

        // First poll: triggers pull, generates questions, returns them.
        const first = await request(app)
            .get(`/api/audio-recording-session/${sessionId}/live-questions`);
        expect(first.body.questions.length).toBeGreaterThan(0);

        // Second poll: watermark advanced past all fragments, no new audio → empty.
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
