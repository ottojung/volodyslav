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

describe("PUT /api/config", () => {
    it("saves a valid config and returns it serialized", async () => {
        const { app } = await makeTestApp();

        const newConfig = {
            help: "Updated help text",
            shortcuts: [
                ["hello", "world", "Greeting shortcut"],
                ["foo", "bar"],
            ],
        };

        const res = await request(app)
            .put("/api/config")
            .send(newConfig)
            .set("Content-Type", "application/json");

        expect(res.statusCode).toBe(200);
        expect(res.body.config).toEqual({
            help: "Updated help text",
            shortcuts: [
                ["hello", "world", "Greeting shortcut"],
                ["foo", "bar"],
            ],
        });
    });

    it("persists the config so GET returns it afterward", async () => {
        const { app } = await makeTestApp();

        const newConfig = {
            help: "Persisted help",
            shortcuts: [["abc", "def"]],
        };

        await request(app)
            .put("/api/config")
            .send(newConfig)
            .set("Content-Type", "application/json");

        const getRes = await request(app).get("/api/config");

        expect(getRes.statusCode).toBe(200);
        expect(getRes.body.config).toEqual({
            help: "Persisted help",
            shortcuts: [["abc", "def"]],
        });
    });

    it("returns 400 for invalid config body", async () => {
        const { app } = await makeTestApp();

        const res = await request(app)
            .put("/api/config")
            .send({ notAConfig: true })
            .set("Content-Type", "application/json");

        expect(res.statusCode).toBe(400);
        expect(res.body).toHaveProperty("error");
    });

    it("returns 400 when shortcuts contain invalid entries", async () => {
        const { app } = await makeTestApp();

        const res = await request(app)
            .put("/api/config")
            .send({
                help: "test",
                shortcuts: ["not-an-array"],
            })
            .set("Content-Type", "application/json");

        expect(res.statusCode).toBe(400);
        expect(res.body).toHaveProperty("error");
    });

    it("returns 400 when a shortcut has an empty pattern", async () => {
        const { app } = await makeTestApp();

        const res = await request(app)
            .put("/api/config")
            .send({ help: "test", shortcuts: [["", "replacement"]] })
            .set("Content-Type", "application/json");

        expect(res.statusCode).toBe(400);
        expect(res.body.error).toMatch(/empty pattern/);
    });

    it("returns 400 when a shortcut pattern is an invalid regex", async () => {
        const { app } = await makeTestApp();

        const res = await request(app)
            .put("/api/config")
            .send({ help: "test", shortcuts: [["(", "replacement"]] })
            .set("Content-Type", "application/json");

        expect(res.statusCode).toBe(400);
        expect(res.body.error).toMatch(/invalid regex pattern/);
    });

    it("accepts shortcuts with valid regex patterns", async () => {
        const { app } = await makeTestApp();

        const res = await request(app)
            .put("/api/config")
            .send({
                help: "test",
                shortcuts: [
                    ["\\bbreakfast\\b", "food [when this morning]"],
                    ["slept (\\d+)h", "sleep [duration $1 hours]"],
                ],
            })
            .set("Content-Type", "application/json");

        expect(res.statusCode).toBe(200);
    });
});
