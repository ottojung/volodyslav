const path = require("path");
const fs = require("fs");
const request = require("supertest");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    return capabilities;
}

// Create a mock static file structure for testing
const staticPath = path.join(__dirname, "..", "..", "frontend", "dist");
const basePathFile = path.join(__dirname, "..", "..", "BASE_PATH");
const manifestPath = path.join(staticPath, "manifest.webmanifest");

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

async function makeAppFromModules(capabilities, expressApp, addRoutes) {
    const app = expressApp.make();
    capabilities.logger.enableHttpCallsLogging(app);
    await addRoutes(capabilities, app);
    return app;
}

async function makeApp(capabilities) {
    const expressApp = require("../src/express_app");
    const { addRoutes } = require("../src/server");
    return makeAppFromModules(capabilities, expressApp, addRoutes);
}

// Reload backend server modules only when a test changes BASE_PATH, because
// backend/src/base_path.js memoizes the first path it reads per module instance.
async function makeAppWithFreshModules(capabilities) {
    jest.resetModules();
    const expressApp = require("../src/express_app");
    const { addRoutes } = require("../src/server");
    return makeAppFromModules(capabilities, expressApp, addRoutes);
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

    it("serves manifest.webmanifest under a configured base path", async () => {
        fs.writeFileSync(basePathFile, "/volodyslav\n");
        fs.writeFileSync(manifestPath, JSON.stringify({ name: "Volodyslav" }));

        try {
            const capabilities = getTestCapabilities();
            const app = await makeAppWithFreshModules(capabilities);
            const res = await request(app).get("/volodyslav/manifest.webmanifest");

            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual({ name: "Volodyslav" });
            expect(res.headers["content-type"]).toMatch(
                /application\/manifest\+json|application\/json/
            );
        } finally {
            fs.rmSync(manifestPath, { force: true });
            fs.rmSync(basePathFile, { force: true });
        }
    });
});
