/**
 * Tests for failure retry persistence.
 */

const { makePollingScheduler } = require("../src/cron/polling_scheduler");
const { fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper, getDatetimeControl } = require("./stubs");

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
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        
        // Set a fixed starting time
        const startTime = new Date("2020-01-01T00:00:00Z").getTime();
        timeControl.setTime(startTime);
        
        // Create scheduler and schedule a failing task
        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 1000 });
        const retryDelay = fromMilliseconds(5000); // 5 second retry delay
        const callback = jest.fn(() => {
            throw new Error("Task failed");
        });
        
        await scheduler.schedule("failing-task", "* * * * *", callback, retryDelay);
        
        // Trigger cron execution by advancing time slightly (to next minute boundary) and polling
        timeControl.advanceTime(60 * 1000); // 1 minute
        await scheduler.pollNow(); // Manually trigger polling
        
        // Check that task was executed and failed properly
        let tasks = await scheduler.getTasks();
        expect(tasks).toHaveLength(1);
        expect(callback).toHaveBeenCalledTimes(1);
        expect(tasks[0].pendingRetryUntil).toBeTruthy();
        expect(tasks[0].lastFailureTime).toBeTruthy();
        expect(tasks[0].modeHint).toBe("idle"); // Retry not due yet (5 seconds delay)
        
        // Advance time to make retry due and poll again
        timeControl.advanceTime(5000); // 5 seconds
        await scheduler.pollNow(); // Manually trigger polling to check retry state
        
        tasks = await scheduler.getTasks();
        expect(tasks[0].modeHint).toBe("retry"); // Now retry should be due
        
        await scheduler.cancelAll();
    }, 10000);
});