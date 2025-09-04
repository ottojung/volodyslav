const request = require("supertest");
const { makeTestApp } = require("./api_ordering_test_setup");
const { fromISOString } = require("../src/datetime");

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
            const baseTime = fromISOString("2023-01-01T10:00:00Z");
            const entries = [
                { rawInput: "test - Oldest entry" },
                { rawInput: "test - Newest entry" },
                { rawInput: "test - Middle entry" },
            ];

            // Mock datetime to return different times for each entry
            capabilities.datetime.now.mockReturnValueOnce(
                baseTime
            ); // Oldest
            await request(app)
                .post("/api/entries")
                .send(entries[0])
                .set("Content-Type", "application/json");

            capabilities.datetime.now.mockReturnValueOnce(
                baseTime + 2 * 24 * 60 * 60 * 1000
            ); // Newest
            await request(app)
                .post("/api/entries")
                .send(entries[1])
                .set("Content-Type", "application/json");

            capabilities.datetime.now.mockReturnValueOnce(
                baseTime + 24 * 60 * 60 * 1000
            ); // Middle
            await request(app)
                .post("/api/entries")
                .send(entries[2])
                .set("Content-Type", "application/json");

            const res = await request(app).get("/api/entries");

            expect(res.statusCode).toBe(200);
            expect(res.body.results).toHaveLength(3);

            // Verify the order is descending (newest first)
            const dates = res.body.results.map(entry => fromISOString(entry.date));
            for (let i = 1; i < dates.length; i++) {
                expect(dates[i - 1]).toBeGreaterThanOrEqual(dates[i]);
            }
        });
    });

    describe("Explicit Order Parameters", () => {
        it("supports dateDescending order parameter", async () => {
            const { app, capabilities } = await makeTestApp();

            // Create entries with different dates by controlling datetime.now()
            const baseTime = fromISOString("2023-01-01T10:00:00Z");
            const entries = [
                { rawInput: "test - First" },
                { rawInput: "test - Second" },
            ];

            capabilities.datetime.now.mockReturnValueOnce(
                baseTime
            );
            await request(app)
                .post("/api/entries")
                .send(entries[0])
                .set("Content-Type", "application/json");

            capabilities.datetime.now.mockReturnValueOnce(
                baseTime + 24 * 60 * 60 * 1000
            );
            await request(app)
                .post("/api/entries")
                .send(entries[1])
                .set("Content-Type", "application/json");

            const res = await request(app).get("/api/entries?order=dateDescending");

            expect(res.statusCode).toBe(200);

            // Verify entries are in descending order
            for (let i = 1; i < res.body.results.length; i++) {
                const currentDate = fromISOString(res.body.results[i].date);
                const previousDate = fromISOString(res.body.results[i - 1].date);
                expect(previousDate).toBeGreaterThanOrEqual(currentDate);
            }
        });

        it("supports dateAscending order parameter", async () => {
            const { app, capabilities } = await makeTestApp();

            // Create entries with different dates by controlling datetime.now()
            const baseTime = fromISOString("2023-01-01T10:00:00Z");
            const entries = [
                { rawInput: "test - Second" },
                { rawInput: "test - First" },
            ];

            capabilities.datetime.now.mockReturnValueOnce(
                baseTime + 24 * 60 * 60 * 1000
            ); // Second (newer)
            await request(app)
                .post("/api/entries")
                .send(entries[0])
                .set("Content-Type", "application/json");

            capabilities.datetime.now.mockReturnValueOnce(
                baseTime
            ); // First (older)
            await request(app)
                .post("/api/entries")
                .send(entries[1])
                .set("Content-Type", "application/json");

            const res = await request(app).get("/api/entries?order=dateAscending");

            expect(res.statusCode).toBe(200);

            // Verify entries are in ascending order
            for (let i = 1; i < res.body.results.length; i++) {
                const currentDate = fromISOString(res.body.results[i].date);
                const previousDate = fromISOString(res.body.results[i - 1].date);
                expect(currentDate).toBeGreaterThanOrEqual(previousDate);
            }
        });

        it("defaults to dateDescending for invalid order parameter", async () => {
            const { app, capabilities } = await makeTestApp(); // eslint-disable-line no-unused-vars

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
            const dates = res.body.results.map(entry => fromISOString(entry.date));
            for (let i = 1; i < dates.length; i++) {
                expect(dates[i - 1]).toBeGreaterThanOrEqual(dates[i]);
            }
        });
    });

});
