const express = require("express");
const request = require("supertest");
const { ensureStartupDependencies } = require("../src/startup");

// Mock only the TermuxNotificationCommand in notifications, preserving other functionality
jest.mock("../src/executables", () => {
    const { registerCommand } = require("../src/subprocess");
    return {
        termuxNotification: registerCommand("bash"),
    };
});

// Mock environment with minimal required values
jest.mock("../src/environment", () => {
    return {
        logLevel: jest.fn().mockReturnValue("debug"),
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
        await ensureStartupDependencies(app);

        // Add a test route that will be logged
        app.get("/test", (req, res) => {
            res.send("test");
        });

        // Make a request - if logging is set up properly, this won't throw
        const res = await request(app).get("/test");
        expect(res.status).toBe(200);
        expect(res.text).toBe("test");
    });

    it("ensures notifications are available", async () => {
        const app = express();
        await expect(ensureStartupDependencies(app)).resolves.not.toThrow();
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

            // Get a fresh instance of the module under test
            const { ensureStartupDependencies } = require("../src/startup");
            
            await expect(ensureStartupDependencies(app)).rejects.toThrow(
                "Notifications unavailable. Termux notification executable not found in $PATH. Please ensure that Termux:API is installed and available in your $PATH."
            );
        });
    });

    it("can be called multiple times safely", async () => {
        const app = express();
        await Promise.all([
            ensureStartupDependencies(app),
            ensureStartupDependencies(app),
            ensureStartupDependencies(app),
        ]);

        // Test that the app still works after multiple setups
        app.get("/test", (req, res) => res.send("test"));
        const res = await request(app).get("/test");
        expect(res.status).toBe(200);
    });
});

