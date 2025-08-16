const { make } = require("../src/cron");
const { fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger } = require("./stubs");

describe("polling scheduler error handling", () => {
    test("handles missing state file gracefully", async () => {
        const capabilities = getMockedRootCapabilities();
        stubEnvironment(capabilities);
        stubLogger(capabilities);

        capabilities.checker.fileExists.mockReturnValue(false);

        const cron = await make(capabilities, { pollIntervalMs: 10 });
        const retryDelay = fromMilliseconds(60000);
        const cb = jest.fn();

        cron.schedule("test-task", "* * * * *", cb, retryDelay);

        const tasks = cron.getTasks();
        expect(tasks).toHaveLength(1);

        cron.cancelAll();
    });

    test("handles invalid JSON gracefully", async () => {
        const capabilities = getMockedRootCapabilities();
        stubEnvironment(capabilities);
        stubLogger(capabilities);

        capabilities.checker.fileExists.mockReturnValue(true);
        capabilities.reader.readFileAsText.mockReturnValue("invalid json");

        const cron = await make(capabilities, { pollIntervalMs: 10 });
        const retryDelay = fromMilliseconds(60000);
        const cb = jest.fn();

        cron.schedule("test-task", "* * * * *", cb, retryDelay);

        const tasks = cron.getTasks();
        expect(tasks).toHaveLength(1);

        cron.cancelAll();
    });
});