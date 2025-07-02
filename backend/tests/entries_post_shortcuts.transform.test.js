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
        const { transaction } = require("../src/event_log_storage/transaction");
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
        const { transaction } = require("../src/event_log_storage/transaction");
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
        const { transaction } = require("../src/event_log_storage/transaction");
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
        const { transaction } = require("../src/event_log_storage/transaction");
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
        const { transaction } = require("../src/event_log_storage/transaction");
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

    it("demonstrates complex multi-step transformation workflow", async () => {
        // Test a real-world scenario with multiple recursive transformations
        const { app, capabilities } = await makeTestApp();
        const fixedTime = new Date("2025-05-23T12:00:00.000Z").getTime();
        capabilities.datetime.now.mockReturnValue(fixedTime);

        // Create complex config with shorthand expansions using transaction system
        const { transaction } = require("../src/event_log_storage/transaction");
        await transaction(capabilities, async (storage) => {
            storage.setConfig({
                help: "Complex shortcuts test config",
                shortcuts: [
                    // Basic shortcuts
                    {pattern: "\\bw\\b", replacement: "WORK"},
                    {pattern: "\\bm\\b", replacement: "MEETING"},
                    {pattern: "\\be\\b", replacement: "EXERCISE"},

                    // Location shortcuts  
                    {pattern: "\\bhome\\b", replacement: "house"},
                    {pattern: "\\boff\\b", replacement: "office"},
                    {pattern: "\\bgym\\b", replacement: "fitness center"},

                    // Person shortcuts
                    {pattern: "\\bboss\\b", replacement: "manager Sarah"},
                    {pattern: "\\bteam\\b", replacement: "development team"},

                    // Compound shortcuts (these expand to use other shortcuts)
                    {pattern: "\\bwh\\b", replacement: "w [loc home]"},
                    {pattern: "\\bwo\\b", replacement: "w [loc off]"},
                    {pattern: "\\bmb\\b", replacement: "m [with boss]"},
                    {pattern: "\\bmt\\b", replacement: "m [with team]"},
                    {pattern: "\\beg\\b", replacement: "e [loc gym]"}
                ]
            });
        });

        const testCases = [
            {
                rawInput: "wh - Working from home today",
                expected: {
                    type: "WORK",
                    description: "- Working from house today", // "home" gets transformed to "house" 
                    modifiers: { loc: "house" },
                    input: "WORK [loc house] - Working from house today",
                    original: "wh - Working from home today"
                }
            },
            {
                rawInput: "mb [duration 2h] - Project review",
                expected: {
                    type: "MEETING",
                    description: "- Project review",
                    modifiers: { with: "manager Sarah", duration: "2h" },
                    input: "MEETING [with manager Sarah] [duration 2h] - Project review",
                    original: "mb [duration 2h] - Project review"
                }
            },
            {
                rawInput: "eg [duration 45min] - Cardio workout",
                expected: {
                    type: "EXERCISE",
                    description: "- Cardio workout",
                    modifiers: { loc: "fitness center", duration: "45min" },
                    input: "EXERCISE [loc fitness center] [duration 45min] - Cardio workout",
                    original: "eg [duration 45min] - Cardio workout"
                }
            }
        ];

        for (const testCase of testCases) {
            const res = await request(app)
                .post("/api/entries")
                .send({ rawInput: testCase.rawInput })
                .set("Content-Type", "application/json");

            expect(res.statusCode).toBe(201);
            expect(res.body.success).toBe(true);
            expect(res.body.entry).toMatchObject(testCase.expected);
        }
    });

    it("verifies end-to-end transformation with real application setup", async () => {
        // This test simulates the real application environment to check if transformations work
        const { app, capabilities } = await makeTestApp();
        const fixedTime = new Date("2025-05-23T12:00:00.000Z").getTime();
        capabilities.datetime.now.mockReturnValue(fixedTime);

        // Create a config with a simple shortcut using transaction system
        const { transaction } = require("../src/event_log_storage/transaction");
        await transaction(capabilities, async (storage) => {
            storage.setConfig({
                help: "End-to-end test config",
                shortcuts: [
                    {pattern: "\\btest\\b", replacement: "TRANSFORMED"}
                ]
            });
        });

        // Test the transformation
        const requestBody = { rawInput: "test - This should be transformed" };

        const res = await request(app)
            .post("/api/entries")
            .send(requestBody)
            .set("Content-Type", "application/json");

        expect(res.statusCode).toBe(201);
        expect(res.body.success).toBe(true);
        
        // Verify the transformation worked
        expect(res.body.entry.original).toBe("test - This should be transformed");
        expect(res.body.entry.input).toBe("TRANSFORMED - This should be transformed");
        expect(res.body.entry.type).toBe("TRANSFORMED");
    });

});
