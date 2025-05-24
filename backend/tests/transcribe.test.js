const path = require("path");
const fs = require("fs");
const request = require("supertest");
const expressApp = require("../src/express_app");
const { addRoutes } = require("../src/server");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger } = require("./stubs");

// Mock the AITranscription capability instead of OpenAI directly
jest.mock("../src/ai/transcription", () => ({
    make: () => ({
        transcribeStream: jest.fn().mockResolvedValue("foo bar baz"),
        getTranscriberInfo: jest.fn().mockReturnValue({
            name: "gpt-4o-mini-transcribe",
            creator: "OpenAI",
        }),
    }),
    isAITranscriptionError: jest.fn(),
}));

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
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
    beforeEach(() => {
        jest.clearAllMocks();
    });

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

    it("transcribes and saves output file on valid input", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);
        // Prepare a dummy input file
        const inputDir = await capabilities.creator.createTemporaryDirectory(
            capabilities
        );
        const inputPath = path.join(inputDir, "dummy.wav");
        fs.writeFileSync(inputPath, "dummy content");

        const reqId = "testreq";
        const outputFilename = "transcription.json";
        const res = await request(app)
            .get("/api/transcribe")
            .query({ request_identifier: reqId, input: inputPath });

        // Verify response
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ success: true });

        // Verify file was written to uploadDir under the request identifier
        const uploadDir = capabilities.environment.workingDirectory();
        const savedPath = path.join(uploadDir, reqId, outputFilename);
        expect(fs.existsSync(savedPath)).toBe(true);
        const content = fs.readFileSync(savedPath, "utf8");
        // Parsed content should match the stubbed response
        expect(JSON.parse(content)).toEqual({
            text: "foo bar baz",
            transcriber: {
                creator: "OpenAI",
                name: "gpt-4o-mini-transcribe",
            },
            creator: expect.any(Object),
        });
    });
});
