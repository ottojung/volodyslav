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
const { transaction } = require("../src/event_log_storage/transaction");

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

describe("GET /api/config", () => {
    it("returns null when no config exists", async () => {
        // Equivalent curl command:
        // curl -X GET http://localhost:PORT/api/config

        const { app } = await makeTestApp();
        const res = await request(app).get("/api/config");

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            config: null,
        });
    });

    it("returns serialized config when config exists", async () => {
        // Equivalent curl command:
        // curl -X GET http://localhost:PORT/api/config

        const { app, capabilities } = await makeTestApp();

        // First, create a config
        const testConfig = {
            help: "Test configuration for API",
            shortcuts: [
                {
                    pattern: "api",
                    replacement: "Application Programming Interface",
                    description: "API shortcut",
                },
                {
                    pattern: "http",
                    replacement: "HyperText Transfer Protocol",
                },
            ],
        };

        await transaction(capabilities, async (storage) => {
            storage.setConfig(testConfig);
        });

        // Now test the GET endpoint
        const res = await request(app).get("/api/config");

        expect(res.statusCode).toBe(200);
        expect(res.body.config).toEqual({
            help: "Test configuration for API",
            shortcuts: [
                [
                    "api",
                    "Application Programming Interface",
                    "API shortcut",
                ],
                [
                    "http",
                    "HyperText Transfer Protocol",
                ],
            ],
        });
    });
});
