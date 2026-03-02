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
const { getEntryById } = require("../src/entry");

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

async function createTestEntry(app, rawInput) {
    const res = await request(app)
        .post("/api/entries")
        .send({ rawInput })
        .set("Content-Type", "application/json");
    return res;
}

describe("GET /api/entries with search", () => {
    it("returns all entries when no search param is provided", async () => {
        const { app } = await makeTestApp();

        await createTestEntry(app, "food - Ate pizza");
        await createTestEntry(app, "sleep - Went to bed");

        const res = await request(app).get("/api/entries");

        expect(res.statusCode).toBe(200);
        expect(res.body.results).toHaveLength(2);
    });

    it("filters entries by type using regex", async () => {
        const { app } = await makeTestApp();

        await createTestEntry(app, "food - Ate pizza");
        await createTestEntry(app, "sleep - Went to bed");
        await createTestEntry(app, "food - Had salad");

        const res = await request(app).get("/api/entries?search=food");

        expect(res.statusCode).toBe(200);
        expect(res.body.results).toHaveLength(2);
        for (const result of res.body.results) {
            expect(result.type).toBe("food");
        }
    });

    it("filters entries by description using regex", async () => {
        const { app } = await makeTestApp();

        await createTestEntry(app, "food - Ate pizza");
        await createTestEntry(app, "food - Had salad");
        await createTestEntry(app, "sleep - Went to bed");

        const res = await request(app).get("/api/entries?search=pizza");

        expect(res.statusCode).toBe(200);
        expect(res.body.results).toHaveLength(1);
        expect(res.body.results[0].description).toContain("pizza");
    });

    it("returns empty results when regex matches nothing", async () => {
        const { app } = await makeTestApp();

        await createTestEntry(app, "food - Ate pizza");
        await createTestEntry(app, "sleep - Went to bed");

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

    it("returns 400 with error message for invalid regex", async () => {
        const { app } = await makeTestApp();

        const res = await request(app).get("/api/entries?search=%5B(invalid");

        expect(res.statusCode).toBe(400);
        expect(typeof res.body.error).toBe("string");
        expect(res.body.error.length).toBeGreaterThan(0);
    });

    it("supports regex special characters in search", async () => {
        const { app } = await makeTestApp();

        await createTestEntry(app, "food - Ate pizza");
        await createTestEntry(app, "sleep - Went to bed");
        await createTestEntry(app, "exercise - Ran 5km");

        // Match type starting with 'f' or 's'
        const res = await request(app).get(
            // URL-encoded form of: ^s|fo (matches "sleep" or "food")
            "/api/entries?search=%5Es%7Cfo"
        );

        expect(res.statusCode).toBe(200);
        // Should match 'food' and 'sleep'
        expect(res.body.results.length).toBeGreaterThanOrEqual(1);
    });

    it("search is case-insensitive", async () => {
        const { app } = await makeTestApp();

        await createTestEntry(app, "food - Ate pizza");
        await createTestEntry(app, "sleep - Went to bed");

        // Uppercase search for 'FOOD' should still match 'food'
        const res = await request(app).get("/api/entries?search=FOOD");

        expect(res.statusCode).toBe(200);
        expect(res.body.results).toHaveLength(1);
        expect(res.body.results[0].type).toBe("food");
    });

    it("search is case-insensitive for description", async () => {
        const { app } = await makeTestApp();

        await createTestEntry(app, "food - Ate Pizza");
        await createTestEntry(app, "sleep - Went to bed");

        const res = await request(app).get("/api/entries?search=PIZZA");

        expect(res.statusCode).toBe(200);
        expect(res.body.results).toHaveLength(1);
        expect(res.body.results[0].description).toContain("Pizza");
    });

    it("empty search string returns all entries", async () => {
        const { app } = await makeTestApp();

        await createTestEntry(app, "food - Ate pizza");
        await createTestEntry(app, "sleep - Went to bed");

        const res = await request(app).get("/api/entries?search=");

        expect(res.statusCode).toBe(200);
        expect(res.body.results).toHaveLength(2);
    });

    it("returns entries that match by type OR description", async () => {
        const { app } = await makeTestApp();

        await createTestEntry(app, "food - Ate pizza");
        await createTestEntry(app, "sleep - Went to food store");
        await createTestEntry(app, "exercise - Ran 5km");

        const res = await request(app).get("/api/entries?search=food");

        expect(res.statusCode).toBe(200);
        // Matches type "food" AND description containing "food store"
        expect(res.body.results).toHaveLength(2);
    });

    it("search works with pagination", async () => {
        const { app } = await makeTestApp();

        await createTestEntry(app, "food - First meal");
        await createTestEntry(app, "food - Second meal");
        await createTestEntry(app, "food - Third meal");
        await createTestEntry(app, "sleep - Went to bed");

        const res = await request(app).get("/api/entries?search=food&limit=2&page=1");

        expect(res.statusCode).toBe(200);
        expect(res.body.results).toHaveLength(2);
        expect(res.body.next).toBeDefined();
    });

    it("next URL preserves search parameter", async () => {
        const { app } = await makeTestApp();

        await createTestEntry(app, "food - First meal");
        await createTestEntry(app, "food - Second meal");
        await createTestEntry(app, "food - Third meal");
        await createTestEntry(app, "sleep - Went to bed");

        const res = await request(app).get("/api/entries?search=food&limit=2&page=1");

        expect(res.statusCode).toBe(200);
        expect(res.body.next).not.toBeNull();
        const nextUrl = new URL(res.body.next);
        expect(nextUrl.searchParams.get("search")).toBe("food");
        expect(nextUrl.searchParams.get("page")).toBe("2");
        expect(nextUrl.searchParams.get("limit")).toBe("2");
    });

    it("search pagination page 2 returns remaining results", async () => {
        const { app } = await makeTestApp();

        await createTestEntry(app, "food - First meal");
        await createTestEntry(app, "food - Second meal");
        await createTestEntry(app, "food - Third meal");

        const res = await request(app).get("/api/entries?search=food&limit=2&page=2");

        expect(res.statusCode).toBe(200);
        expect(res.body.results).toHaveLength(1);
        expect(res.body.next).toBeNull();
    });

    it("dot-star regex matches all entries", async () => {
        const { app } = await makeTestApp();

        await createTestEntry(app, "food - Ate pizza");
        await createTestEntry(app, "sleep - Went to bed");

        // '.*' matches everything
        const res = await request(app).get("/api/entries?search=.*");

        expect(res.statusCode).toBe(200);
        expect(res.body.results).toHaveLength(2);
    });

    it("search result includes all required fields", async () => {
        const { app } = await makeTestApp();

        await createTestEntry(app, "food - Ate pizza");

        const res = await request(app).get("/api/entries?search=food");

        expect(res.statusCode).toBe(200);
        expect(res.body.results).toHaveLength(1);

        const entry = res.body.results[0];
        expect(entry).toHaveProperty("id");
        expect(entry).toHaveProperty("date");
        expect(entry).toHaveProperty("type");
        expect(entry).toHaveProperty("description");
        expect(entry).toHaveProperty("input");
        expect(entry).toHaveProperty("original");
        expect(entry).toHaveProperty("modifiers");
        expect(entry).toHaveProperty("creator");
    });
});

describe("GET /api/entries/:id", () => {
    it("returns a single entry by id", async () => {
        const { app } = await makeTestApp();

        const createRes = await createTestEntry(app, "food - Ate pizza");
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

    it("returned entry has all required fields", async () => {
        const { app } = await makeTestApp();

        const createRes = await createTestEntry(app, "food - Ate pizza");
        const createdId = createRes.body.entry.id;

        const res = await request(app).get(`/api/entries/${createdId}`);

        expect(res.statusCode).toBe(200);
        const entry = res.body.entry;
        expect(entry).toHaveProperty("id");
        expect(entry).toHaveProperty("date");
        expect(entry).toHaveProperty("type");
        expect(entry).toHaveProperty("description");
        expect(entry).toHaveProperty("input");
        expect(entry).toHaveProperty("original");
        expect(entry).toHaveProperty("modifiers");
        expect(entry).toHaveProperty("creator");
    });

    it("returned entry matches created entry data", async () => {
        const { app } = await makeTestApp();

        const createRes = await createTestEntry(app, "food - Ate pizza");
        const createdEntry = createRes.body.entry;

        const res = await request(app).get(`/api/entries/${createdEntry.id}`);

        expect(res.statusCode).toBe(200);
        expect(res.body.entry.id).toBe(createdEntry.id);
        expect(res.body.entry.type).toBe(createdEntry.type);
        expect(res.body.entry.description).toBe(createdEntry.description);
    });

    it("returns 404 error message string", async () => {
        const { app } = await makeTestApp();

        const res = await request(app).get("/api/entries/doesnotexist");

        expect(res.statusCode).toBe(404);
        expect(typeof res.body.error).toBe("string");
        expect(res.body.error.length).toBeGreaterThan(0);
    });

    it("can fetch multiple different entries by id", async () => {
        const { app } = await makeTestApp();

        const res1 = await createTestEntry(app, "food - Ate pizza");
        const res2 = await createTestEntry(app, "sleep - Went to bed");

        const id1 = res1.body.entry.id;
        const id2 = res2.body.entry.id;

        const fetch1 = await request(app).get(`/api/entries/${id1}`);
        const fetch2 = await request(app).get(`/api/entries/${id2}`);

        expect(fetch1.statusCode).toBe(200);
        expect(fetch1.body.entry.type).toBe("food");

        expect(fetch2.statusCode).toBe(200);
        expect(fetch2.body.entry.type).toBe("sleep");
    });
});

describe("getEntryById unit tests", () => {
    async function makeCapabilities() {
        const capabilities = getMockedRootCapabilities();
        stubEnvironment(capabilities);
        stubDatetime(capabilities);
        stubLogger(capabilities);
        await stubEventLogRepository(capabilities);
        return capabilities;
    }

    it("returns null for non-existent id", async () => {
        const capabilities = await makeCapabilities();
        const result = await getEntryById(capabilities, "does-not-exist");
        expect(result).toBeNull();
    });

    it("returns the entry for an existing id", async () => {
        const { app, capabilities } = await makeTestApp();

        const createRes = await createTestEntry(app, "food - Ate pizza");
        const createdId = createRes.body.entry.id;

        const result = await getEntryById(capabilities, createdId);
        expect(result).not.toBeNull();
        expect(result.id.identifier).toBe(createdId);
    });

    it("returns correct entry when multiple entries exist", async () => {
        const { app, capabilities } = await makeTestApp();

        await createTestEntry(app, "food - Ate pizza");
        const res2 = await createTestEntry(app, "sleep - Went to bed");
        const sleepId = res2.body.entry.id;

        const result = await getEntryById(capabilities, sleepId);
        expect(result).not.toBeNull();
        expect(result.type).toBe("sleep");
    });
});
