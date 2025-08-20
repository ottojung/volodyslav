/**
 * Tests for polling scheduler re-entrancy protection.
 * Ensures proper guarding against overlapping poll executions.
 */

const { makePollingScheduler } = require("../src/cron/polling_scheduler");
const { fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper } = require("./stubs");

function caps() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubSleeper(capabilities);
    return capabilities;
}

describe("polling scheduler re-entrancy protection", () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date("2020-01-01T00:00:00Z"));
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test("should not start new poll while previous poll is running", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);
        let pollStartCount = 0;
        let pollEndCount = 0;
        
        // Create a long-running task that will cause poll overlap
        const longRunningTask = jest.fn(async () => {
            pollStartCount++;
            await new Promise(resolve => setTimeout(resolve, 2000)); // 2 second delay
            pollEndCount++;
        });
        
        // Create scheduler with short polling interval
        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 500 });
        await scheduler.schedule("long-task", "* * * * *", longRunningTask, retryDelay);
        
        // Fast-forward time to trigger multiple poll intervals while task is running
        jest.advanceTimersByTime(1500); // Should trigger 3 polls but only 1 should run
        
        expect(pollStartCount).toBe(1); // Only one poll should have started
        
        // Complete the task
        jest.advanceTimersByTime(1000);
        await Promise.resolve(); // Allow promises to resolve
        
        expect(pollEndCount).toBe(1); // Task should complete
        
        await scheduler.cancelAll();
    });

    test("should allow next poll after previous poll completes", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);
        let taskExecutionCount = 0;
        
        const quickTask = jest.fn(() => {
            taskExecutionCount++;
        });
        
        // Create scheduler with 1-second polling interval
        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 1000 });
        await scheduler.schedule("quick-task", "* * * * *", quickTask, retryDelay);
        
        // Trigger first poll
        await scheduler._poll();
        expect(taskExecutionCount).toBe(1);
        
        // Advance time to new minute and trigger second poll
        jest.setSystemTime(new Date("2020-01-01T00:01:00Z")); // New minute to be due again
        await scheduler._poll();
        expect(taskExecutionCount).toBe(2);
        
        await scheduler.cancelAll();
    });

    test("should log poll contention when re-entrancy is detected", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);
        const logDebugSpy = jest.spyOn(capabilities.logger, 'logDebug');
        
        const slowTask = jest.fn(async () => {
            await new Promise(resolve => setTimeout(resolve, 2000));
        });
        
        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 500 });
        await scheduler.schedule("slow-task", "* * * * *", slowTask, retryDelay);
        
        // Trigger multiple polls
        jest.advanceTimersByTime(1500);
        
        // Should log that poll was skipped due to ongoing poll
        expect(logDebugSpy).toHaveBeenCalledWith(
            expect.objectContaining({ reason: "pollInProgress" }),
            "PollSkipped"
        );
        
        await scheduler.cancelAll();
    });

    test("should handle errors during poll without preventing next poll", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);
        let taskExecutionCount = 0;
        
        const errorTask = jest.fn(() => {
            taskExecutionCount++;
            if (taskExecutionCount === 1) {
                throw new Error("First execution fails");
            }
        });
        
        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 1000 });
        await scheduler.schedule("error-task", "* * * * *", errorTask, retryDelay);
        
        // First poll should fail
        await scheduler._poll();
        expect(taskExecutionCount).toBe(1);
        
        // Advance time by retry delay and trigger poll again
        jest.setSystemTime(new Date("2020-01-01T00:05:01Z")); // After retry delay
        await scheduler._poll();
        
        // Should allow next poll despite previous error
        expect(taskExecutionCount).toBe(2);
        
        await scheduler.cancelAll();
    });
});