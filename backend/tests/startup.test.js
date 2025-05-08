const express = require("express");
const { ensureStartupDependencies } = require("../src/startup");

// Mock only the TermuxNotificationCommand in notifications, preserving other functionality
jest.mock("../src/notifications", () => {
    const actualNotifications = jest.requireActual("../src/notifications");
    const { registerCommand } = require("../src/subprocess");
    
    // Create a mock instance that always returns a bash command
    const mockTermuxNotificationCommand = jest.fn().mockReturnValue(registerCommand("bash"));
    
    return {
        ...actualNotifications,  // Keep all original exports
        TermuxNotificationCommand: mockTermuxNotificationCommand,  // Override only TermuxNotificationCommand
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
