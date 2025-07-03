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

describe("POST /api/entries", () => {

    describe("User vs Server error distinction", () => {
        it("correctly returns 400 for validation errors", async () => {
            const { app } = await makeTestApp();

            // Test various user error scenarios
            const userErrorTests = [
                { rawInput: "", expectedContains: "Missing required field" },
                { rawInput: "123invalid", expectedContains: "Bad structure" },
                { rawInput: "work [invalid [nested] brackets]", expectedContains: "Not a valid modifier" }
            ];

            for (const test of userErrorTests) {
                const res = await request(app)
                    .post("/api/entries")
                    .send({ rawInput: test.rawInput })
                    .set("Content-Type", "application/json");

                expect(res.statusCode).toBe(400);
                expect(res.body.error).toContain(test.expectedContains);
            }
        });

        it("returns proper error structure for validation failures", async () => {
            const { app } = await makeTestApp();

            const res = await request(app)
                .post("/api/entries")
                .send({ rawInput: "123invalid" })
                .set("Content-Type", "application/json");

            expect(res.statusCode).toBe(400);
            expect(res.body).toHaveProperty("error");
            expect(res.body.error).toContain("Bad structure of input");
            expect(res.body).not.toHaveProperty("success");
        });
    });

    describe("Edge cases and boundary conditions", () => {
        it("handles very long valid input", async () => {
            const { app } = await makeTestApp();

            // Create a very long but valid description
            const longDescription = "A".repeat(1000);
            const requestBody = {
                rawInput: `work [loc office] ${longDescription}`,
            };

            const res = await request(app)
                .post("/api/entries")
                .send(requestBody)
                .set("Content-Type", "application/json");

            expect(res.statusCode).toBe(201);
            expect(res.body.success).toBe(true);
            expect(res.body.entry.description).toBe(longDescription);
        });

        it("handles special characters in descriptions", async () => {
            const { app } = await makeTestApp();

            const specialChars = "Special chars: @#$%^&*()_+-={}[]|\\:;\"'<>,.?/~`";
            const requestBody = {
                rawInput: `work [loc office] ${specialChars}`,
            };

            const res = await request(app)
                .post("/api/entries")
                .send(requestBody)
                .set("Content-Type", "application/json");

            expect(res.statusCode).toBe(201);
            expect(res.body.success).toBe(true);
            expect(res.body.entry.description).toBe(specialChars);
        });

        it("handles unicode characters", async () => {
            const { app } = await makeTestApp();

            const unicode = "测试 🚀 Ñoño café résumé";
            const requestBody = {
                rawInput: `work [loc home] ${unicode}`,
            };

            const res = await request(app)
                .post("/api/entries")
                .send(requestBody)
                .set("Content-Type", "application/json");

            expect(res.statusCode).toBe(201);
            expect(res.body.success).toBe(true);
            expect(res.body.entry.description).toBe(unicode);
        });

        it("returns 400 for null rawInput", async () => {
            const { app } = await makeTestApp();

            const requestBody = {
                rawInput: null,
            };
            const res = await request(app)
                .post("/api/entries")
                .send(requestBody)
                .set("Content-Type", "application/json");

            expect(res.statusCode).toBe(400);
            expect(res.body.error).toContain("Missing required field: rawInput");
        });

        it("returns 400 for numeric rawInput", async () => {
            const { app } = await makeTestApp();

            const requestBody = {
                rawInput: 12345,
            };
            const res = await request(app)
                .post("/api/entries")
                .send(requestBody)
                .set("Content-Type", "application/json");

            expect(res.statusCode).toBe(400);
            expect(res.body.error).toContain("Missing required field: rawInput");
        });

        it("allows entries with only type (no description)", async () => {
            const { app } = await makeTestApp();

            const requestBody = {
                rawInput: "work", // Just type, no description - should now be valid
            };

            const res = await request(app)
                .post("/api/entries")
                .send(requestBody)
                .set("Content-Type", "application/json");

            expect(res.statusCode).toBe(201);
            expect(res.body.success).toBe(true);
            expect(res.body.entry.type).toBe("work");
            expect(res.body.entry.description).toBe("");
            expect(res.body.entry.modifiers).toEqual({});
        });

        it("allows entries with empty descriptions after type", async () => {
            const { app } = await makeTestApp();

            const requestBody = {
                rawInput: "work ", // Type with space but no description
            };

            const res = await request(app)
                .post("/api/entries")
                .send(requestBody)
                .set("Content-Type", "application/json");

            expect(res.statusCode).toBe(201);
            expect(res.body.success).toBe(true);
            expect(res.body.entry.type).toBe("work");
            expect(res.body.entry.description).toBe("");
            expect(res.body.entry.modifiers).toEqual({});
        });

        it("allows entries with only modifiers and empty description", async () => {
            const { app } = await makeTestApp();

            const requestBody = {
                rawInput: "work [loc office]", // Type and modifier but no description
            };

            const res = await request(app)
                .post("/api/entries")
                .send(requestBody)
                .set("Content-Type", "application/json");

            expect(res.statusCode).toBe(201);
            expect(res.body.success).toBe(true);
            expect(res.body.entry.type).toBe("work");
            expect(res.body.entry.description).toBe("");
            expect(res.body.entry.modifiers).toEqual({ loc: "office" });
        });
    });
});
