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
    test("fail, persist, reload -> retry executes when pendingRetryUntil <= now", async () => {
        jest.useFakeTimers().setSystemTime(new Date("2020-01-01T00:00:00Z"));
        
        const capabilities = getTestCapabilities();
        
        // Create scheduler and schedule a failing task
        const scheduler1 = makePollingScheduler(capabilities, { pollIntervalMs: 10 });
        const retryDelay = fromMilliseconds(100); // 100ms retry delay
        let shouldFail = true;
        const callback = jest.fn(() => {
            if (shouldFail) {
                throw new Error("Task failed");
            }
        });
        
        scheduler1.schedule("failing-task", "* * * * *", callback, retryDelay);
        
        // Allow first poll to run the task and fail
        jest.advanceTimersByTime(10);
        expect(callback).toHaveBeenCalledTimes(1);
        
        // Allow time for persistence
        await Promise.resolve();
        
        // Verify task has pendingRetryUntil set
        let tasks = scheduler1.getTasks();
        expect(tasks[0].pendingRetryUntil).toBeTruthy();
        expect(tasks[0].modeHint).toBe("idle"); // Retry not due yet
        
        scheduler1.cancelAll();
        
        // Advance time past retry delay
        jest.setSystemTime(new Date("2020-01-01T00:00:00.200Z")); // 200ms later
        
        // Create new scheduler (simulating restart)
        const scheduler2 = makePollingScheduler(capabilities, { pollIntervalMs: 10 });
        
        // Allow time for state loading
        await new Promise(resolve => setTimeout(resolve, 50));
        
        // Re-schedule the task with a new callback that won't fail
        shouldFail = false;
        const newCallback = jest.fn();
        scheduler2.schedule("failing-task", "* * * * *", newCallback, retryDelay);
        
        // Verify task has pendingRetryUntil from before restart and is due for retry
        tasks = scheduler2.getTasks();
        expect(tasks).toHaveLength(1);
        expect(tasks[0].pendingRetryUntil).toBeTruthy();
        expect(tasks[0].modeHint).toBe("retry"); // Should be due for retry
        
        // Allow poll to execute retry
        jest.advanceTimersByTime(10);
        expect(newCallback).toHaveBeenCalledTimes(1);
        
        // Verify pendingRetryUntil is cleared after successful retry
        tasks = scheduler2.getTasks();
        expect(tasks[0].pendingRetryUntil).toBeFalsy();
        expect(tasks[0].modeHint).toBe("idle");
        
        scheduler2.cancelAll();
        jest.useRealTimers();
    });
});