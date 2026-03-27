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

describe("POST /api/diary/live/transcribe-window", () => {
    it("returns 400 when audio file is missing", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);

        const res = await request(app)
            .post("/api/diary/live/transcribe-window")
            .field("sessionId", "test-session")
            .field("mimeType", "audio/webm")
            .field("milestoneNumber", "1")
            .field("windowStartMs", "0")
            .field("windowEndMs", "10000");

        expect(res.statusCode).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/Missing audio file/i);
    });

    it("returns 400 when sessionId is missing", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);

        const res = await request(app)
            .post("/api/diary/live/transcribe-window")
            .attach("audio", Buffer.from("fake audio data"), { filename: "window.webm", contentType: "audio/webm" })
            .field("mimeType", "audio/webm")
            .field("milestoneNumber", "1")
            .field("windowStartMs", "0")
            .field("windowEndMs", "10000");

        expect(res.statusCode).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/sessionId/i);
    });

    it("returns 400 when milestoneNumber is invalid", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);

        const res = await request(app)
            .post("/api/diary/live/transcribe-window")
            .attach("audio", Buffer.from("fake audio data"), { filename: "window.webm", contentType: "audio/webm" })
            .field("sessionId", "test-session")
            .field("mimeType", "audio/webm")
            .field("milestoneNumber", "0")
            .field("windowStartMs", "0")
            .field("windowEndMs", "10000");

        expect(res.statusCode).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/milestoneNumber/i);
    });

    it("returns 400 when windowEndMs is not greater than windowStartMs", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);

        const res = await request(app)
            .post("/api/diary/live/transcribe-window")
            .attach("audio", Buffer.from("fake audio data"), { filename: "window.webm", contentType: "audio/webm" })
            .field("sessionId", "test-session")
            .field("mimeType", "audio/webm")
            .field("milestoneNumber", "1")
            .field("windowStartMs", "5000")
            .field("windowEndMs", "5000");

        expect(res.statusCode).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/windowEndMs/i);
    });

    it("returns transcription result on valid request", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);

        const res = await request(app)
            .post("/api/diary/live/transcribe-window")
            .attach("audio", Buffer.from("fake audio data"), { filename: "window.webm", contentType: "audio/webm" })
            .field("sessionId", "test-session")
            .field("mimeType", "audio/webm")
            .field("milestoneNumber", "1")
            .field("windowStartMs", "0")
            .field("windowEndMs", "10000");

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.milestoneNumber).toBe(1);
        expect(res.body.windowStartMs).toBe(0);
        expect(res.body.windowEndMs).toBe(10000);
        expect(typeof res.body.rawText).toBe("string");
        expect(Array.isArray(res.body.tokens)).toBe(true);
        expect(capabilities.aiTranscription.transcribeStreamDetailed).toHaveBeenCalledTimes(1);
    });

    it("returns empty tokens array when transcript is empty", async () => {
        const capabilities = getTestCapabilities();
        // Override to return empty transcript
        capabilities.aiTranscription.transcribeStreamDetailed = jest.fn().mockResolvedValue({
            text: "",
            provider: "Google",
            model: "mocked-transcriber",
            finishReason: "STOP",
            finishMessage: null,
            candidateTokenCount: 0,
            usageMetadata: null,
            modelVersion: null,
            responseId: null,
            structured: {
                transcript: "",
                coverage: "full",
                warnings: [],
                unclearAudio: false,
            },
            rawResponse: null,
        });
        const app = await makeApp(capabilities);

        const res = await request(app)
            .post("/api/diary/live/transcribe-window")
            .attach("audio", Buffer.from("silence"), { filename: "window.webm", contentType: "audio/webm" })
            .field("sessionId", "test-session")
            .field("mimeType", "audio/webm")
            .field("milestoneNumber", "2")
            .field("windowStartMs", "10000")
            .field("windowEndMs", "20000");

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.rawText).toBe("");
        expect(res.body.tokens).toEqual([]);
    });
});

