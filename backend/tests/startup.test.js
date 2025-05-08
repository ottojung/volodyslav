const express = require("express");
const request = require("supertest");

jest.mock("../src/notifications", () => {
    const { registerCommand } = require("../src/subprocess");
    return {
        TermuxNotificationCommand: jest
            .fn()
            .mockReturnValue(registerCommand("bash")),
    };
});

// Mock environment with minimal required values
jest.mock("../src/environment", () => {
    return {
        logLevel: jest.fn().mockReturnValue("silent"),
    };
});

const { ensureStartupDependencies } = require("../src/startup");
const { ensureNotificationsAvailable } = require("../src/notifications");

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
        await ensureStartupDependencies(app);

        expect(ensureNotificationsAvailable).toHaveBeenCalled();
    });

    it("throws if notifications are not available", async () => {
        const error = new Error("Notifications not available");
        await expect(ensureStartupDependencies(app)).rejects.toThrow(
            "Notifications not available"
        );
    });

    it("can be called multiple times safely", async () => {
        await Promise.all([
            ensureStartupDependencies(app),
            ensureStartupDependencies(app),
            ensureStartupDependencies(app),
        ]);

        expect(ensureNotificationsAvailable).toHaveBeenCalledTimes(3);

        // Test that the app still works after multiple setups
        app.get("/test", (req, res) => res.send("test"));
        const res = await request(app).get("/test");
        expect(res.status).toBe(200);
    });
});
