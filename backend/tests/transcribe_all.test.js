const request = require("supertest");
const { addRoutes } = require("../src/server");
const expressApp = require("../src/express_app");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    return capabilities;
}

// Use real app, but would need to stub transcribeFile through capabilities
// TODO: Refactor to use capabilities pattern instead of jest.mock
// jest.mock("../src/transcribe", () => {
//     const original = jest.requireActual("../src/transcribe");
//     return {
//         ...original,
//         transcribeFile: jest.fn(),
//     };
// });

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

});
