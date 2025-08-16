const { make } = require("../src/cron");
const { fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger } = require("./stubs");

describe("polling scheduler state restoration", () => {
    test("restores task timing from state file", async () => {
        const capabilities = getMockedRootCapabilities();
        stubEnvironment(capabilities);
        stubLogger(capabilities);

        const stateData = {
            "test-task": {
                lastSuccessTime: "2020-01-01T02:00:00.000Z",
                lastFailureTime: "2020-01-01T03:00:00.000Z",
                pendingRetryUntil: "2020-01-01T04:00:00.000Z"
            }
        };

        capabilities.checker.fileExists.mockReturnValue(true);
        capabilities.reader.readFileAsText.mockReturnValue(JSON.stringify(stateData));

        const cron = await make(capabilities, { pollIntervalMs: 10 });
        const retryDelay = fromMilliseconds(60000);
        const cb = jest.fn();

        cron.schedule("test-task", "* * * * *", cb, retryDelay);

        const tasks = cron.getTasks();
        const task = tasks[0];
        
        expect(task.lastSuccessTime).toBe("2020-01-01T02:00:00.000Z");
        expect(task.lastFailureTime).toBe("2020-01-01T03:00:00.000Z");
        expect(task.pendingRetryUntil).toBe("2020-01-01T04:00:00.000Z");

        cron.cancelAll();
    });

    test("ignores state for unknown tasks", async () => {
        const capabilities = getMockedRootCapabilities();
        stubEnvironment(capabilities);
        stubLogger(capabilities);

        const stateData = {
            "unknown-task": {
                lastSuccessTime: "2020-01-01T02:00:00.000Z"
            }
        };

        capabilities.checker.fileExists.mockReturnValue(true);
        capabilities.reader.readFileAsText.mockReturnValue(JSON.stringify(stateData));

        const cron = await make(capabilities, { pollIntervalMs: 10 });
        const retryDelay = fromMilliseconds(60000);
        const cb = jest.fn();

        cron.schedule("test-task", "* * * * *", cb, retryDelay);

        const tasks = cron.getTasks();
        const task = tasks[0];
        
        expect(task.lastSuccessTime).toBeUndefined();

        cron.cancelAll();
    });
});