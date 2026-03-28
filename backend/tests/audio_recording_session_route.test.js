const request = require("supertest");
const expressApp = require("../src/express_app");
const { addRoutes } = require("../src/server");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
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

describe("audio recording session route", () => {
    it("starts a session without mimeType", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);

        const res = await request(app)
            .post("/api/audio-recording-session/start")
            .send({ sessionId: "sess-route-start" });

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.session.sessionId).toBe("sess-route-start");
    });

    it("rejects push-pcm with missing pcm file", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);

        await request(app)
            .post("/api/audio-recording-session/start")
            .send({ sessionId: "sess-route-push" });

        const res = await request(app)
            .post("/api/audio-recording-session/sess-route-push/push-pcm")
            .field("startMs", "0")
            .field("endMs", "10000")
            .field("sequence", "0")
            .field("sampleRateHz", "16000")
            .field("channels", "1")
            .field("bitDepth", "16");

        expect(res.statusCode).toBe(400);
        expect(res.body.success).toBe(false);
    });

    it("accepts push-pcm with valid PCM payload", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);

        await request(app)
            .post("/api/audio-recording-session/start")
            .send({ sessionId: "sess-route-pcm" });

        const pcmBuffer = Buffer.from(new Int16Array(160).buffer); // 160 samples of silence
        const res = await request(app)
            .post("/api/audio-recording-session/sess-route-pcm/push-pcm")
            .attach("pcm", pcmBuffer, { filename: "fragment.pcm", contentType: "application/octet-stream" })
            .field("startMs", "0")
            .field("endMs", "10000")
            .field("sequence", "0")
            .field("sampleRateHz", "16000")
            .field("channels", "1")
            .field("bitDepth", "16");

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.status).toBe("accepted");
    });

    it("rejects push-pcm with bitDepth other than 16", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);

        await request(app)
            .post("/api/audio-recording-session/start")
            .send({ sessionId: "sess-route-bd" });

        const res = await request(app)
            .post("/api/audio-recording-session/sess-route-bd/push-pcm")
            .attach("pcm", Buffer.alloc(160), { filename: "fragment.pcm", contentType: "application/octet-stream" })
            .field("startMs", "0")
            .field("endMs", "10000")
            .field("sequence", "0")
            .field("sampleRateHz", "16000")
            .field("channels", "1")
            .field("bitDepth", "24");

        expect(res.statusCode).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/bitDepth must be 16/i);
    });
});
