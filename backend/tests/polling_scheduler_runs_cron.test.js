const { make } = require("../src/cron");
const { fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime } = require("./stubs");

function createCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    return capabilities;
}

describe("polling scheduler runs cron", () => {
    test("schedules and recognizes when task should run based on cron", async () => {
        // Test the core scheduling logic without relying on timers
        jest.useFakeTimers().setSystemTime(new Date("2020-01-01T00:00:00Z"));
        const capabilities = createCapabilities();
        const cron = make(capabilities, { pollIntervalMs: 10 });
        const cb = jest.fn();
        const retryDelay = fromMilliseconds(0);
        
        await cron.schedule("t", "* * * * *", cb, retryDelay);

        // Verify task is scheduled
        let tasks = await cron.getTasks();
        expect(tasks).toHaveLength(1);
        expect(tasks[0].name).toBe("t");
        expect(tasks[0].modeHint).toBe("cron"); // Should be due to run immediately
        
        // Advance time by 1 minute
        jest.setSystemTime(new Date("2020-01-01T00:01:00Z"));
        
        // Check that after time advance, task should still be considered due to run
        tasks = await cron.getTasks();
        expect(tasks[0].modeHint).toBe("cron");

        await cron.cancelAll();
    });
});

