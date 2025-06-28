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
            const { app, capabilities } = await makeTestApp();

            // Create entries with different dates by controlling datetime.now()
            const baseTime = new Date("2023-01-01T10:00:00Z").getTime();
            const entries = [
                { rawInput: "test - Oldest entry" },
                { rawInput: "test - Newest entry" },
                { rawInput: "test - Middle entry" },
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

            // Verify the order is descending (newest first)
            const dates = res.body.results.map(entry => new Date(entry.date));
            for (let i = 1; i < dates.length; i++) {
                expect(dates[i - 1].getTime()).toBeGreaterThanOrEqual(dates[i].getTime());
            }
        });
    });

    describe("Explicit Order Parameters", () => {
        it("supports dateDescending order parameter", async () => {
            const { app, capabilities } = await makeTestApp();

            // Create entries with different dates by controlling datetime.now()
            const baseTime = new Date("2023-01-01T10:00:00Z").getTime();
            const entries = [
                { rawInput: "test - First" },
                { rawInput: "test - Second" },
            ];

            capabilities.datetime.now.mockReturnValueOnce(baseTime);
            await request(app)
                .post("/api/entries")
                .send(entries[0])
                .set("Content-Type", "application/json");

            capabilities.datetime.now.mockReturnValueOnce(baseTime + 24 * 60 * 60 * 1000);
            await request(app)
                .post("/api/entries")
                .send(entries[1])
                .set("Content-Type", "application/json");

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
            const { app, capabilities } = await makeTestApp();

            // Create entries with different dates by controlling datetime.now()
            const baseTime = new Date("2023-01-01T10:00:00Z").getTime();
            const entries = [
                { rawInput: "test - Second" },
                { rawInput: "test - First" },
            ];

            capabilities.datetime.now.mockReturnValueOnce(baseTime + 24 * 60 * 60 * 1000); // Second (newer)
            await request(app)
                .post("/api/entries")
                .send(entries[0])
                .set("Content-Type", "application/json");

            capabilities.datetime.now.mockReturnValueOnce(baseTime); // First (older)
            await request(app)
                .post("/api/entries")
                .send(entries[1])
                .set("Content-Type", "application/json");

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
            const { app, capabilities } = await makeTestApp();

            // Create entries with different dates by controlling datetime.now()
            const baseTime = new Date("2023-01-01T10:00:00Z").getTime();
            const entries = [
                { rawInput: "test - Entry 1" },
                { rawInput: "test - Entry 2" },
                { rawInput: "test - Entry 3" },
                { rawInput: "test - Entry 4" },
            ];

            // Create entries with incrementing timestamps
            for (let i = 0; i < entries.length; i++) {
                capabilities.datetime.now.mockReturnValueOnce(baseTime + i * 24 * 60 * 60 * 1000);
                await request(app)
                    .post("/api/entries")
                    .send(entries[i])
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

    describe("Date Processing", () => {
        it("ignores when modifiers and uses current time", async () => {
            const { app, capabilities } = await makeTestApp();

            const fixedTime = new Date("2025-06-28T10:00:00Z").getTime();
            capabilities.datetime.now.mockReturnValue(fixedTime);

            const requestBody = {
                rawInput: "test [when 2023-06-15T14:30:00Z] - Entry with when modifier",
            };
            
            const createRes = await request(app)
                .post("/api/entries")
                .send(requestBody)
                .set("Content-Type", "application/json");

            expect(createRes.statusCode).toBe(201);
            expect(createRes.body.success).toBe(true);
            
            // The created entry should use current time, not the when modifier
            expect(createRes.body.entry.date).toBe(new Date(fixedTime).toISOString().replace('.000Z', '+0000'));
        });

        it("ignores explicit date parameter and uses current time", async () => {
            const { app, capabilities } = await makeTestApp();

            const fixedTime = new Date("2025-06-28T12:00:00Z").getTime();
            capabilities.datetime.now.mockReturnValue(fixedTime);

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
            
            // The created entry should use current time, ignoring both the explicit date and when modifier
            expect(createRes.body.entry.date).toBe(new Date(fixedTime).toISOString().replace('.000Z', '+0000'));
        });
    });
});
