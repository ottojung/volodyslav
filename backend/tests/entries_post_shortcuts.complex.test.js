const request = require("supertest");
const { makeTestApp } = require("./api_ordering_test_setup");

describe("POST /api/entries - rawInput transformation and shortcuts", () => {
    it("demonstrates complex multi-step transformation workflow", async () => {
        // Test a real-world scenario with multiple recursive transformations
        const { app, capabilities } = await makeTestApp();
        const fixedTime = new Date("2025-05-23T12:00:00.000Z").getTime();
        capabilities.datetime.now.mockReturnValue(fixedTime);

        // Create complex config with shorthand expansions using transaction system
        const { transaction } = require("../src/event_log_storage");
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
        const { transaction } = require("../src/event_log_storage");
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
