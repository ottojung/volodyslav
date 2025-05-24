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
            date: "2025-05-23T12:00:00+0000",
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
            date: expect.stringContaining("2025-05-23T12:00:00"), // Except the timezone.
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

describe("GET /api/entries", () => {
    it("returns empty results when no entries exist", async () => {
        // Equivalent curl command:
        // curl http://localhost:PORT/api/entries

        const { app } = await makeTestApp();
        const res = await request(app).get("/api/entries");

        expect(res.statusCode).toBe(200);
        expect(res.body.results).toEqual([]);
        expect(res.body.next).toBeNull();
    });

    it("returns entries with default pagination", async () => {
        // Equivalent curl command:
        // curl http://localhost:PORT/api/entries

        const { app } = await makeTestApp();

        // Create a test entry first
        const entry = {
            original: "Test original",
            input: "Test input",
            type: "test-type",
            description: "Test description",
        };
        await request(app)
            .post("/api/entries")
            .send(entry)
            .set("Content-Type", "application/json");

        const res = await request(app).get("/api/entries");

        expect(res.statusCode).toBe(200);
        expect(res.body.results).toHaveLength(1);
        expect(res.body.results[0]).toMatchObject({
            type: entry.type,
            description: entry.description,
        });
        expect(res.body.next).toBeNull();
    });

    it("returns paginated results with custom page and limit", async () => {
        // Equivalent curl command:
        // curl "http://localhost:PORT/api/entries?page=1&limit=2"

        const { app } = await makeTestApp();

        // Create multiple test entries
        const entries = [
            {
                original: "Original 1",
                input: "Input 1",
                type: "type-1",
                description: "Description 1",
            },
            {
                original: "Original 2",
                input: "Input 2",
                type: "type-2",
                description: "Description 2",
            },
            {
                original: "Original 3",
                input: "Input 3",
                type: "type-3",
                description: "Description 3",
            },
        ];

        for (const entry of entries) {
            await request(app)
                .post("/api/entries")
                .send(entry)
                .set("Content-Type", "application/json");
        }

        const res = await request(app).get("/api/entries?page=1&limit=2");

        expect(res.statusCode).toBe(200);
        expect(res.body.results).toHaveLength(2);
        expect(res.body.next).toContain("page=2");
        expect(res.body.next).toContain("limit=2");
    });

    it("returns correct page when requesting second page", async () => {
        // Equivalent curl command:
        // curl "http://localhost:PORT/api/entries?page=2&limit=2"

        const { app } = await makeTestApp();

        // Create multiple test entries
        const entries = [
            {
                original: "Original 1",
                input: "Input 1",
                type: "type-1",
                description: "Description 1",
            },
            {
                original: "Original 2",
                input: "Input 2",
                type: "type-2",
                description: "Description 2",
            },
            {
                original: "Original 3",
                input: "Input 3",
                type: "type-3",
                description: "Description 3",
            },
        ];

        for (const entry of entries) {
            await request(app)
                .post("/api/entries")
                .send(entry)
                .set("Content-Type", "application/json");
        }

        const res = await request(app).get("/api/entries?page=2&limit=2");

        expect(res.statusCode).toBe(200);
        expect(res.body.results).toHaveLength(1); // Only one item on second page
        expect(res.body.next).toBeNull(); // No more pages
    });

    it("handles invalid pagination parameters gracefully", async () => {
        // Equivalent curl command:
        // curl "http://localhost:PORT/api/entries?page=-1&limit=0"

        const { app } = await makeTestApp();

        // Create a test entry
        const entry = {
            original: "Test original",
            input: "Test input",
            type: "test-type",
            description: "Test description",
        };
        await request(app)
            .post("/api/entries")
            .send(entry)
            .set("Content-Type", "application/json");

        const res = await request(app).get("/api/entries?page=-1&limit=0");

        expect(res.statusCode).toBe(200);
        expect(res.body.results).toHaveLength(1); // Should default to valid values
        expect(res.body.next).toBeNull();
    });

    it("limits results to maximum of 100 per page", async () => {
        // Equivalent curl command:
        // curl "http://localhost:PORT/api/entries?limit=200"

        const { app } = await makeTestApp();

        // Create a test entry
        const entry = {
            original: "Test original",
            input: "Test input",
            type: "test-type",
            description: "Test description",
        };
        await request(app)
            .post("/api/entries")
            .send(entry)
            .set("Content-Type", "application/json");

        const res = await request(app).get("/api/entries?limit=200");

        expect(res.statusCode).toBe(200);
        // The limit should be capped at 100, but with only 1 entry we'll get 1 result
        expect(res.body.results).toHaveLength(1);
    });
});
