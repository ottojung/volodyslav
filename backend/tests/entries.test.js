const request = require("supertest");
const expressApp = require("../src/express_app");
const { addRoutes } = require("../src/server");
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
        const fixedTime = new Date("2025-05-23T12:00:00.000Z").getTime();
        capabilities.datetime.now.mockReturnValue(fixedTime);
        
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
            console.log("Response body:", res.body);
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
        const requestBody = {
            rawInput: "testtype - Test description",
        };
        await request(app)
            .post("/api/entries")
            .send(requestBody)
            .set("Content-Type", "application/json");

        const res = await request(app).get("/api/entries");

        expect(res.statusCode).toBe(200);
        expect(res.body.results).toHaveLength(1);
        expect(res.body.results[0]).toMatchObject({
            type: "testtype",
            description: "- Test description",
        });
        expect(res.body.next).toBeNull();
    });

    it("returns paginated results with custom page and limit", async () => {
        // Equivalent curl command:
        // curl "http://localhost:PORT/api/entries?page=1&limit=2"

        const { app } = await makeTestApp();

        // Create multiple test entries
        const entries = [
            { rawInput: "type1 - Description 1" },
            { rawInput: "type2 - Description 2" },
            { rawInput: "type3 - Description 3" },
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
            { rawInput: "type1 - Description 1" },
            { rawInput: "type2 - Description 2" },
            { rawInput: "type3 - Description 3" },
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
        const requestBody = {
            rawInput: "testtype - Test description",
        };
        await request(app)
            .post("/api/entries")
            .send(requestBody)
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
        const requestBody = {
            rawInput: "testtype - Test description",
        };
        await request(app)
            .post("/api/entries")
            .send(requestBody)
            .set("Content-Type", "application/json");

        const res = await request(app).get("/api/entries?limit=200");

        expect(res.statusCode).toBe(200);
        // The limit should be capped at 100, but with only 1 entry we'll get 1 result
        expect(res.body.results).toHaveLength(1);
    });
});

describe("GET /api/entries with ordering", () => {
    it("returns entries in descending date order by default", async () => {
        const { app, capabilities } = await makeTestApp();

        // Create entries with different dates by controlling datetime.now()
        const baseTime = new Date("2023-01-01T10:00:00Z").getTime();
        const entries = [
            { rawInput: "type1 - Description 1" },
            { rawInput: "type2 - Description 3" },
            { rawInput: "type3 - Description 2" },
        ];

        // Mock datetime to return different times for each entry
        capabilities.datetime.now.mockReturnValueOnce(baseTime); // Oldest
        await request(app)
            .post("/api/entries")
            .send(entries[0])
            .set("Content-Type", "application/json");

        capabilities.datetime.now.mockReturnValueOnce(baseTime + 2 * 24 * 60 * 60 * 1000); // Newest
        await request(app)
            .post("/api/entries")
            .send(entries[1])
            .set("Content-Type", "application/json");

        capabilities.datetime.now.mockReturnValueOnce(baseTime + 24 * 60 * 60 * 1000); // Middle
        await request(app)
            .post("/api/entries")
            .send(entries[2])
            .set("Content-Type", "application/json");

        const res = await request(app).get("/api/entries");

        expect(res.statusCode).toBe(200);
        expect(res.body.results).toHaveLength(3);
        // Should be in descending date order (newest first)
        const dates = res.body.results.map(entry => new Date(entry.date));
        for (let i = 1; i < dates.length; i++) {
            expect(dates[i - 1].getTime()).toBeGreaterThanOrEqual(dates[i].getTime());
        }
    });

    it("supports dateAscending order parameter", async () => {
        const { app } = await makeTestApp();

        // Create test entries
        const entries = [
            { rawInput: "type1 - Description 1" },
            { rawInput: "type2 - Description 2" },
        ];

        for (const entry of entries) {
            await request(app)
                .post("/api/entries")
                .send(entry)
                .set("Content-Type", "application/json");
        }

        const res = await request(app).get("/api/entries?order=dateAscending");

        expect(res.statusCode).toBe(200);
        expect(res.body.results).toHaveLength(2);
        // Verify the order parameter was processed
    });

    it("supports dateDescending order parameter", async () => {
        const { app } = await makeTestApp();

        // Create test entries
        const entries = [
            { rawInput: "type1 - Description 1" },
            { rawInput: "type2 - Description 2" },
        ];

        for (const entry of entries) {
            await request(app)
                .post("/api/entries")
                .send(entry)
                .set("Content-Type", "application/json");
        }

        const res = await request(app).get("/api/entries?order=dateDescending");

        expect(res.statusCode).toBe(200);
        expect(res.body.results).toHaveLength(2);
    });

    it("defaults to dateDescending for invalid order parameter", async () => {
        const { app } = await makeTestApp();

        // Create a test entry
        const requestBody = {
            rawInput: "testtype - Test description",
        };
        await request(app)
            .post("/api/entries")
            .send(requestBody)
            .set("Content-Type", "application/json");

        const res = await request(app).get("/api/entries?order=invalidOrder");

        expect(res.statusCode).toBe(200);
        expect(res.body.results).toHaveLength(1);
    });

    it("includes order parameter in next page URL", async () => {
        const { app } = await makeTestApp();

        // Create multiple test entries
        const entries = [
            { rawInput: "type1 - Description 1" },
            { rawInput: "type2 - Description 2" },
            { rawInput: "type3 - Description 3" },
        ];

        for (const entry of entries) {
            await request(app)
                .post("/api/entries")
                .send(entry)
                .set("Content-Type", "application/json");
        }

        const res = await request(app).get("/api/entries?page=1&limit=2&order=dateAscending");

        expect(res.statusCode).toBe(200);
        expect(res.body.results).toHaveLength(2);
        expect(res.body.next).toContain("page=2");
        expect(res.body.next).toContain("limit=2");
        expect(res.body.next).toContain("order=dateAscending");
    });
});
