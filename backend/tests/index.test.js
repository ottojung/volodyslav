const request = require("supertest");
const expressApp = require("../src/express_app");
const { addRoutes } = require("../src/server");
const logger = require("../src/logger");
const { getMockedRootCapabilities, stubEnvironment } = require("./mocked");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    return capabilities;
}

describe("GET /api", () => {
    it("responds with Hello World!", async () => {
        const capabilities = getTestCapabilities();
        await logger.setup();
        const app = expressApp.make();
        await addRoutes(capabilities, app);
        const res = await request(app).get("/api");
        expect(res.statusCode).toBe(200);
        expect(res.text).toBe("Hello World!");
    });

    it("returns text/html content type", async () => {
        const capabilities = getTestCapabilities();
        const app = expressApp.make();
        await addRoutes(capabilities, app);
        const res = await request(app).get("/api");
        expect(res.headers["content-type"]).toMatch(/text\/html/);
    });

    it("handles HEAD request", async () => {
        const capabilities = getTestCapabilities();
        const app = expressApp.make();
        await addRoutes(capabilities, app);
        const res = await request(app).head("/api");
        expect(res.statusCode).toBe(200);
    });

    it("handles invalid HTTP method", async () => {
        const capabilities = getTestCapabilities();
        const app = expressApp.make();
        await addRoutes(capabilities, app);
        const res = await request(app).put("/api");
        expect(res.statusCode).toBe(404);
    });
});
