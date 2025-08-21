const { make } = require("../src/cron");
const { fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime } = require("./stubs");

function caps() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    return capabilities;
}

/* eslint-disable jest/no-disabled-tests */
describe.skip("polling scheduler skip running", () => {
    // These tests exercise strictly procedural parts (checking running status via getTasks).
    // They will be handled later when procedural APIs are addressed.
    test.skip("task shows running status correctly", async () => {
        jest.useFakeTimers().setSystemTime(new Date("2020-01-01T00:00:00Z"));
        const cron = make(caps(), { pollIntervalMs: 60000 }); // Long interval to avoid execution
        const retryDelay = fromMilliseconds(0);
        const cb = jest.fn(() => new Promise(() => {})); // Promise that never resolves
        await cron.schedule("t", "* * * * *", cb, retryDelay);

        // Get initial task status
        let tasks = await cron.getTasks();
        expect(tasks).toHaveLength(1);
        expect(tasks[0].running).toBe(false);
        expect(tasks[0].modeHint).toBe("cron"); // Should be due to run

        await cron.cancelAll();
        jest.useRealTimers();
    });
});

