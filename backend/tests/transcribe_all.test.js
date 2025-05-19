const path = require("path");
const fs = require("fs");
const request = require("supertest");
const temporary = require("./temporary");
const { addRoutes } = require("../src/server");

beforeEach(temporary.beforeEach);
afterEach(temporary.afterEach);

// Mock environment exports to avoid real env dependencies
jest.mock("../src/environment", () => {
    const path = require("path");
    const temporary = require("./temporary");
    return {
        openaiAPIKey: jest.fn().mockReturnValue("test-key"),
        workingDirectory: jest.fn().mockImplementation(() => {
            return path.join(temporary.output(), "results");
        }),
        myServerPort: jest.fn().mockReturnValue(0),
        logLevel: jest.fn().mockReturnValue("silent"),
        logFile: jest.fn().mockImplementation(() => {
            return path.join(temporary.output(), "log.txt");
        }),
    };
});

// Use real app, but stub transcribeFile
jest.mock("../src/transcribe", () => {
    const original = jest.requireActual("../src/transcribe");
    return {
        ...original,
        transcribeFile: jest.fn(),
    };
});

const { transcribeFile } = require("../src/transcribe");
const expressApp = require("../src/express_app");
const logger = require("../src/logger");
const { workingDirectory } = require("../src/environment");

const uploadDir = () => workingDirectory();

const { getMockedRootCapabilities } = require('./mockCapabilities');
const capabilities = getMockedRootCapabilities();

async function makeApp() {
    const app = expressApp.make();
    await logger.setup();
    logger.enableHttpCallsLogging(app);
    await addRoutes(capabilities, app);
    return app;
}

describe("GET /api/transcribe_all", () => {
    const base = "/api/transcribe_all";
    const reqId = "batch123";

    it("returns 400 when request_identifier missing", async () => {
        const app = await makeApp();
        const res = await request(app).get(base);
        expect(res.status).toBe(400);
        expect(res.body).toEqual({
            success: false,
            error: "Missing request_identifier parameter",
        });
    });

    it("returns 400 when input_dir missing", async () => {
        const app = await makeApp();
        const res = await request(app)
            .get(base)
            .query({ request_identifier: reqId });
        expect(res.status).toBe(400);
        expect(res.body).toEqual({
            success: false,
            error: "Please provide the input_dir parameter",
        });
    });

    it("returns 404 when input_dir does not exist", async () => {
        const app = await makeApp();
        const res = await request(app)
            .get(base)
            .query({ request_identifier: reqId, input_dir: "/no/such/dir" });
        expect(res.status).toBe(404);
        expect(res.body).toEqual({
            success: false,
            error: "Could not read input directory",
        });
    });

    it("aggregates successes and failures and returns 500", async () => {
        const app = await makeApp();
        // Prepare three files: a.mp4, b.mp4, c.mp4
        const tmp = path.join(temporary.input(), "mixed");
        fs.mkdirSync(tmp, { recursive: true });
        ["a.mp4", "b.mp4", "c.mp4"].forEach((f) =>
            fs.writeFileSync(path.join(tmp, f), "")
        );
        // Stub: succeed on a, throw on b, succeed on c
        transcribeFile.mockImplementation(async (caps, inputFile, outP) => {
            if (inputFile.path.endsWith("/b.mp4")) throw new Error("bad file");
            return Promise.resolve({ path: outP }); 
        });
        const res = await request(app)
            .get(base)
            .query({ request_identifier: reqId, input_dir: tmp });

        const file = "b.mp4";
        const internalMessage = "bad file";
        const message = `Transcription failed for ${file}: ${internalMessage}`;

        expect(res.status).toBe(500);
        const expectedSuccesses = ["a.mp4", "c.mp4"].map((fname) => ({
            source: { path: path.join(tmp, fname) }, 
            target: { path: path.join(uploadDir(), reqId, `${fname}.json`) }, // Changed targetPath to target: { path: ... }
        })); 
        expect(res.body).toEqual({
            success: false,
            result: {
                failures: [{ source: { path: path.join(tmp, file) }, message }], // Changed file to source: { path: ... }
                successes: expectedSuccesses,
            },
        });

        // Even with failures, .done file should be created
        const doneFlag = path.join(uploadDir(), reqId + ".done");
        expect(fs.existsSync(doneFlag)).toBe(true);
    });

    it("succeeds when all files transcribe", async () => {
        const app = await makeApp();
        // Prepare mp4 files
        const tmp = path.join(temporary.input(), "all");
        fs.mkdirSync(tmp, { recursive: true });
        ["x.mp4", "y.mp4"].forEach((f) =>
            fs.writeFileSync(path.join(tmp, f), "")
        );
        // Stub: always resolve
        transcribeFile.mockImplementation(async (caps, inputFile, outP) => { 
            return Promise.resolve({ path: outP });
        });
        const res = await request(app)
            .get(base)
            .query({ request_identifier: reqId, input_dir: tmp });
        expect(res.status).toBe(200);
        const expectedAllSuccesses = ["x.mp4", "y.mp4"].map((fname) => ({
            source: { path: path.join(tmp, fname) }, 
            target: { path: path.join(uploadDir(), reqId, `${fname}.json`) }, // Changed targetPath to target: { path: ... }
        })); 
        expect(res.body).toEqual({
            success: true,
            result: { successes: expectedAllSuccesses, failures: [] },
        });
        // Check that .done file exists
        const doneFlag = path.join(uploadDir(), reqId + ".done");
        expect(fs.existsSync(doneFlag)).toBe(true);
    });
});
