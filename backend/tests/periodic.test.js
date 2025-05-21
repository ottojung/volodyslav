const request = require("supertest");
const express = require("express");
const periodicRouter = require("../src/routes/periodic");
const { stubEnvironment, stubLogger, stubEventLogRepository } = require("./stubs");
const { getMockedRootCapabilities } = require("./mocks");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    return capabilities;
}

// Helper to create app with logging and periodic route mounted at /api
function makeApp(capabilities) {
    const app = express();
    capabilities.logger.enableHttpCallsLogging(app);
    app.use("/api", periodicRouter.makeRouter(capabilities));
    return app;
}

describe("GET /api/periodic", () => {
    it("returns 400 when no period is specified", async () => {
        const capabilities = getTestCapabilities();
        const app = makeApp(capabilities);
        const res = await request(app).get("/api/periodic");
        expect(res.statusCode).toBe(400);
        expect(res.text).toBe("Bad Request: period parameter is required");
    });

    it("rejects POST requests", async () => {
        const capabilities = getTestCapabilities();
        const app = makeApp(capabilities);
        const res = await request(app).post("/api/periodic");
        expect(res.statusCode).toBe(404);
    });

    it("responds with done for period=hour", async () => {
        const capabilities = getTestCapabilities();
        const app = makeApp(capabilities);
        await stubEventLogRepository(capabilities);
        const res = await request(app).get("/api/periodic?period=hour");
        expect(res.statusCode).toBe(200);
        expect(res.text).toBe("done");
    });

    it("responds with done for period=hourly", async () => {
        const capabilities = getTestCapabilities();
        const app = makeApp(capabilities);
        await stubEventLogRepository(capabilities);
        const res = await request(app).get("/api/periodic?period=hourly");
        expect(res.statusCode).toBe(200);
        expect(res.text).toBe("done");
    });

    it("returns 400 for empty period parameter", async () => {
        const capabilities = getTestCapabilities();
        const app = makeApp(capabilities);
        const res = await request(app).get("/api/periodic?period=");
        expect(res.statusCode).toBe(400);
        expect(res.text).toBe("Bad Request: period parameter is required");
    });

    it("returns 400 for unknown period", async () => {
        const capabilities = getTestCapabilities();
        const app = makeApp(capabilities);
        const res = await request(app).get("/api/periodic?period=daily");
        expect(res.statusCode).toBe(400);
        expect(res.text).toBe("Bad Request: unknown period");
    });
});
