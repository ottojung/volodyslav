const request = require("supertest");
const { makeTestApp } = require("./api_ordering_test_setup");

describe("API Ordering Integration Tests", () => {
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
            const baseTime = capabilities.datetime.fromISOString("2023-01-01T10:00:00Z").getTime();
            const entries = [
                { rawInput: "test - Entry 1" },
                { rawInput: "test - Entry 2" },
                { rawInput: "test - Entry 3" },
                { rawInput: "test - Entry 4" },
            ];

            // Create entries with incrementing timestamps
            for (let i = 0; i < entries.length; i++) {
                capabilities.datetime.now.mockReturnValueOnce(
                    capabilities.datetime.fromEpochMs(baseTime + i * 24 * 60 * 60 * 1000)
                );
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

            const lastFromPage1 = capabilities.datetime.fromISOString(page1.body.results[page1.body.results.length - 1].date);
            const firstFromPage2 = capabilities.datetime.fromISOString(page2.body.results[0].date);
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

            const fixedTime = capabilities.datetime.fromISOString("2025-06-28T10:00:00Z").getTime();
            capabilities.datetime.now.mockReturnValue(
                capabilities.datetime.fromEpochMs(fixedTime)
            );

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
            // Parse the returned date and compare timestamps to avoid timezone issues
            const returnedDate = capabilities.datetime.fromISOString(createRes.body.entry.date);
            expect(returnedDate.getTime()).toBe(fixedTime);
        });

        it("ignores explicit date parameter and uses current time", async () => {
            const { app, capabilities } = await makeTestApp();

            const fixedTime = capabilities.datetime.fromISOString("2025-06-28T12:00:00Z").getTime();
            capabilities.datetime.now.mockReturnValue(
                capabilities.datetime.fromEpochMs(fixedTime)
            );

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
            // Parse the returned date and compare timestamps to avoid timezone issues
            const returnedDate = capabilities.datetime.fromISOString(createRes.body.entry.date);
            expect(returnedDate.getTime()).toBe(fixedTime);
        });
    });
});
