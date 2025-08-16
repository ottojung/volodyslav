const { make } = require("../src/cron");
const { fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    
    // Mock git operations to succeed for repository setup
    capabilities.git.call = jest.fn().mockResolvedValue({ stdout: "", stderr: "" });
    
    return capabilities;
}

describe("polling scheduler preload error handling", () => {
    test("handles missing state file gracefully", async () => {
        const capabilities = getTestCapabilities();

        // Mock no state file found
        capabilities.checker.fileExists.mockResolvedValue(false);

        const cron = await make(capabilities, { pollIntervalMs: 10 });
        const retryDelay = fromMilliseconds(60000);
        const cb = jest.fn();

        cron.schedule("test-task", "* * * * *", cb, retryDelay);

        // Give time for loading
        await new Promise(resolve => setTimeout(resolve, 50));

        // Should log that no tasks were preloaded
        expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
            { taskCount: 0 },
            "SchedulerStatePreload"
        );

        cron.cancelAll();
    });

    test("handles file read errors gracefully", async () => {
        const capabilities = getTestCapabilities();

        // Mock file exists but read fails
        capabilities.checker.fileExists.mockResolvedValue(true);
        capabilities.reader.readFileAsText.mockRejectedValue(new Error("File read failed"));

        const cron = await make(capabilities, { pollIntervalMs: 10 });
        const retryDelay = fromMilliseconds(60000);
        const cb = jest.fn();

        cron.schedule("test-task", "* * * * *", cb, retryDelay);

        // Give time for loading to complete and fail
        await new Promise(resolve => setTimeout(resolve, 50));

        // Should log the failure
        expect(capabilities.logger.logWarning).toHaveBeenCalledWith(
            { message: "File read failed" },
            "StateLoadFailed"
        );

        // Should still log empty preload
        expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
            { taskCount: 0 },
            "SchedulerStatePreload"
        );

        cron.cancelAll();
    });

    test("handles invalid JSON gracefully", async () => {
        const capabilities = getTestCapabilities();

        // Mock file with invalid JSON
        capabilities.checker.fileExists.mockResolvedValue(true);
        capabilities.reader.readFileAsText.mockResolvedValue("invalid json content");

        const cron = await make(capabilities, { pollIntervalMs: 10 });
        const retryDelay = fromMilliseconds(60000);
        const cb = jest.fn();

        cron.schedule("test-task", "* * * * *", cb, retryDelay);

        // Give time for loading to complete and fail
        await new Promise(resolve => setTimeout(resolve, 50));

        // Should log the JSON parse failure
        expect(capabilities.logger.logWarning).toHaveBeenCalledWith(
            expect.objectContaining({
                message: expect.stringContaining("Unexpected token")
            }),
            "StateLoadFailed"
        );

        cron.cancelAll();
    });

    test("handles unsupported version gracefully", async () => {
        const capabilities = getTestCapabilities();

        // Mock file with unsupported version
        const stateData = {
            version: 999, // Unsupported version
            startTime: "2020-01-01T00:00:00.000Z",
            tasks: []
        };

        capabilities.checker.fileExists.mockResolvedValue(true);
        capabilities.reader.readFileAsText.mockResolvedValue(JSON.stringify(stateData));

        const cron = await make(capabilities, { pollIntervalMs: 10 });
        const retryDelay = fromMilliseconds(60000);
        const cb = jest.fn();

        cron.schedule("test-task", "* * * * *", cb, retryDelay);

        // Give time for loading to complete
        await new Promise(resolve => setTimeout(resolve, 50));

        // Should log unsupported version error
        expect(capabilities.logger.logError).toHaveBeenCalledWith(
            { version: 999 },
            "UnsupportedRuntimeStateVersion"
        );

        // Should still log empty preload
        expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
            { taskCount: 0 },
            "SchedulerStatePreload"
        );

        cron.cancelAll();
    });
});