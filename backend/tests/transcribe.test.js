const path = require("path");
const os = require("os");
const fsp = require("fs/promises");
const request = require("supertest");
const expressApp = require("../src/express_app");
const { addRoutes } = require("../src/server");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubAiTranscriber, stubDatetime } = require("./stubs");
const { fromRequest } = require("../src/request_identifier");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubAiTranscriber(capabilities);
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

describe("GET /api/transcribe", () => {
    it("responds with 400 if input or output param missing", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);
        const reqId = "testreq";
        const res = await request(app)
            .get("/api/transcribe")
            .query({ request_identifier: reqId });
        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({
            success: false,
            error: "Please provide the input parameter",
        });
        expect(capabilities.logger.logError).toHaveBeenCalledTimes(1);
    });

    it("responds with 404 if input file does not exist", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);
        const reqId = "testreq";
        const res = await request(app).get("/api/transcribe").query({
            request_identifier: reqId,
            input: "/nonexistent/file.wav",
        });
        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({
            success: false,
            error: "Input file not found",
        });
        expect(capabilities.logger.logError).toHaveBeenCalledTimes(1);
    });

    it("transcribes and stores result in temporary database on valid input", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);

        // Prepare a dummy input file using OS tmpdir (no longer using createTemporaryDirectory).
        const inputDir = await fsp.mkdtemp(path.join(os.tmpdir(), "transcribe-test-"));
        const inputPath = path.join(inputDir, "dummy.wav");
        await fsp.writeFile(inputPath, "dummy content");

        const reqIdStr = "testreq";
        const res = await request(app)
            .get("/api/transcribe")
            .query({ request_identifier: reqIdStr, input: inputPath });

        // Verify response
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ success: true });

        // Verify result was stored in the temporary database.
        const reqId = fromRequest({ query: { request_identifier: reqIdStr } });
        const buffer = await capabilities.temporary.getBlob(reqId, "transcription.json");
        expect(buffer).not.toBeNull();
        const content = JSON.parse(buffer.toString());
        expect(content).toEqual({
            text: "mocked transcription result",
            transcriber: {
                creator: "Mocked Creator",
                name: "mocked-transcriber",
            },
            creator: expect.any(Object),
        });

        // Verify the request is marked done.
        const done = await capabilities.temporary.isDone(reqId);
        expect(done).toBe(true);

        // Cleanup
        await fsp.rm(inputDir, { recursive: true }).catch(() => {});
    });
});
