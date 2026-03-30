const request = require("supertest");
const { fromISOString } = require("../src/datetime");
const { makeTestApp } = require("./api_ordering_test_setup");

describe("POST /api/entries - rawInput transformation and shortcuts", () => {
    it("works without shortcuts when config file doesn't exist", async () => {
        const { app, capabilities } = await makeTestApp();
        const fixedTime = fromISOString("2025-05-23T12:00:00.000Z");
        capabilities.datetime.now.mockReturnValue(fixedTime);

        const requestBody = {
            rawInput: "WORK [loc office] - No shortcuts here",
            clientTimezone: "UTC",
        };

        const res = await request(app)
            .post("/api/entries")
            .send(requestBody)
            .set("Content-Type", "application/json");

        expect(res.statusCode).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.entry).toMatchObject({
            input: "WORK [loc office] - No shortcuts here",
            original: "WORK [loc office] - No shortcuts here"
        });
    });

    it("works with empty shortcuts config", async () => {
        const { app, capabilities } = await makeTestApp();
        const fixedTime = fromISOString("2025-05-23T12:00:00.000Z");
        capabilities.datetime.now.mockReturnValue(fixedTime);

        // Create config with empty shortcuts using transaction system
        const { transaction } = require("../src/event_log_storage");
        await transaction(capabilities, async (storage) => {
            storage.setConfig({
                help: "test config",
                shortcuts: []
            });
        });

        const requestBody = {
            rawInput: "EXERCISE [loc gym] - Weightlifting session",
            clientTimezone: "UTC",
        };

        const res = await request(app)
            .post("/api/entries")
            .send(requestBody)
            .set("Content-Type", "application/json");

        expect(res.statusCode).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.entry).toMatchObject({
            input: "EXERCISE [loc gym] - Weightlifting session",
            original: "EXERCISE [loc gym] - Weightlifting session"
        });
    });

    it("does not transform input when graph config is cleared", async () => {
        const { app, capabilities } = await makeTestApp();
        const fixedTime = fromISOString("2025-05-23T12:00:00.000Z");
        capabilities.datetime.now.mockReturnValue(fixedTime);

        await capabilities.interface.setConfig(null);

        const requestBody = {
            rawInput: "MEETING [with John] - Project discussion",
            clientTimezone: "UTC",
        };

        const res = await request(app)
            .post("/api/entries")
            .send(requestBody)
            .set("Content-Type", "application/json");

        expect(res.statusCode).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.entry).toMatchObject({
            input: "MEETING [with John] - Project discussion",
            original: "MEETING [with John] - Project discussion"
        });
    });
    it("confirms no transformation when graph config doesn't exist", async () => {
        const { app, capabilities } = await makeTestApp();
        const fixedTime = fromISOString("2025-05-23T12:00:00.000Z");
        capabilities.datetime.now.mockReturnValue(fixedTime);

        await capabilities.interface.setConfig(null);

        const requestBody = { rawInput: "w [loc o] - Should not be transformed", clientTimezone: "UTC" };

        const res = await request(app)
            .post("/api/entries")
            .send(requestBody)
            .set("Content-Type", "application/json");

        expect(res.statusCode).toBe(201);
        expect(res.body.success).toBe(true);
        
        expect(res.body.entry.original).toBe("w [loc o] - Should not be transformed");
        expect(res.body.entry.input).toBe("w [loc o] - Should not be transformed");

        const configRes = await request(app).get("/api/config");
        expect(configRes.statusCode).toBe(200);
        expect(configRes.body.config).toBeNull();
    });
});
