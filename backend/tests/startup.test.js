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
        logLevel: jest.fn().mockReturnValue("silent"),
    };
});

describe("Startup Dependencies", () => {
    let app;

    beforeEach(() => {
        // Reset all mocks before each test
        jest.clearAllMocks();
        app = express();
    });

    it("sets up HTTP call logging and handles requests correctly", async () => {
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
        await expect(ensureStartupDependencies(app)).resolves.not.toThrow();
    });

    it("throws if notifications are not available", async () => {
        jest.resetModules();
        jest.resetAllMocks();

        // FIXME: this doesn't work. I think the mock is not being applied correctly.
        // The command is still being resolved to the original one.
        jest.mock("../src/executables", () => {
            const { registerCommand } = require("../src/subprocess");
            return {
                termuxNotification: registerCommand("nonexistent-command"),
            };
        });

        await expect(ensureStartupDependencies(app)).rejects.toThrow(
            "Notifications unavailable. Termux notification executable not found in $PATH. Please ensure that Termux:API is installed and available in your $PATH."
        );
    });

    it("can be called multiple times safely", async () => {
        await Promise.all([
            ensureStartupDependencies(app),
            ensureStartupDependencies(app),
            ensureStartupDependencies(app),
        ]);

        // Test that the app still works after multiple setups
        app.get("/ping", (req, res) => res.send("test"));
        const res = await request(app).get("/ping");
        expect(res.status).toBe(200);
    });
});
