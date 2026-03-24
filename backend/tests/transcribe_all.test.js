const path = require("path");
const os = require("os");
const fs = require("fs");
const fsp = require("fs/promises");
const request = require("supertest");
const { addRoutes } = require("../src/server");
const { transcribeFile } = require("../src/transcribe");
const expressApp = require("../src/express_app");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime } = require("./stubs");
const { fromRequest } = require("../src/request_identifier");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
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
    const reqIdStr = "batch123";

    /** @returns {Promise<string>} */
    async function makeTmpDir() {
        return fsp.mkdtemp(path.join(os.tmpdir(), "transcribe-all-test-"));
    }

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
            .query({ request_identifier: reqIdStr });
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
            .query({ request_identifier: reqIdStr, input_dir: "/no/such/dir" });
        expect(res.status).toBe(404);
        expect(res.body).toEqual({
            success: false,
            error: "Could not read input directory",
        });
    });

    it("aggregates successes and failures and returns 500", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);
        // Prepare three files: a.mp4, b.mp4, c.mp4
        const tmp = await makeTmpDir();
        ["a.mp4", "b.mp4", "c.mp4"].forEach((f) =>
            fs.writeFileSync(path.join(tmp, f), "")
        );
        // Stub: succeed on a, throw on b, succeed on c
        transcribeFile.mockImplementation(async (caps, inputFile, outP) => {
            if (inputFile.path.endsWith("/b.mp4")) throw new Error("bad file");
            fs.writeFileSync(outP, "{}");
            return Promise.resolve({ path: outP });
        });
        const res = await request(app)
            .get(base)
            .query({ request_identifier: reqIdStr, input_dir: tmp });

        expect(res.status).toBe(500);
        expect(res.body.success).toBe(false);
        expect(res.body.result.failures).toHaveLength(1);
        expect(res.body.result.successes).toHaveLength(2);

        // Verify done marker is stored in temporary database.
        const reqId = fromRequest({ query: { request_identifier: reqIdStr } });
        const done = await capabilities.temporary.isDone(reqId);
        expect(done).toBe(true);

        // Cleanup
        await fsp.rm(tmp, { recursive: true }).catch(() => {});
    });

    it("succeeds when all files transcribe", async () => {
        const capabilities = getTestCapabilities();    
        const app = await makeApp(capabilities);
        // Prepare mp4 files
        const tmp = await makeTmpDir();
        ["x.mp4", "y.mp4"].forEach((f) =>
            fs.writeFileSync(path.join(tmp, f), "")
        );
        // Stub: always resolve
        transcribeFile.mockImplementation(async (caps, inputFile, outP) => {
            fs.writeFileSync(outP, "{}");
            return Promise.resolve({ path: outP });
        });
        const res = await request(app)
            .get(base)
            .query({ request_identifier: reqIdStr, input_dir: tmp });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.result.successes).toHaveLength(2);
        expect(res.body.result.failures).toHaveLength(0);

        // Verify done marker is stored in temporary database.
        const reqId = fromRequest({ query: { request_identifier: reqIdStr } });
        const done = await capabilities.temporary.isDone(reqId);
        expect(done).toBe(true);

        // Cleanup
        await fsp.rm(tmp, { recursive: true }).catch(() => {});
    });
});
