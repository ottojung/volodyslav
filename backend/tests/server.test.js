const expressApp = require("../src/express_app");
const request = require("supertest");
const { initialize } = require("../src/server");
const {
    getMockedRootCapabilities,
    stubEnvironment,
    stubLogger,
    stubNotifier,
} = require("./mocked");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubNotifier(capabilities);
    return capabilities;
}

// Mock only the TermuxNotificationCommand in notifications, preserving other functionality
jest.mock("../src/scheduler", () => {
    return {
        setup: jest.fn(),
        everyHour: jest.fn(),
    };
});

describe("Startup Dependencies", () => {
    it("sets up HTTP call logging and handles requests correctly", async () => {
        const capabilities = getTestCapabilities();
        const app = expressApp.make();
        await initialize(capabilities, app);

        // Make a request - if logging is set up properly, this won't throw
        const res = await request(app).get("/api/ping");
        expect(res.status).toBe(200);
        expect(res.text).toBe("pong");
    });

    it("throws if notifications are not available", async () => {
        const capabilities = getTestCapabilities();
        capabilities.notifier.ensureNotificationsAvailable = jest.fn(() => {
            throw new Error("Notifications unavailable. Termux notification executable not found in $PATH. Please ensure that Termux:API is installed and available in your $PATH.");
        });
        const app = expressApp.make();
        await expect(initialize(capabilities, app)).rejects.toThrow(
            "Notifications unavailable. Termux notification executable not found in $PATH. Please ensure that Termux:API is installed and available in your $PATH."
        );
    });
});
