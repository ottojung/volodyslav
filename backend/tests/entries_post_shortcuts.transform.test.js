const request = require("supertest");
const { makeTestApp } = require("./api_ordering_test_setup");

describe("POST /api/entries - rawInput transformation and shortcuts", () => {
    it("applies shortcuts from config when creating entries", async () => {
        // Equivalent curl command:
        // curl -X POST http://localhost:PORT/api/entries \
        //   -H "Content-Type: application/json" \
        //   -d '{"rawInput":"w [loc o] - Fixed the parser"}'

        const { app, capabilities } = await makeTestApp();
        const fixedTime = new Date("2025-05-23T12:00:00.000Z").getTime();
        capabilities.datetime.now.mockReturnValue(fixedTime);

        // Create a config with shortcuts using transaction system
        const { transaction } = require("../src/event_log_storage");
        await transaction(capabilities, async (storage) => {
            storage.setConfig({
                help: "test config",
                shortcuts: [
                    {pattern: "\\bw\\b", replacement: "WORK"},
                    {pattern: "\\bo\\b", replacement: "office"}
                ]
            });
        });

        const requestBody = {
            rawInput: "w [loc o] - Fixed the parser",
        };

        const res = await request(app)
            .post("/api/entries")
            .send(requestBody)
            .set("Content-Type", "application/json");

        expect(res.statusCode).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.entry).toMatchObject({
            type: "WORK",
            description: "- Fixed the parser",
            modifiers: { loc: "office" },
            input: "WORK [loc office] - Fixed the parser",
            original: "w [loc o] - Fixed the parser"
        });
    });

    it("applies recursive shortcuts correctly", async () => {
        const { app, capabilities } = await makeTestApp();
        const fixedTime = new Date("2025-05-23T12:00:00.000Z").getTime();
        capabilities.datetime.now.mockReturnValue(fixedTime);

        // Create config with recursive shortcuts using transaction system
        const { transaction } = require("../src/event_log_storage");
        await transaction(capabilities, async (storage) => {
            storage.setConfig({
                help: "test config",
                shortcuts: [
                    {pattern: "\\bw\\b", replacement: "WORK"},
                    {pattern: "\\bo\\b", replacement: "office"},
                    {pattern: "\\bwo\\b", replacement: "w [loc o]"}
                ]
            });
        });

        const requestBody = {
            rawInput: "wo - Fixed bug",
        };

        const res = await request(app)
            .post("/api/entries")
            .send(requestBody)
            .set("Content-Type", "application/json");

        expect(res.statusCode).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.entry).toMatchObject({
            type: "WORK",
            description: "- Fixed bug",
            modifiers: { loc: "office" },
            input: "WORK [loc office] - Fixed bug",
            original: "wo - Fixed bug"
        });
    });

    it("preserves word boundaries in shortcuts", async () => {
        const { app, capabilities } = await makeTestApp();
        const fixedTime = new Date("2025-05-23T12:00:00.000Z").getTime();
        capabilities.datetime.now.mockReturnValue(fixedTime);

        // Create config with word boundary shortcuts using transaction system
        const { transaction } = require("../src/event_log_storage");
        await transaction(capabilities, async (storage) => {
            storage.setConfig({
                help: "test config",
                shortcuts: [
                    {pattern: "\\bw\\b", replacement: "WORK"}
                ]
            });
        });

        const requestBody = {
            rawInput: "working on project", // Should NOT be transformed to "WORKing"
        };

        const res = await request(app)
            .post("/api/entries")
            .send(requestBody)
            .set("Content-Type", "application/json");

        expect(res.statusCode).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.entry).toMatchObject({
            type: "working",
            description: "on project",
            modifiers: {},
            input: "working on project",
            original: "working on project"
        });
    });

    it("applies shortcuts to modifiers as well as type", async () => {
        const { app, capabilities } = await makeTestApp();
        const fixedTime = new Date("2025-05-23T12:00:00.000Z").getTime();
        capabilities.datetime.now.mockReturnValue(fixedTime);

        // Create config with shortcuts for locations using transaction system
        const { transaction } = require("../src/event_log_storage");
        await transaction(capabilities, async (storage) => {
            storage.setConfig({
                help: "test config",
                shortcuts: [
                    {pattern: "\\bm\\b", replacement: "MEETING"},
                    {pattern: "\\bhq\\b", replacement: "headquarters"},
                    {pattern: "\\bj\\b", replacement: "John Smith"}
                ]
            });
        });

        const requestBody = {
            rawInput: "m [loc hq] [with j] - Weekly standup",
        };

        const res = await request(app)
            .post("/api/entries")
            .send(requestBody)
            .set("Content-Type", "application/json");

        expect(res.statusCode).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.entry).toMatchObject({
            type: "MEETING",
            description: "- Weekly standup",
            modifiers: {
                loc: "headquarters",
                with: "John Smith"
            },
            input: "MEETING [loc headquarters] [with John Smith] - Weekly standup",
            original: "m [loc hq] [with j] - Weekly standup"
        });
    });

    it("normalizes whitespace during transformation", async () => {
        const { app, capabilities } = await makeTestApp();
        const fixedTime = new Date("2025-05-23T12:00:00.000Z").getTime();
        capabilities.datetime.now.mockReturnValue(fixedTime);

        const requestBody = {
            rawInput: "    WORK   [loc    office]    -    Description with  extra   spaces  ",
        };

        const res = await request(app)
            .post("/api/entries")
            .send(requestBody)
            .set("Content-Type", "application/json");

        expect(res.statusCode).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.entry).toMatchObject({
            type: "WORK",
            description: "- Description with extra spaces",
            modifiers: { loc: "office" },
            input: "WORK [loc office] - Description with extra spaces",
            original: "    WORK   [loc    office]    -    Description with  extra   spaces  "
        });
    });

    it("returns correct error for invalid input after transformation", async () => {
        const { app, capabilities } = await makeTestApp();

        // Create config that could potentially create invalid input using transaction system
        const { transaction } = require("../src/event_log_storage");
        await transaction(capabilities, async (storage) => {
            storage.setConfig({
                help: "test config",
                shortcuts: [
                    {pattern: "badtype", replacement: "123invalid"} // Creates invalid type name
                ]
            });
        });

        const requestBody = {
            rawInput: "badtype - Description",
        };

        const res = await request(app)
            .post("/api/entries")
            .send(requestBody)
            .set("Content-Type", "application/json");

        expect(res.statusCode).toBe(400);
        expect(res.body.error).toContain("Bad structure of input");
    });

});
