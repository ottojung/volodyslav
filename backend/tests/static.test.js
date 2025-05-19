const path = require("path");
const fs = require("fs");

// Mock environment exports to avoid real env dependencies
jest.mock('../src/environment', () => {
    const path = require('path');
    const temporary = require('./temporary');
    return {
        openaiAPIKey: jest.fn().mockReturnValue('test-key'),
        workingDirectory: jest.fn().mockImplementation(() => {
            return path.join(temporary.output(), 'results');
        }),
        myServerPort: jest.fn().mockReturnValue(0),
        logLevel: jest.fn().mockReturnValue("silent"),
        logFile: jest.fn().mockImplementation(() => {
            return path.join(temporary.output(), 'log.txt');
        }),
    };
});

const request = require("supertest");
const expressApp = require("../src/express_app");
const { addRoutes } = require("../src/server");
const logger = require("../src/logger");

// Create a mock static file structure for testing
const staticPath = path.join(__dirname, "..", "..", "frontend", "dist");

const { getMockedRootCapabilities } = require('./mockCapabilities');
const capabilities = getMockedRootCapabilities();

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

async function makeApp() {
    const app = expressApp.make();
    logger.enableHttpCallsLogging(app);
    await addRoutes(capabilities, app);
    return app;
}

describe("Static file serving", () => {
    it("serves index.html for root path", async () => {
        await logger.setup();    
        const app = await makeApp();
        const res = await request(app).get("/");
        expect(res.statusCode).toBe(200);
        expect(res.text).toContain("<html>");
        expect(res.headers["content-type"]).toMatch(/text\/html/);
    });

    it("serves index.html for unknown routes (SPA fallback)", async () => {
        await logger.setup();
        const app = await makeApp();
        const res = await request(app).get("/unknown-route");
        expect(res.statusCode).toBe(200);
        expect(res.text).toContain("<html>");
        expect(res.headers["content-type"]).toMatch(/text\/html/);
    });

    it("serves static files correctly", async () => {
        await logger.setup();
        const app = await makeApp();
        const res = await request(app).get("/test.txt");
        expect(res.statusCode).toBe(200);
        expect(res.text).toBe("test content");
        expect(res.headers["content-type"]).toMatch(/text\/plain/);
    });

    it("preserves Content-Type for different file types", async () => {
        // Create a test.js file
        fs.writeFileSync(
            path.join(staticPath, "test.js"),
            'console.log("test");'
        );

        const app = await makeApp();
        const res = await request(app).get("/test.js");
        expect(res.statusCode).toBe(200);
        expect(res.headers["content-type"]).toMatch(/application\/javascript/);

        // Clean up
        fs.unlinkSync(path.join(staticPath, "test.js"));
    });
});
