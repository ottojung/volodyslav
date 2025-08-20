/**
 * Tests for failure retry persistence.
 */

const { makePollingScheduler } = require("../src/cron/polling_scheduler");
const { fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubSleeper(capabilities);
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
            console.log("CALLBACK EXECUTED");
            throw new Error("Task failed");
        });
        
        console.log("Scheduling task...");
        await scheduler.schedule("failing-task", "* * * * *", callback, retryDelay);
        
        console.log("Calling manual poll...");
        await scheduler._poll();
        
        console.log("Getting tasks after poll...");
        let tasks = await scheduler.getTasks();
        console.log("Tasks after poll:", tasks.length, tasks[0] ? tasks[0].modeHint : "no tasks");
        console.log("Callback call count:", callback.mock.calls.length);
        
        // Original test logic
        // Check that task was executed and failed properly
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