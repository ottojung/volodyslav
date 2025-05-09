const path = require("path");
const fs = require("fs");

// Mock environment exports to avoid real env dependencies
jest.mock("../src/environment", () => {
    const path = require("path");
    return {
        openaiAPIKey: jest.fn().mockReturnValue("test-key"),
        resultsDirectory: jest
            .fn()
            .mockReturnValue(path.join(__dirname, "tmp")),
        myServerPort: jest.fn().mockReturnValue(0),
        logLevel: jest.fn().mockReturnValue("silent"),
    };
});

const request = require("supertest");
const expressApp = require("../src/express_app");

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

describe("Static file serving", () => {
    it("serves index.html for root path", async () => {
        const res = await request(expressApp.make()).get("/");
        expect(res.statusCode).toBe(200);
        expect(res.text).toContain("<html>");
        expect(res.headers["content-type"]).toMatch(/text\/html/);
    });

    it("serves index.html for unknown routes (SPA fallback)", async () => {
        const res = await request(expressApp.make()).get("/unknown-route");
        expect(res.statusCode).toBe(200);
        expect(res.text).toContain("<html>");
        expect(res.headers["content-type"]).toMatch(/text\/html/);
    });

    it("serves static files correctly", async () => {
        const res = await request(expressApp.make()).get("/test.txt");
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

        const res = await request(expressApp.make()).get("/test.js");
        expect(res.statusCode).toBe(200);
        expect(res.headers["content-type"]).toMatch(/application\/javascript/);

        // Clean up
        fs.unlinkSync(path.join(staticPath, "test.js"));
    });
});
