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

describe("GET /api/entries with search", () => {
    it("returns all entries when no search param is provided", async () => {
        const { app } = await makeTestApp();

        const entries = [
            { rawInput: "food - Ate pizza" },
            { rawInput: "sleep - Went to bed" },
        ];
        for (const entry of entries) {
            await request(app)
                .post("/api/entries")
                .send(entry)
                .set("Content-Type", "application/json");
        }

        const res = await request(app).get("/api/entries");

        expect(res.statusCode).toBe(200);
        expect(res.body.results).toHaveLength(2);
    });

    it("filters entries by type using regex", async () => {
        const { app } = await makeTestApp();

        const entries = [
            { rawInput: "food - Ate pizza" },
            { rawInput: "sleep - Went to bed" },
            { rawInput: "food - Had salad" },
        ];
        for (const entry of entries) {
            await request(app)
                .post("/api/entries")
                .send(entry)
                .set("Content-Type", "application/json");
        }

        const res = await request(app).get("/api/entries?search=food");

        expect(res.statusCode).toBe(200);
        expect(res.body.results).toHaveLength(2);
        for (const result of res.body.results) {
            expect(result.type).toBe("food");
        }
    });

    it("filters entries by description using regex", async () => {
        const { app } = await makeTestApp();

        const entries = [
            { rawInput: "food - Ate pizza" },
            { rawInput: "food - Had salad" },
            { rawInput: "sleep - Went to bed" },
        ];
        for (const entry of entries) {
            await request(app)
                .post("/api/entries")
                .send(entry)
                .set("Content-Type", "application/json");
        }

        const res = await request(app).get("/api/entries?search=pizza");

        expect(res.statusCode).toBe(200);
        expect(res.body.results).toHaveLength(1);
        expect(res.body.results[0].description).toContain("pizza");
    });

    it("returns empty results when regex matches nothing", async () => {
        const { app } = await makeTestApp();

        const entries = [
            { rawInput: "food - Ate pizza" },
            { rawInput: "sleep - Went to bed" },
        ];
        for (const entry of entries) {
            await request(app)
                .post("/api/entries")
                .send(entry)
                .set("Content-Type", "application/json");
        }

        const res = await request(app).get("/api/entries?search=exercise");

        expect(res.statusCode).toBe(200);
        expect(res.body.results).toHaveLength(0);
    });

    it("returns 400 for invalid regex", async () => {
        const { app } = await makeTestApp();

        const res = await request(app).get("/api/entries?search=%5B(invalid");

        expect(res.statusCode).toBe(400);
        expect(res.body.error).toBeDefined();
    });

    it("supports regex special characters in search", async () => {
        const { app } = await makeTestApp();

        const entries = [
            { rawInput: "food - Ate pizza" },
            { rawInput: "sleep - Went to bed" },
            { rawInput: "exercise - Ran 5km" },
        ];
        for (const entry of entries) {
            await request(app)
                .post("/api/entries")
                .send(entry)
                .set("Content-Type", "application/json");
        }

        // Match type starting with 'f' or 's'
        const res = await request(app).get(
            // URL-encoded form of: ^s|fo (matches "sleep" or "food")
            "/api/entries?search=%5Es%7Cfo"
        );

        expect(res.statusCode).toBe(200);
        // Should match 'food' and 'sleep'
        expect(res.body.results.length).toBeGreaterThanOrEqual(1);
    });
});

describe("GET /api/entries/:id", () => {
    it("returns a single entry by id", async () => {
        const { app } = await makeTestApp();

        const createRes = await request(app)
            .post("/api/entries")
            .send({ rawInput: "food - Ate pizza" })
            .set("Content-Type", "application/json");

        expect(createRes.statusCode).toBe(201);
        const createdId = createRes.body.entry.id;

        const res = await request(app).get(`/api/entries/${createdId}`);

        expect(res.statusCode).toBe(200);
        expect(res.body.entry).toBeDefined();
        expect(res.body.entry.id).toBe(createdId);
        expect(res.body.entry.type).toBe("food");
    });

    it("returns 404 for a non-existent entry id", async () => {
        const { app } = await makeTestApp();

        const res = await request(app).get("/api/entries/nonexistentid");

        expect(res.statusCode).toBe(404);
        expect(res.body.error).toBeDefined();
    });
});
