const request = require("supertest");
const expressApp = require("../src/express_app");
const { addRoutes } = require("../src/server");
const { getMockedRootCapabilities } = require("./spies");
const {
    stubEnvironment,
    stubLogger,
    stubEventLogRepository,
} = require("./stubs");
const fs = require("fs");
const path = require("path");
const os = require("os");

async function makeTestApp() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
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
        //   -d '{"original":"HTTP original","input":"HTTP input","type":"http-type","description":"HTTP description","modifiers":{"foo":"bar"},"date":"2025-05-23T12:00:00.000Z"}'

        const { app, capabilities } = await makeTestApp();
        const entry = {
            original: "HTTP original",
            input: "HTTP input",
            type: "http-type",
            description: "HTTP description",
            modifiers: { foo: "bar" },
            date: "2025-05-23T12:00:00.000Z",
        };
        const res = await request(app)
            .post("/api/entries")
            .send(entry)
            .set("Content-Type", "application/json");
        expect(res.statusCode).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.entry).toMatchObject({
            type: entry.type,
            description: entry.description,
            date: entry.date,
        });
        expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
            expect.objectContaining({ type: entry.type, hasFile: false }),
            expect.stringContaining("Entry created")
        );
    });

    it("returns 400 if required fields are missing", async () => {
        // Equivalent curl command:
        // curl -X POST http://localhost:PORT/api/entries \
        //   -H "Content-Type: application/json" \
        //   -d '{"type":"missing-fields"}'

        const { app } = await makeTestApp();
        const res = await request(app)
            .post("/api/entries")
            .send({ type: "missing-fields" })
            .set("Content-Type", "application/json");
        expect(res.statusCode).toBe(400);
        expect(res.body.error).toMatch(/Missing required fields/);
    });

    it("creates an entry with an asset when a file is uploaded", async () => {
        const { app, capabilities } = await makeTestApp();
        const tmpDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "entries-http-test-")
        );
        const tmpFilePath = path.join(tmpDir, "upload.txt");
        fs.writeFileSync(tmpFilePath, "uploaded content");
        const entry = {
            original: "File original",
            input: "File input",
            type: "file-type",
            description: "File description",
        };
        const res = await request(app)
            .post("/api/entries")
            .field("original", entry.original)
            .field("input", entry.input)
            .field("type", entry.type)
            .field("description", entry.description)
            .attach("file", tmpFilePath);
        expect(res.statusCode).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.entry.type).toBe(entry.type);
        expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
            expect.objectContaining({ type: entry.type, hasFile: true }),
            expect.stringContaining("Entry created")
        );
        fs.unlinkSync(tmpFilePath);
        fs.rmdirSync(tmpDir);
    });
});
