/**
 * Tests for failure retry persistence.
 */

const { makePollingScheduler } = require("../src/cron/polling_scheduler");
const { transaction } = require("../src/runtime_state_storage");
const { fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    return capabilities;
}

describe("failure retry persistence", () => {
    test("task failure sets pendingRetryUntil correctly", async () => {
        jest.useFakeTimers().setSystemTime(new Date("2020-01-01T00:00:00Z"));
        
        const capabilities = getTestCapabilities();
        
        // Create scheduler and schedule a failing task
        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 1000 });
        const retryDelay = fromMilliseconds(5000); // 5 second retry delay
        const callback = jest.fn(() => {
            throw new Error("Task failed");
        });
        
        await scheduler.schedule("failing-task", "* * * * *", callback, retryDelay);
        
        // Advance time to trigger cron execution (1 second should be enough)
        jest.advanceTimersByTime(1000);
        
        // Check that task was executed and failed properly
        let tasks = await scheduler.getTasks();
        expect(tasks).toHaveLength(1);
        expect(callback).toHaveBeenCalledTimes(1);
        expect(tasks[0].pendingRetryUntil).toBeTruthy();
        expect(tasks[0].lastFailureTime).toBeTruthy();
        expect(tasks[0].modeHint).toBe("idle"); // Retry not due yet (5 seconds delay)
        
        // Advance time to make retry due
        jest.advanceTimersByTime(5000);
        
        tasks = await scheduler.getTasks();
        expect(tasks[0].modeHint).toBe("retry"); // Now retry should be due
        
        await scheduler.cancelAll();
        jest.useRealTimers();
    }, 10000);
});