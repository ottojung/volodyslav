// Mock environment exports to avoid real env dependencies
jest.mock("../src/environment", () => {
    const path = require("path");
    const temporary = require("./temporary");
    return {
        openaiAPIKey: jest.fn().mockReturnValue("test-key"),
        resultsDirectory: jest
            .fn()
            .mockImplementation(() => path.join(temporary.output(), "results")),
        myServerPort: jest.fn().mockReturnValue(0),
        logLevel: jest.fn().mockReturnValue("silent"),
        logFile: jest
            .fn()
            .mockImplementation(() => path.join(temporary.output(), "log.txt")),
    };
});

// Mock diary processing and filesystem deleter
jest.mock("../src/diary", () => ({
    processDiaryAudios: jest.fn().mockResolvedValue(),
}));

jest.mock("../src/filesystem/deleter", () => ({
    make: jest.fn().mockReturnValue({ deleteFile: jest.fn() }),
}));

// Mock random generator
jest.mock("../src/random/seed", () => ({
    make: () => ({ generate: jest.fn().mockReturnValue(123) }),
}));

const request = require("supertest");
const express = require("express");
const periodicRouter = require("../src/routes/periodic");
const logger = require("../src/logger");

// Helper to create app with logging and periodic route mounted at /api
function makeApp() {
    const app = express();
    logger.enableHttpCallsLogging(app);
    app.use("/api", periodicRouter);
    return app;
}

describe("GET /api/periodic", () => {
    beforeAll(async () => {
        await logger.setup();
    });

    it("returns 400 when no period is specified", async () => {
        const app = makeApp();
        const res = await request(app).get("/api/periodic");
        expect(res.statusCode).toBe(400);
        expect(res.text).toBe("Bad Request: period parameter is required");
    });

    it("rejects POST requests", async () => {
        const app = makeApp();
        const res = await request(app).post("/api/periodic");
        expect(res.statusCode).toBe(404);
    });

    it("responds with done for period=hour", async () => {
        const app = makeApp();
        const res = await request(app).get("/api/periodic?period=hour");
        expect(res.statusCode).toBe(200);
        expect(res.text).toBe("done");
    });

    it("responds with done for period=hourly", async () => {
        const app = makeApp();
        const res = await request(app).get("/api/periodic?period=hourly");
        expect(res.statusCode).toBe(200);
        expect(res.text).toBe("done");
    });

    it("returns 400 for empty period parameter", async () => {
        const app = makeApp();
        const res = await request(app).get("/api/periodic?period=");
        expect(res.statusCode).toBe(400);
        expect(res.text).toBe("Bad Request: period parameter is required");
    });

    it("returns 400 for unknown period", async () => {
        const app = makeApp();
        const res = await request(app).get("/api/periodic?period=daily");
        expect(res.statusCode).toBe(400);
        expect(res.text).toBe("Bad Request: unknown period");
    });
});
