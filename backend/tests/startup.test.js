const express = require("express");
const request = require("supertest");
const { ensureStartupDependencies } = require("../src/startup");
const { TermuxNotificationCommand } = require("../src/notifications");

jest.mock("../src/notifications", () => {
    const { registerCommand } = require("../src/subprocess");
    return {
        TermuxNotificationCommand: jest
            .fn()
            .mockReturnValue(registerCommand("bash"))
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
        // jest.clearAllMocks();
        app = express();
    });

    // it("sets up HTTP call logging and handles requests correctly", async () => {
    //     await ensureStartupDependencies(app);

    //     app.get("/test", (req, res) => {
    //         res.send("test");
    //     });

    //     const res = await request(app).get("/test");
    //     expect(res.status).toBe(200);
    //     expect(res.text).toBe("test");
    // });

    // it("ensures notifications are available", async () => {
    //     await ensureStartupDependencies(app);
    //     expect(TermuxNotificationCommand).toHaveBeenCalled();
    // });

    it("throws if notifications are not available", async () => {
        TermuxNotificationCommand.mockReturnValueOnce(null);
        await expect(ensureStartupDependencies(app)).rejects.toThrow();
    });

    // it("can be called multiple times safely", async () => {
    //     await Promise.all([
    //         ensureStartupDependencies(app),
    //         ensureStartupDependencies(app),
    //         ensureStartupDependencies(app),
    //     ]);

    //     expect(TermuxNotificationCommand).toHaveBeenCalledTimes(3);

    //     app.get("/test", (req, res) => res.send("test"));
    //     const res = await request(app).get("/test");
    //     expect(res.status).toBe(200);
    // });
});