describe("POST /api/diary/live/generate-questions", () => {
    it("returns 400 when sessionId is missing", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);

        const res = await request(app)
            .post("/api/diary/live/generate-questions")
            .send({
                milestoneNumber: 1,
                transcriptSoFar: "I had a good day.",
                askedQuestions: [],
            });

        expect(res.statusCode).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/sessionId/i);
    });

    it("returns 400 when milestoneNumber is missing", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);

        const res = await request(app)
            .post("/api/diary/live/generate-questions")
            .send({
                sessionId: "test-session",
                transcriptSoFar: "I had a good day.",
                askedQuestions: [],
            });

        expect(res.statusCode).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/milestoneNumber/i);
    });

    it("returns 400 when transcriptSoFar is missing", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);

        const res = await request(app)
            .post("/api/diary/live/generate-questions")
            .send({
                sessionId: "test-session",
                milestoneNumber: 1,
                askedQuestions: [],
            });

        expect(res.statusCode).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/transcriptSoFar/i);
    });

    it("returns 400 when askedQuestions is not an array", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);

        const res = await request(app)
            .post("/api/diary/live/generate-questions")
            .send({
                sessionId: "test-session",
                milestoneNumber: 1,
                transcriptSoFar: "I had a good day.",
                askedQuestions: "not an array",
            });

        expect(res.statusCode).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/askedQuestions/i);
    });

    it("returns 400 when askedQuestions contains non-strings", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);

        const res = await request(app)
            .post("/api/diary/live/generate-questions")
            .send({
                sessionId: "test-session",
                milestoneNumber: 1,
                transcriptSoFar: "I had a good day.",
                askedQuestions: [42, "valid question"],
            });

        expect(res.statusCode).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/askedQuestions/i);
    });

    it("returns generated questions on valid request", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);

        const res = await request(app)
            .post("/api/diary/live/generate-questions")
            .send({
                sessionId: "test-session",
                milestoneNumber: 1,
                transcriptSoFar: "I had a good day. I went for a walk.",
                askedQuestions: [],
            });

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.milestoneNumber).toBe(1);
        expect(Array.isArray(res.body.questions)).toBe(true);
        expect(res.body.questions.length).toBeGreaterThan(0);
        expect(typeof res.body.questions[0].text).toBe("string");
        expect(typeof res.body.questions[0].intent).toBe("string");
        expect(capabilities.aiDiaryQuestions.generateQuestions).toHaveBeenCalledWith(
            "I had a good day. I went for a walk.",
            []
        );
    });

    it("passes askedQuestions to the AI service", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);

        const askedQuestions = ["How did that make you feel?", "What were you thinking?"];

        const res = await request(app)
            .post("/api/diary/live/generate-questions")
            .send({
                sessionId: "test-session",
                milestoneNumber: 3,
                transcriptSoFar: "Today was tough but I managed.",
                askedQuestions,
            });

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(capabilities.aiDiaryQuestions.generateQuestions).toHaveBeenCalledWith(
            "Today was tough but I managed.",
            askedQuestions
        );
    });
});

describe("POST /api/diary/live/recombine-overlap", () => {
    it("returns 400 when sessionId is missing", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);

        const res = await request(app)
            .post("/api/diary/live/recombine-overlap")
            .send({
                existingOverlapText: "I walked to",
                newWindowText: "I walked to the store",
            });

        expect(res.statusCode).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/sessionId/i);
    });

    it("returns 400 when existingOverlapText is missing", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);

        const res = await request(app)
            .post("/api/diary/live/recombine-overlap")
            .send({
                sessionId: "test-session",
                newWindowText: "I walked to the store",
            });

        expect(res.statusCode).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/existingOverlapText/i);
    });

    it("returns 400 when newWindowText is missing", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);

        const res = await request(app)
            .post("/api/diary/live/recombine-overlap")
            .send({
                sessionId: "test-session",
                existingOverlapText: "I walked to",
            });

        expect(res.statusCode).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/newWindowText/i);
    });

    it("returns recombined text on valid request", async () => {
        const capabilities = getTestCapabilities();
        capabilities.aiTranscriptRecombination.recombineOverlap = jest
            .fn()
            .mockResolvedValue("I walked to the store");
        const app = await makeApp(capabilities);

        const res = await request(app)
            .post("/api/diary/live/recombine-overlap")
            .send({
                sessionId: "test-session",
                existingOverlapText: "I walked to",
                newWindowText: "walked to the store",
            });

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.recombinedText).toBe("I walked to the store");
        expect(capabilities.aiTranscriptRecombination.recombineOverlap).toHaveBeenCalledWith(
            "I walked to",
            "walked to the store"
        );
    });

    it("returns 500 when recombination fails", async () => {
        const capabilities = getTestCapabilities();
        capabilities.aiTranscriptRecombination.recombineOverlap = jest
            .fn()
            .mockRejectedValue(new Error("LLM failure"));
        const app = await makeApp(capabilities);

        const res = await request(app)
            .post("/api/diary/live/recombine-overlap")
            .send({
                sessionId: "test-session",
                existingOverlapText: "I walked to",
                newWindowText: "walked to the store",
            });

        expect(res.statusCode).toBe(500);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/recombination failed/i);
    });

    it("accepts empty strings as valid inputs", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);

        const res = await request(app)
            .post("/api/diary/live/recombine-overlap")
            .send({
                sessionId: "test-session",
                existingOverlapText: "",
                newWindowText: "hello world",
            });

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
    });
});
