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

/**
 * Builds a test app from caller-provided module instances.
 * Passing the modules in keeps the normal and reloaded code paths aligned.
 * @param {ReturnType<typeof getTestCapabilities>} capabilities
 * @param {typeof import("../src/express_app")} expressApp
 * @param {typeof import("../src/server").addRoutes} addRoutes
 * @returns {Promise<import("express").Express>}
 */
async function makeAppFromModules(capabilities, expressApp, addRoutes) {
    const app = expressApp.make();
    capabilities.logger.enableHttpCallsLogging(app);
    await addRoutes(capabilities, app);
    return app;
}

/**
 * Builds a test app using the existing module cache.
 * @param {ReturnType<typeof getTestCapabilities>} capabilities
 * @returns {Promise<import("express").Express>}
 */
async function makeApp(capabilities) {
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
        expect(res.headers["content-type"]).toMatch(/text\/javascript/);

        // Clean up
        fs.unlinkSync(path.join(staticPath, "test.js"));
    });
});

describe("SPA fallback with dot-directory static root", () => {
    const dotDirPath = path.join(
        __dirname,
        "..",
        "tmp",
        ".local",
        "share",
        "volodyslav",
        "frontend",
        "dist"
    );

    beforeAll(() => {
        fs.mkdirSync(dotDirPath, { recursive: true });
        fs.writeFileSync(
            path.join(dotDirPath, "index.html"),
            "<html><body>DotDir</body></html>"
        );
        fs.writeFileSync(path.join(dotDirPath, "asset.txt"), "asset content");
    });

    afterAll(() => {
        fs.rmSync(path.join(__dirname, "..", "tmp"), {
            recursive: true,
            force: true,
        });
    });

    it("serves index.html for root path", async () => {
        const capabilities = getTestCapabilities();
        const expressApp = require("../src/express_app");
        const { makeRouter } = require("../src/routes/static");

        const app = expressApp.make();
        app.use("/", makeRouter(capabilities, dotDirPath));

        const res = await request(app).get("/");
        expect(res.statusCode).toBe(200);
        expect(res.text).toContain("<html>");
        expect(res.headers["content-type"]).toMatch(/text\/html/);
    });

    it("serves index.html for unknown routes (SPA fallback)", async () => {
        const capabilities = getTestCapabilities();
        const expressApp = require("../src/express_app");
        const { makeRouter } = require("../src/routes/static");

        const app = expressApp.make();
        app.use("/", makeRouter(capabilities, dotDirPath));

        const res = await request(app).get("/describe");
        expect(res.statusCode).toBe(200);
        expect(res.text).toContain("DotDir");
        expect(res.headers["content-type"]).toMatch(/text\/html/);
    });

    it("serves index.html for another unknown route", async () => {
        const capabilities = getTestCapabilities();
        const expressApp = require("../src/express_app");
        const { makeRouter } = require("../src/routes/static");

        const app = expressApp.make();
        app.use("/", makeRouter(capabilities, dotDirPath));

        const res = await request(app).get("/unknown-route");
        expect(res.statusCode).toBe(200);
        expect(res.text).toContain("DotDir");
        expect(res.headers["content-type"]).toMatch(/text\/html/);
    });

    it("serves static asset file inside dot-directory path", async () => {
        const capabilities = getTestCapabilities();
        const expressApp = require("../src/express_app");
        const { makeRouter } = require("../src/routes/static");

        const app = expressApp.make();
        app.use("/", makeRouter(capabilities, dotDirPath));

        const res = await request(app).get("/asset.txt");
        expect(res.statusCode).toBe(200);
        expect(res.text).toBe("asset content");
    });

    it("does not serve index.html for non-GET requests", async () => {
        const capabilities = getTestCapabilities();
        const expressApp = require("../src/express_app");
        const { makeRouter } = require("../src/routes/static");

        const app = expressApp.make();
        app.use("/", makeRouter(capabilities, dotDirPath));

        const res = await request(app).post("/describe");
        expect(res.statusCode).toBe(404);
    });
});
