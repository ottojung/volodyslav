const path = require("path");
const fs = require("fs");
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

// Create a mock static file structure for testing
const staticPath = path.join(__dirname, "..", "..", "frontend", "dist");

beforeAll(() => {
    // Create mock dist directory and files
    fs.mkdirSync(staticPath, { recursive: true });
    fs.writeFileSync(
        path.join(staticPath, "index.html"),
        "<html><body>Test</body></html>"
    );
    fs.writeFileSync(path.join(staticPath, "test.txt"), "test content");
});

afterAll(() => {
    // Clean up mock files
    fs.rmSync(staticPath, { recursive: true, force: true });
});

async function makeApp(capabilities) {
    const app = expressApp.make();
    capabilities.logger.enableHttpCallsLogging(app);
    await addRoutes(capabilities, app);
    return app;
}

describe("Static file serving", () => {
    it("serves index.html for root path", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);
        const res = await request(app).get("/");
        expect(res.statusCode).toBe(200);
        expect(res.text).toContain("<html>");
        expect(res.headers["content-type"]).toMatch(/text\/html/);
    });

    it("serves index.html for unknown routes (SPA fallback)", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);
        const res = await request(app).get("/unknown-route");
        expect(res.statusCode).toBe(200);
        expect(res.text).toContain("<html>");
        expect(res.headers["content-type"]).toMatch(/text\/html/);
    });

    it("serves static files correctly", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);
        const res = await request(app).get("/test.txt");
        expect(res.statusCode).toBe(200);
        expect(res.text).toBe("test content");
        expect(res.headers["content-type"]).toMatch(/text\/plain/);
    });

    it("preserves Content-Type for different file types", async () => {
        const capabilities = getTestCapabilities();

        // Create a test.js file
        fs.writeFileSync(
            path.join(staticPath, "test.js"),
            'console.log("test");'
        );

        const app = await makeApp(capabilities);
        const res = await request(app).get("/test.js");
        expect(res.statusCode).toBe(200);
        expect(res.headers["content-type"]).toMatch(/application\/javascript/);

        // Clean up
        fs.unlinkSync(path.join(staticPath, "test.js"));
    });
});
