const express = require("express");
const request = require("supertest");
const { initialize } = require("../src/startup");
const temporary = require("./temporary");

beforeEach(temporary.beforeEach);
afterEach(temporary.afterEach);

// Mock environment exports to avoid real env dependencies
jest.mock("../src/environment", () => {
    const temporary = require("./temporary");
    return {
        openaiAPIKey: jest.fn().mockReturnValue("test-key"),
        resultsDirectory: jest.fn().mockImplementation(temporary.output),
        myServerPort: jest.fn().mockReturnValue(0),
        logLevel: jest.fn().mockReturnValue("debug"),
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
        const app = express();
        await initialize(app);

        // Add a test route that will be logged
        app.get("/test", (req, res) => {
            res.send("test");
        });

        // Make a request - if logging is set up properly, this won't throw
        const res = await request(app).get("/test");
        expect(res.status).toBe(200);
        expect(res.text).toBe("test");
    });

    it("throws if notifications are not available", async () => {
        const app = express();
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
                return {
                    logLevel: jest.fn().mockReturnValue("silent"),
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
