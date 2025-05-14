const expressApp = require("../src/express_app");
const request = require("supertest");
const { initialize } = require("../src/startup");
const temporary = require("./temporary");
const logger = require("../src/logger");

beforeEach(temporary.beforeEach);
afterEach(temporary.afterEach);

// Mock environment exports to avoid real env dependencies
jest.mock("../src/environment", () => {
    const path = require("path");
    const temporary = require("./temporary");
    return {
        openaiAPIKey: jest.fn().mockReturnValue("test-key"),
        resultsDirectory: jest.fn().mockImplementation(() => {
            return path.join(temporary.output(), "results");
        }),
        myServerPort: jest.fn().mockReturnValue(0),
        logLevel: jest.fn().mockReturnValue("debug"),
        logFile: jest.fn().mockImplementation(() => {
            return path.join(temporary.output(), "log.txt");
        }),
    };
});

// Mock only the TermuxNotificationCommand in notifications, preserving other functionality
jest.mock("../src/executables", () => {
    const { registerCommand } = require("../src/subprocess");
    return {
        termuxNotification: registerCommand("bash"),
    };
});

describe("Startup Dependencies", () => {
    beforeEach(() => {
        // Reset all mocks before each test
        jest.clearAllMocks();
        jest.resetModules();
    });

    it("sets up HTTP call logging and handles requests correctly", async () => {
        logger.setup();
        const app = expressApp.make();
        await initialize(app);

        // Make a request - if logging is set up properly, this won't throw
        const res = await request(app).get("/api/ping");
        expect(res.status).toBe(200);
        expect(res.text).toBe("pong");
    });

    it("throws if notifications are not available", async () => {
        const app = expressApp.make();
        await jest.isolateModules(async () => {
            // Inside the isolation, mock the module with a nonexistent command
            jest.mock("../src/executables", () => {
                const { registerCommand } = require("../src/subprocess");
                return {
                    termuxNotification: registerCommand("nonexistent-command"),
                };
            });

            // Mock environment exports to avoid real env dependencies
            jest.mock("../src/environment", () => {
                const path = require("path");
                const temporary = require("./temporary");
                return {
                    openaiAPIKey: jest.fn().mockReturnValue("test-key"),
                    resultsDirectory: jest.fn().mockImplementation(() => {
                        return path.join(temporary.output(), "results");
                    }),
                    myServerPort: jest.fn().mockReturnValue(0),
                    logLevel: jest.fn().mockReturnValue("silent"),
                    logFile: jest.fn().mockImplementation(() => {
                        return path.join(temporary.output(), "log.txt");
                    }),
                };
            });

            // Get a fresh instance of the module under test
            const { initialize } = require("../src/startup");

            await expect(initialize(app)).rejects.toThrow(
                "Notifications unavailable. Termux notification executable not found in $PATH. Please ensure that Termux:API is installed and available in your $PATH."
            );
        });
    });
});
