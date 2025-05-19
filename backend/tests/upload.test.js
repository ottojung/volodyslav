const request = require("supertest");
const fs = require("fs");
const path = require("path");
const expressApp = require("../src/express_app");
const temporary = require("./temporary");
const { addRoutes } = require("../src/server");
const logger = require("../src/logger");

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

describe("POST /api/upload", () => {
    it("uploads a single file successfully", async () => {
        const app = await makeApp();
        const reqId = "testreq";
        const res = await request(app)
            .post(`/api/upload?request_identifier=${reqId}`)
            .attach("photos", Buffer.from("test content"), "test1.jpg");

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ success: true, files: ["test1.jpg"] });
        expect(fs.existsSync(path.join(uploadDir(), reqId, "test1.jpg"))).toBe(
            true
        );
    });

    it("uploads multiple files successfully", async () => {
        const app = await makeApp();
        // Upload first file with a unique request_identifier
        const reqId1 = "testreq1";
        const res1 = await request(app)
            .post(`/api/upload?request_identifier=${reqId1}`)
            .attach("photos", Buffer.from("first"), "first.jpg");

        expect(res1.statusCode).toBe(200);
        expect(res1.body).toEqual({ success: true, files: ["first.jpg"] });
        expect(fs.existsSync(path.join(uploadDir(), reqId1, "first.jpg"))).toBe(
            true
        );

        // Upload second file with another unique request_identifier
        const reqId2 = "testreq2";
        const res2 = await request(app)
            .post(`/api/upload?request_identifier=${reqId2}`)
            .attach("photos", Buffer.from("second"), "second.jpg");

        expect(res2.statusCode).toBe(200);
        expect(res2.body).toEqual({ success: true, files: ["second.jpg"] });
        expect(fs.existsSync(path.join(uploadDir(), reqId2, "second.jpg"))).toBe(
            true
        );
    });

    it("responds with empty files array when no files are sent", async () => {
        const app = await makeApp();
        const res = await request(app).post(
            "/api/upload?request_identifier=foo"
        );

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ success: true, files: [] });
    });
});
