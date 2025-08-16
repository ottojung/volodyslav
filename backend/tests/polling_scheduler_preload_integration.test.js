const { make } = require("../src/cron");
const { fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger } = require("./stubs");

describe("polling scheduler with state", () => {
    test("works normally without state file", async () => {
        const capabilities = getMockedRootCapabilities();
        stubEnvironment(capabilities);
        stubLogger(capabilities);
        
        capabilities.checker.fileExists.mockReturnValue(false);

        const cron = await make(capabilities, { pollIntervalMs: 100 });
        const retryDelay = fromMilliseconds(60000);
        const cb = jest.fn();

        cron.schedule("test-task", "* * * * *", cb, retryDelay);

        const tasks = cron.getTasks();
        expect(tasks).toHaveLength(1);
        expect(tasks[0].name).toBe("test-task");

        cron.cancelAll();
    });

    test("restores task state from file", async () => {
        const capabilities = getMockedRootCapabilities();
        stubEnvironment(capabilities);
        stubLogger(capabilities);
        
        const stateData = {
            "test-task": {
                lastSuccessTime: "2020-01-01T00:00:00.000Z",
                pendingRetryUntil: "2020-01-01T01:00:00.000Z"
            }
        };
        
        capabilities.checker.fileExists.mockReturnValue(true);
        capabilities.reader.readFileAsText.mockReturnValue(JSON.stringify(stateData));

        const cron = await make(capabilities, { pollIntervalMs: 100 });
        const retryDelay = fromMilliseconds(60000);
        const cb = jest.fn();

        cron.schedule("test-task", "* * * * *", cb, retryDelay);

        const tasks = cron.getTasks();
        expect(tasks[0].lastSuccessTime).toBe("2020-01-01T00:00:00.000Z");
        expect(tasks[0].pendingRetryUntil).toBe("2020-01-01T01:00:00.000Z");

        cron.cancelAll();
    });
});