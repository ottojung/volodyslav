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
            const entries = [
                {
                    rawInput: "test - Oldest entry",
                    date: fromISOString("2023-01-01T10:00:00Z"),
                },
                {
                    rawInput: "test - Newest entry",
                    date: fromISOString("2023-01-03T10:00:00Z"),
                },
                {
                    rawInput: "test - Middle entry",
                    date: fromISOString("2023-01-02T10:00:00Z"),
                },
            ];

            capabilities.datetime.now.mockReturnValueOnce(entries[0].date);
            await request(app)
                .post("/api/entries")
                .send(entries[0])
                .set("Content-Type", "application/json");

            capabilities.datetime.now.mockReturnValueOnce(entries[1].date);
            await request(app)
                .post("/api/entries")
                .send(entries[1])
                .set("Content-Type", "application/json");

            capabilities.datetime.now.mockReturnValueOnce(entries[2].date);
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
                expect(dates[i - 1].isAfterOrEqual(dates[i])).toBe(true);
            }
        });
    });

    describe("Explicit Order Parameters", () => {
        it("supports dateDescending order parameter", async () => {
            const { app, capabilities } = await makeTestApp();

            // Create entries with different dates by controlling datetime.now()
            const entries = [
                {
                    rawInput: "test - First",
                    date: fromISOString("2023-01-01T10:00:00Z"),
                },
                {
                    rawInput: "test - Second",
                    date: fromISOString("2023-01-02T10:00:00Z"),
                },
            ];

            capabilities.datetime.now.mockReturnValueOnce(entries[0].date);
            await request(app)
                .post("/api/entries")
                .send(entries[0])
                .set("Content-Type", "application/json");

            capabilities.datetime.now.mockReturnValueOnce(entries[1].date);
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
                expect(previousDate.isAfterOrEqual(currentDate)).toBe(true);
            }
        });

        it("supports dateAscending order parameter", async () => {
            const { app, capabilities } = await makeTestApp();

            // Create entries with different dates by controlling datetime.now()
            const entries = [
                {
                    rawInput: "test - Second",
                    date: fromISOString("2023-01-02T10:00:00Z"),
                },
                {
                    rawInput: "test - First",
                    date: fromISOString("2023-01-01T10:00:00Z"),
                },
            ];

            capabilities.datetime.now.mockReturnValueOnce(entries[0].date);
            await request(app)
                .post("/api/entries")
                .send(entries[0])
                .set("Content-Type", "application/json");

            capabilities.datetime.now.mockReturnValueOnce(entries[1].date);
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
                expect(currentDate.isAfterOrEqual(previousDate)).toBe(true);
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
            const dates = res.body.results.map(entry => fromISOString(entry.date));
            for (let i = 1; i < dates.length; i++) {
                expect(dates[i - 1].isAfterOrEqual(dates[i])).toBe(true);
            }
        });
    });

});
