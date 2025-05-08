const express = require("express");
const { ensureStartupDependencies } = require("../src/startup");

// Mock only the TermuxNotificationCommand in notifications, preserving other functionality
jest.mock("../src/externalcommands/termuxnotification", () => {
    return () => 'bash';
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
