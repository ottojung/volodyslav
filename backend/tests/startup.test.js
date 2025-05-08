const express = require("express");
const { ensureStartupDependencies } = require("../src/startup");

// FIXME: mock only the TermuxNotificationCommand, everything else should stay the same!
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

describe("Startup Dependencies", () => {
    const app = express();
    it("ensures notifications are available", async () => {
        await expect(ensureStartupDependencies(app)).resolves.not.toThrow();
    });
});
