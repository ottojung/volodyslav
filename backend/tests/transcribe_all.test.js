const path = require("path");
const fs = require("fs");
const request = require("supertest");
const { addRoutes } = require("../src/server");
const { transcribeFile } = require("../src/transcribe");
const expressApp = require("../src/express_app");
const { getMockedRootCapabilities, stubEnvironment, stubLogger } = require("./mocked");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    return capabilities;
}

// Use real app, but stub transcribeFile
jest.mock("../src/transcribe", () => {
    const original = jest.requireActual("../src/transcribe");
    return {
        ...original,
        transcribeFile: jest.fn(),
    };
});

async function makeApp(capabilities) {
    const app = expressApp.make();
    capabilities.logger.setup(capabilities);
    capabilities.logger.enableHttpCallsLogging(app);
    await addRoutes(capabilities, app);
    return app;
}

describe("GET /api/transcribe_all", () => {
    const base = "/api/transcribe_all";
    const reqId = "batch123";

    it("returns 400 when request_identifier missing", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);
        const res = await request(app).get(base);
        expect(res.status).toBe(400);
        expect(res.body).toEqual({
            success: false,
            error: "Missing request_identifier parameter",
        });
    });

    it("returns 400 when input_dir missing", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);
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
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);
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
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);
        const uploadDir = capabilities.environment.workingDirectory();
        // Prepare three files: a.mp4, b.mp4, c.mp4
        const tmp = await capabilities.creator.createTemporaryDirectory(capabilities);
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
            target: { path: path.join(uploadDir, reqId, `${fname}.json`) }, // Changed targetPath to target: { path: ... }
        })); 
        expect(res.body).toEqual({
            success: false,
            result: {
                failures: [{ source: { path: path.join(tmp, file) }, message }], // Changed file to source: { path: ... }
                successes: expectedSuccesses,
            },
        });

        // Even with failures, .done file should be created
        const doneFlag = path.join(uploadDir, reqId + ".done");
        expect(fs.existsSync(doneFlag)).toBe(true);
    });

    it("succeeds when all files transcribe", async () => {
        const capabilities = getTestCapabilities();    
        const app = await makeApp(capabilities);
        const uploadDir = capabilities.environment.workingDirectory();
        // Prepare mp4 files
        const tmp = await capabilities.creator.createTemporaryDirectory(capabilities);
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
            target: { path: path.join(uploadDir, reqId, `${fname}.json`) }, // Changed targetPath to target: { path: ... }
        })); 
        expect(res.body).toEqual({
            success: true,
            result: { successes: expectedAllSuccesses, failures: [] },
        });
        // Check that .done file exists
        const doneFlag = path.join(uploadDir, reqId + ".done");
        expect(fs.existsSync(doneFlag)).toBe(true);
    });
});
