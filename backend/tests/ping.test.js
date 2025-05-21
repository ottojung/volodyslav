const request = require("supertest");
const expressApp = require("../src/express_app");
const { addRoutes } = require("../src/server");
const { getMockedRootCapabilities, stubEnvironment, stubLogger } = require("./mocked");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    return capabilities;
}

async function makeApp(capabilities) {
    const app = expressApp.make();
    capabilities.logger.enableHttpCallsLogging(app);
    await addRoutes(capabilities, app);
    return app;
}

describe("GET /api/ping", () => {
    it("responds with pong", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);
        const res = await request(app).get("/api/ping");
        expect(res.statusCode).toBe(200);
        expect(res.text).toBe("pong");
    });

    it("returns text/html content type", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);
        const res = await request(app).get("/api/ping");
        expect(res.headers["content-type"]).toMatch(/text\/html/);
    });

    it("handles HEAD request", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);
        const res = await request(app).head("/api/ping");
        expect(res.statusCode).toBe(200);
    });

    it("rejects POST requests", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);
        const res = await request(app).post("/api/ping");
        expect(res.statusCode).toBe(404);
    });

    it("rejects PUT requests", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);
        const res = await request(app).put("/api/ping");
        expect(res.statusCode).toBe(404);
    });

    it("rejects DELETE requests", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);
        const res = await request(app).delete("/api/ping");
        expect(res.statusCode).toBe(404);
    });

    it("returns 200 when runtime_identifier matches", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);
        const { instanceIdentifier } =
            await require("../src/runtime_identifier")(capabilities);
        const correctId = instanceIdentifier;
        const res = await request(app).get(
            `/api/ping?runtime_identifier=${correctId}`
        );
        expect(res.statusCode).toBe(200);
        expect(res.text).toBe("pong");
    });

    it("returns 400 when runtime_identifier is empty", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);
        const res = await request(app).get("/api/ping?runtime_identifier=");
        expect(res.statusCode).toBe(400);
    });

    it("returns 400 when runtime_identifier does not match", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);
        const res = await request(app).get(
            "/api/ping?runtime_identifier=wrong-id"
        );
        expect(res.statusCode).toBe(400);
    });
});
