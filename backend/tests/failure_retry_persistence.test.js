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
        const startTime = new Date("2020-01-01T00:00:30Z").getTime();
        timeControl.setTime(startTime);
        
        // Create scheduler and schedule a failing task with fast polling
        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 50 });
        const retryDelay = fromMilliseconds(5000); // 5 second retry delay
        const callback = jest.fn(() => {
            throw new Error("Task failed");
        });
        
        await scheduler.schedule("failing-task", "* * * * *", callback, retryDelay);
        
        // Wait for scheduler to start and catch up (will execute for 00:00:00)
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Check that task was executed and failed properly
        let tasks = await scheduler.getTasks();
        expect(tasks).toHaveLength(1);
        expect(callback).toHaveBeenCalledTimes(1);
        expect(tasks[0].pendingRetryUntil).toBeTruthy();
        expect(tasks[0].lastFailureTime).toBeTruthy();
        expect(tasks[0].modeHint).toBe("idle"); // Retry not due yet (5 seconds delay)
        
        // Advance time just enough to make retry due (but not trigger next cron)
        timeControl.advanceTime(10 * 1000); // 10 seconds (past the 5-second retry delay)
        await new Promise(resolve => setTimeout(resolve, 100));
        
        tasks = await scheduler.getTasks();
        // The task should either be in "retry" mode or have already executed the retry
        // Since the task keeps failing, check that it has executed more times
        expect(callback).toHaveBeenCalledTimes(2); // Should have retried once
        
        await scheduler.cancelAll();
    }, 10000);
});