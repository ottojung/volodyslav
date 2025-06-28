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

describe("API Ordering Integration Tests", () => {
    describe("Phone Script Bug Fix", () => {
        it("returns 'results' field not 'entries' field", async () => {
            const { app } = await makeTestApp();

            // Create a test entry
            const requestBody = {
                rawInput: "test - Phone script bug fix test",
            };
            await request(app)
                .post("/api/entries")
                .send(requestBody)
                .set("Content-Type", "application/json");

            const res = await request(app).get("/api/entries?page=1&limit=10");

            expect(res.statusCode).toBe(200);
            expect(res.body).toHaveProperty("results");
            expect(res.body).not.toHaveProperty("entries");
            expect(Array.isArray(res.body.results)).toBe(true);
        });
    });

    describe("Default Ordering Behavior", () => {
        it("defaults to dateDescending when no order parameter is provided", async () => {
            const { app } = await makeTestApp();

            // Create entries with specific dates using [when DATE] modifiers
            const entries = [
                { rawInput: "test [when 2023-01-01T10:00:00Z] - Oldest entry" },
                { rawInput: "test [when 2023-01-03T10:00:00Z] - Newest entry" },
                { rawInput: "test [when 2023-01-02T10:00:00Z] - Middle entry" },
            ];

            for (const entry of entries) {
                await request(app)
                    .post("/api/entries")
                    .send(entry)
                    .set("Content-Type", "application/json");
            }

            const res = await request(app).get("/api/entries");

            expect(res.statusCode).toBe(200);
            expect(res.body.results).toHaveLength(3);

            // Find our test entries and verify they are in descending date order
            const testEntries = res.body.results.filter(entry => 
                entry.date.includes('2023-01-0')
            );

            expect(testEntries).toHaveLength(3);

            // Verify the order is descending (newest first)
            const dates = testEntries.map(entry => new Date(entry.date));
            for (let i = 1; i < dates.length; i++) {
                expect(dates[i - 1].getTime()).toBeGreaterThanOrEqual(dates[i].getTime());
            }
        });
    });

    describe("Explicit Order Parameters", () => {
        it("supports dateDescending order parameter", async () => {
            const { app } = await makeTestApp();

            // Create entries with specific dates
            const entries = [
                { rawInput: "test [when 2023-01-01T10:00:00Z] - First" },
                { rawInput: "test [when 2023-01-02T10:00:00Z] - Second" },
            ];

            for (const entry of entries) {
                await request(app)
                    .post("/api/entries")
                    .send(entry)
                    .set("Content-Type", "application/json");
            }

            const res = await request(app).get("/api/entries?order=dateDescending");

            expect(res.statusCode).toBe(200);
            
            // Verify entries are in descending order
            for (let i = 1; i < res.body.results.length; i++) {
                const currentDate = new Date(res.body.results[i].date);
                const previousDate = new Date(res.body.results[i - 1].date);
                expect(previousDate.getTime()).toBeGreaterThanOrEqual(currentDate.getTime());
            }
        });

        it("supports dateAscending order parameter", async () => {
            const { app } = await makeTestApp();

            // Create entries with specific dates
            const entries = [
                { rawInput: "test [when 2023-01-02T10:00:00Z] - Second" },
                { rawInput: "test [when 2023-01-01T10:00:00Z] - First" },
            ];

            for (const entry of entries) {
                await request(app)
                    .post("/api/entries")
                    .send(entry)
                    .set("Content-Type", "application/json");
            }

            const res = await request(app).get("/api/entries?order=dateAscending");

            expect(res.statusCode).toBe(200);
            
            // Verify entries are in ascending order
            for (let i = 1; i < res.body.results.length; i++) {
                const currentDate = new Date(res.body.results[i].date);
                const previousDate = new Date(res.body.results[i - 1].date);
                expect(currentDate.getTime()).toBeGreaterThanOrEqual(previousDate.getTime());
            }
        });

        it("defaults to dateDescending for invalid order parameter", async () => {
            const { app } = await makeTestApp();

            // Create a test entry
            const requestBody = {
                rawInput: "test - Invalid order test",
            };
            await request(app)
                .post("/api/entries")
                .send(requestBody)
                .set("Content-Type", "application/json");

            const res = await request(app).get("/api/entries?order=invalidOrder");

            expect(res.statusCode).toBe(200);
            expect(res.body.results).toBeDefined();
            
            // Should still work and return results in descending order
            expect(res.body.results.length).toBeGreaterThan(0);
            
            // Extract all dates and verify they are in descending order
            const dates = res.body.results.map(entry => new Date(entry.date));
            for (let i = 1; i < dates.length; i++) {
                expect(dates[i - 1].getTime()).toBeGreaterThanOrEqual(dates[i].getTime());
            }
        });
    });

    describe("Pagination with Ordering", () => {
        it("maintains order parameter in next page URLs", async () => {
            const { app } = await makeTestApp();

            // Create multiple entries
            const entries = [
                { rawInput: "test1 - Entry 1" },
                { rawInput: "test2 - Entry 2" },
                { rawInput: "test3 - Entry 3" },
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
            
            // Next URL should contain order parameter
            expect(res.body.next).toBeDefined();
            expect(res.body.next).toContain("order=dateAscending");
            expect(res.body.next).toContain("page=2");
            expect(res.body.next).toContain("limit=2");
        });

        it("maintains correct ordering across paginated results", async () => {
            const { app } = await makeTestApp();

            // Create entries with specific dates
            const entries = [
                { rawInput: "test [when 2023-01-01T10:00:00Z] - Entry 1" },
                { rawInput: "test [when 2023-01-02T10:00:00Z] - Entry 2" },
                { rawInput: "test [when 2023-01-03T10:00:00Z] - Entry 3" },
                { rawInput: "test [when 2023-01-04T10:00:00Z] - Entry 4" },
            ];

            for (const entry of entries) {
                await request(app)
                    .post("/api/entries")
                    .send(entry)
                    .set("Content-Type", "application/json");
            }

            // Get first page with descending order
            const page1 = await request(app).get("/api/entries?page=1&limit=2&order=dateDescending");
            expect(page1.statusCode).toBe(200);
            expect(page1.body.results).toHaveLength(2);

            // Get second page
            const page2 = await request(app).get("/api/entries?page=2&limit=2&order=dateDescending");
            expect(page2.statusCode).toBe(200);

            // Verify ordering is maintained across pages
            expect(page1.body.results.length).toBeGreaterThan(0);
            expect(page2.body.results.length).toBeGreaterThan(0);
            
            const lastFromPage1 = new Date(page1.body.results[page1.body.results.length - 1].date);
            const firstFromPage2 = new Date(page2.body.results[0].date);
            expect(lastFromPage1.getTime()).toBeGreaterThanOrEqual(firstFromPage2.getTime());
        });
    });

    describe("Client Compatibility", () => {
        it("works with frontend API call format", async () => {
            const { app } = await makeTestApp();

            // Create a test entry
            const requestBody = {
                rawInput: "test - Frontend compatibility test",
            };
            await request(app)
                .post("/api/entries")
                .send(requestBody)
                .set("Content-Type", "application/json");

            // Test the exact call format used by frontend
            const res = await request(app).get("/api/entries?limit=10&order=dateDescending");

            expect(res.statusCode).toBe(200);
            expect(res.body).toHaveProperty("results");
            expect(Array.isArray(res.body.results)).toBe(true);
            
            // Verify each entry has the expected fields
            expect(res.body.results.length).toBeGreaterThan(0);
            const entry = res.body.results[0];
            const requiredFields = ['id', 'date', 'type', 'description', 'input', 'original'];
            
            for (const field of requiredFields) {
                expect(entry).toHaveProperty(field);
            }
        });

        it("works with phone script API call format", async () => {
            const { app } = await makeTestApp();

            // Create a test entry
            const requestBody = {
                rawInput: "test - Phone script compatibility test",
            };
            await request(app)
                .post("/api/entries")
                .send(requestBody)
                .set("Content-Type", "application/json");

            // Test the exact call format used by phone script
            const res = await request(app).get("/api/entries?page=1&limit=10&order=dateDescending");

            expect(res.statusCode).toBe(200);
            expect(res.body).toHaveProperty("results");
            expect(Array.isArray(res.body.results)).toBe(true);
            
            // Verify entries have original or input fields that phone script expects
            expect(res.body.results.length).toBeGreaterThan(0);
            const entry = res.body.results[0];
            expect(entry.original || entry.input).toBeDefined();
        });
    });

    describe("Date Modifier Processing", () => {
        it("extracts date from [when DATE] modifier", async () => {
            const { app } = await makeTestApp();

            const requestBody = {
                rawInput: "test [when 2023-06-15T14:30:00Z] - Entry with specific date",
            };
            
            const createRes = await request(app)
                .post("/api/entries")
                .send(requestBody)
                .set("Content-Type", "application/json");

            expect(createRes.statusCode).toBe(201);
            expect(createRes.body.success).toBe(true);
            
            // The created entry should have the date from the modifier
            expect(createRes.body.entry.date).toBe("2023-06-15T14:30:00+0000");
        });

        it("prioritizes explicit date over when modifier", async () => {
            const { app } = await makeTestApp();

            const requestBody = {
                rawInput: "test [when 2023-06-15T14:30:00Z] - Entry with both dates",
                date: "2023-07-01T10:00:00Z"
            };
            
            const createRes = await request(app)
                .post("/api/entries")
                .send(requestBody)
                .set("Content-Type", "application/json");

            expect(createRes.statusCode).toBe(201);
            expect(createRes.body.success).toBe(true);
            
            // The created entry should use the explicit date, not the modifier
            expect(createRes.body.entry.date).toBe("2023-07-01T10:00:00+0000");
        });
    });
});
