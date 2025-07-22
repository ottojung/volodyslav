const request = require("supertest");
const path = require("path");
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

describe("POST /api/upload", () => {
    it("uploads a single file successfully", async () => {
        const capabilities = getTestCapabilities();    
        const app = await makeApp(capabilities);
        const uploadDir = capabilities.environment.workingDirectory();
        const reqId = "testreq";
        const res = await request(app)
            .post(`/api/upload?request_identifier=${reqId}`)
            .attach("files", Buffer.from("test content"), "test1.jpg");

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ success: true, files: ["test1.jpg"] });
        const uploadedFile1 = await capabilities.checker.fileExists(
            path.join(uploadDir, reqId, "test1.jpg"),
        );
        expect(uploadedFile1).not.toBeNull();
    });

    it("uploads multiple files successfully", async () => {
        const capabilities = getTestCapabilities();    
        const app = await makeApp(capabilities);
        const uploadDir = capabilities.environment.workingDirectory();
        // Upload first file with a unique request_identifier
        const reqId1 = "testreq1";
        const res1 = await request(app)
            .post(`/api/upload?request_identifier=${reqId1}`)
            .attach("files", Buffer.from("first"), "first.jpg");

        expect(res1.statusCode).toBe(200);
        expect(res1.body).toEqual({ success: true, files: ["first.jpg"] });
        const firstFile = await capabilities.checker.fileExists(
            path.join(uploadDir, reqId1, "first.jpg"),
        );
        expect(firstFile).not.toBeNull();

        // Upload second file with another unique request_identifier
        const reqId2 = "testreq2";
        const res2 = await request(app)
            .post(`/api/upload?request_identifier=${reqId2}`)
            .attach("files", Buffer.from("second"), "second.jpg");

        expect(res2.statusCode).toBe(200);
        expect(res2.body).toEqual({ success: true, files: ["second.jpg"] });
        const secondFile = await capabilities.checker.fileExists(
            path.join(uploadDir, reqId2, "second.jpg"),
        );
        expect(secondFile).not.toBeNull();
    });

    it("responds with empty files array when no files are sent", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);
        const res = await request(app).post(
            "/api/upload?request_identifier=foo"
        );

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ success: true, files: [] });
    });
});
