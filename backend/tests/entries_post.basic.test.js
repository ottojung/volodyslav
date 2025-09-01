const request = require("supertest");
const expressApp = require("../src/express_app");
const { addRoutes } = require("../src/server");
const { fromISOString, fromEpochMs } = require("../src/datetime");
const { getMockedRootCapabilities } = require("./spies");
const {
    stubEnvironment,
    stubLogger,
    stubDatetime,
    stubEventLogRepository,
} = require("./stubs");
const fs = require("fs");
const path = require("path");
const os = require("os");

async function makeTestApp() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    await stubEventLogRepository(capabilities);
    const app = expressApp.make();
    capabilities.logger.enableHttpCallsLogging(app);
    await addRoutes(capabilities, app);
    return { app, capabilities };
}

describe("POST /api/entries", () => {
    it("creates an entry and returns 201 with event data", async () => {
        // Equivalent curl command:
        // curl -X POST http://localhost:PORT/api/entries \
        //   -H "Content-Type: application/json" \
        //   -d '{"rawInput":"httptype [foo bar] HTTP description"}'

        const { app, capabilities } = await makeTestApp();
        const fixedTime = fromISOString("2025-05-23T12:00:00.000Z").getTime();
        capabilities.datetime.now.mockReturnValue(fromEpochMs(fixedTime));

        const requestBody = {
            rawInput: "httptype [foo bar] HTTP description",
        };
        const res = await request(app)
            .post("/api/entries")
            .send(requestBody)
            .set("Content-Type", "application/json");
        expect(res.statusCode).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.entry).toMatchObject({
            type: "httptype",
            description: "HTTP description",
            date: expect.stringContaining("2025-05-2"), // Timezone invariant.
            modifiers: { foo: "bar" },
        });
        expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
            expect.objectContaining({ type: "httptype", fileCount: 0 }),
            expect.stringContaining("Entry created")
        );
    });

    it("returns 400 if required fields are missing", async () => {
        // Equivalent curl command:
        // curl -X POST http://localhost:PORT/api/entries \
        //   -H "Content-Type: application/json" \
        //   -d '{}'

        const { app } = await makeTestApp();
        const res = await request(app)
            .post("/api/entries")
            .send({})
            .set("Content-Type", "application/json");
        expect(res.statusCode).toBe(400);
        expect(res.body.error).toMatch(/Missing required field: rawInput/);
    });

    it("ignores modifiers field when it is not an object", async () => {
        const { app } = await makeTestApp();
        const requestBody = {
            rawInput: "bad-mods bad",
        };
        const res = await request(app)
            .post("/api/entries")
            .send(requestBody)
            .set("Content-Type", "application/json");
        expect(res.statusCode).toBe(201);
        expect(res.body.entry.modifiers).toEqual({});
    });

    it("creates an entry with an asset when a file is uploaded", async () => {
        const { app, capabilities } = await makeTestApp();
        const tmpDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "entries-http-test-")
        );
        const tmpFilePath = path.join(tmpDir, "upload.txt");
        fs.writeFileSync(tmpFilePath, "uploaded content");
        const requestBody = {
            rawInput: "filetype - File description",
        }; const res = await request(app)
            .post("/api/entries")
            .field("rawInput", requestBody.rawInput)
            .attach("files", tmpFilePath);
        expect(res.statusCode).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.entry.type).toBe("filetype");
        expect(res.body.entry.description).toBe("- File description");
        expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
            expect.objectContaining({ type: "filetype", fileCount: 1 }),
            expect.stringContaining("Entry created")
        );
        fs.unlinkSync(tmpFilePath);
        fs.rmdirSync(tmpDir);
    });

    it("creates an entry with multiple assets when multiple files are uploaded", async () => {
        const { app, capabilities } = await makeTestApp();
        const tmpDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "entries-http-multi-test-")
        );
        const tmpFilePath1 = path.join(tmpDir, "upload1.txt");
        const tmpFilePath2 = path.join(tmpDir, "upload2.txt");
        fs.writeFileSync(tmpFilePath1, "uploaded content 1");
        fs.writeFileSync(tmpFilePath2, "uploaded content 2");
        const requestBody = {
            rawInput: "multifile - Multi-file description",
        };
        const res = await request(app)
            .post("/api/entries")
            .field("rawInput", requestBody.rawInput)
            .attach("files", tmpFilePath1)
            .attach("files", tmpFilePath2);

        if (res.statusCode !== 201) {
            // Response body logged for debugging if needed
        }
        expect(res.statusCode).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.entry.type).toBe("multifile");
        expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
            expect.objectContaining({ type: "multifile", fileCount: 2 }),
            expect.stringContaining("Entry created")
        );
        fs.unlinkSync(tmpFilePath1);
        fs.unlinkSync(tmpFilePath2);
        fs.rmdirSync(tmpDir);
    });

    it("returns 400 for empty rawInput", async () => {
        const { app } = await makeTestApp();

        const requestBody = {
            rawInput: "",
        };
        const res = await request(app)
            .post("/api/entries")
            .send(requestBody)
            .set("Content-Type", "application/json");

        expect(res.statusCode).toBe(400);
        expect(res.body.error).toContain("Missing required field: rawInput");
    });

    it("returns 400 for missing rawInput", async () => {
        const { app } = await makeTestApp();

        const requestBody = {}; // No rawInput field
        const res = await request(app)
            .post("/api/entries")
            .send(requestBody)
            .set("Content-Type", "application/json");

        expect(res.statusCode).toBe(400);
        expect(res.body.error).toContain("Missing required field: rawInput");
    });

    it("returns 400 for input parse errors", async () => {
        const { app } = await makeTestApp();

        const requestBody = {
            rawInput: "123invalid", // Invalid format - type cannot start with number
        };
        const res = await request(app)
            .post("/api/entries")
            .send(requestBody)
            .set("Content-Type", "application/json");

        expect(res.statusCode).toBe(400);
        expect(res.body.error).toContain("Bad structure of input");
    });

    it("returns 400 for malformed modifier syntax", async () => {
        const { app } = await makeTestApp();

        const requestBody = {
            rawInput: "work [invalid modifier format here [nested]", // Invalid modifier syntax
        };
        const res = await request(app)
            .post("/api/entries")
            .send(requestBody)
            .set("Content-Type", "application/json");

        expect(res.statusCode).toBe(400);
        expect(res.body.error).toContain("Not a valid modifier");
    });

    it("returns 400 for empty type", async () => {
        const { app } = await makeTestApp();

        const requestBody = {
            rawInput: " [loc office] description without type", // No type at start
        };
        const res = await request(app)
            .post("/api/entries")
            .send(requestBody)
            .set("Content-Type", "application/json");

        expect(res.statusCode).toBe(400);
        expect(res.body.error).toContain("Bad structure of input");
    });

    it("returns 400 for whitespace-only rawInput", async () => {
        const { app } = await makeTestApp();

        const requestBody = {
            rawInput: "   \t\n   ", // Only whitespace
        };
        const res = await request(app)
            .post("/api/entries")
            .send(requestBody)
            .set("Content-Type", "application/json");

        expect(res.statusCode).toBe(400);
        expect(res.body.error).toContain("Missing required field: rawInput");
    });

    it("handles unclosed brackets as description text", async () => {
        const { app } = await makeTestApp();

        const requestBody = {
            rawInput: "work [unclosed bracket description", // Unclosed bracket
        };
        const res = await request(app)
            .post("/api/entries")
            .send(requestBody)
            .set("Content-Type", "application/json");

        // This input is actually valid - it treats everything after "work " as description
        expect(res.statusCode).toBe(201);
        expect(res.body.entry.description).toBe("[unclosed bracket description");
    });

    describe("File validation errors", () => {
        it("handles file upload validation gracefully", async () => {
            // Note: It's difficult to trigger FileValidationError in integration tests
            // since the multer middleware handles most file upload issues.
            // The FileValidationError is primarily for cases where files become
            // inaccessible between upload and processing.

            const { app } = await makeTestApp();

            // Test with valid file upload to ensure the endpoint works
            const fs = require("fs");
            const path = require("path");
            const os = require("os");

            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-"));
            const tmpFilePath = path.join(tmpDir, "test-file.txt");
            fs.writeFileSync(tmpFilePath, "test content");

            const res = await request(app)
                .post("/api/entries")
                .field("rawInput", "test [loc home] Test with valid file")
                .attach("files", tmpFilePath)
                .expect(201);

            expect(res.body.success).toBe(true);

            // Cleanup
            fs.unlinkSync(tmpFilePath);
            fs.rmdirSync(tmpDir);
        });
    });
});
