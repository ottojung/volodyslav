const request = require("supertest");
const { makeTestApp } = require("./api_ordering_test_setup");
const fs = require("fs");
const path = require("path");

describe("POST /api/entries - rawInput transformation and shortcuts", () => {
    it("works without shortcuts when config file doesn't exist", async () => {
        const { app, capabilities } = await makeTestApp();
        const fixedTime = new Date("2025-05-23T12:00:00.000Z").getTime();
        capabilities.datetime.now.mockReturnValue(fixedTime);

        const requestBody = {
            rawInput: "WORK [loc office] - No shortcuts here",
        };

        const res = await request(app)
            .post("/api/entries")
            .send(requestBody)
            .set("Content-Type", "application/json");

        expect(res.statusCode).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.entry).toMatchObject({
            type: "WORK",
            description: "- No shortcuts here",
            modifiers: { loc: "office" },
            input: "WORK [loc office] - No shortcuts here",
            original: "WORK [loc office] - No shortcuts here"
        });
    });

    it("works with empty shortcuts config", async () => {
        const { app, capabilities } = await makeTestApp();
        const fixedTime = new Date("2025-05-23T12:00:00.000Z").getTime();
        capabilities.datetime.now.mockReturnValue(fixedTime);

        // Create config with empty shortcuts using transaction system
        const { transaction } = require("../src/event_log_storage/transaction");
        await transaction(capabilities, async (storage) => {
            storage.setConfig({
                help: "test config",
                shortcuts: []
            });
        });

        const requestBody = {
            rawInput: "EXERCISE [loc gym] - Weightlifting session",
        };

        const res = await request(app)
            .post("/api/entries")
            .send(requestBody)
            .set("Content-Type", "application/json");

        expect(res.statusCode).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.entry).toMatchObject({
            type: "EXERCISE",
            description: "- Weightlifting session",
            modifiers: { loc: "gym" },
            input: "EXERCISE [loc gym] - Weightlifting session",
            original: "EXERCISE [loc gym] - Weightlifting session"
        });
    });

    it("handles malformed config gracefully", async () => {
        const { app, capabilities } = await makeTestApp();
        const fixedTime = new Date("2025-05-23T12:00:00.000Z").getTime();
        capabilities.datetime.now.mockReturnValue(fixedTime);

        // Create malformed config
        const configPath = capabilities.environment.eventLogRepository() + "/config.json";
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, "invalid json content");

        const requestBody = {
            rawInput: "MEETING [with John] - Project discussion",
        };

        const res = await request(app)
            .post("/api/entries")
            .send(requestBody)
            .set("Content-Type", "application/json");

        expect(res.statusCode).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.entry).toMatchObject({
            type: "MEETING",
            description: "- Project discussion",
            modifiers: { with: "John" },
            input: "MEETING [with John] - Project discussion",
            original: "MEETING [with John] - Project discussion"
        });

        // Clean up
        fs.unlinkSync(configPath);
    });
    it("confirms no transformation when config file doesn't exist (expected behavior)", async () => {
        // This test verifies what happens when there's no config file - 
        // this is likely what's happening in your real application
        const { app, capabilities } = await makeTestApp();
        const fixedTime = new Date("2025-05-23T12:00:00.000Z").getTime();
        capabilities.datetime.now.mockReturnValue(fixedTime);

        // Ensure no config file exists
        const eventLogRepo = capabilities.environment.eventLogRepository();
        const configPath = eventLogRepo + "/config.json";
        
        // Make sure the directory exists but no config file
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        
        // Verify no config file exists
        if (fs.existsSync(configPath)) {
            fs.unlinkSync(configPath);
        }

        // Test with input that would be transformed if shortcuts existed
        const requestBody = { rawInput: "w [loc o] - Should not be transformed" };

        const res = await request(app)
            .post("/api/entries")
            .send(requestBody)
            .set("Content-Type", "application/json");

        expect(res.statusCode).toBe(201);
        expect(res.body.success).toBe(true);
        
        // Without config, no transformation should happen
        expect(res.body.entry.original).toBe("w [loc o] - Should not be transformed");
        expect(res.body.entry.input).toBe("w [loc o] - Should not be transformed"); // Same as original
        expect(res.body.entry.type).toBe("w"); // Not transformed

        // Test the config endpoint too
        const configRes = await request(app).get("/api/config");
        expect(configRes.statusCode).toBe(200);
        expect(configRes.body.config).toBeNull(); // No config file means null config
    });
});
