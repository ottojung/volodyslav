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

describe("audio recording session route MIME validation", () => {
    it("rejects non-webm mimeType on start", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);

        const res = await request(app)
            .post("/api/audio-recording-session/start")
            .send({ sessionId: "sess-route-start", mimeType: "audio/ogg" });

        expect(res.statusCode).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/must be audio\/webm/i);
    });

    it("rejects non-webm mimeType on chunk upload", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);

        await request(app)
            .post("/api/audio-recording-session/start")
            .send({ sessionId: "sess-route-chunk", mimeType: "audio/webm" });

        const res = await request(app)
            .post("/api/audio-recording-session/sess-route-chunk/chunks")
            .attach("chunk", Buffer.from("fake-audio"), { filename: "c1.ogg", contentType: "audio/ogg" })
            .field("startMs", "0")
            .field("endMs", "10000")
            .field("sequence", "0")
            .field("mimeType", "audio/ogg");

        expect(res.statusCode).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/must be audio\/webm/i);
    });
});

