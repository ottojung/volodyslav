/**
 * Tests for declarative scheduler cron execution behavior.
 * Focuses on verifying that scheduled tasks execute according to cron expressions.
 */

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

describe("declarative scheduler cron execution", () => {
    test("executes task when cron expression matches current time", async () => {
        jest.useFakeTimers().setSystemTime(new Date("2020-01-01T00:00:00Z"));
        
        const capabilities = getTestCapabilities();
        const taskCallback = jest.fn();
        const retryDelay = fromMilliseconds(0);
        
        // Schedule task to run every minute
        const registrations = [
            ["cron-task", "* * * * *", taskCallback, retryDelay]
        ];
        
        // Initialize with short polling interval to test execution
        await capabilities.scheduler.initialize(registrations, { pollIntervalMs: 50 });
        
        // Wait for initial execution
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(taskCallback).toHaveBeenCalledTimes(1);
        
        // Advance time by 1 minute
        jest.setSystemTime(new Date("2020-01-01T00:01:00Z"));
        
        // Wait for next execution cycle
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(taskCallback).toHaveBeenCalledTimes(2);
        
        await capabilities.scheduler.stop();
        jest.useRealTimers();
    });

    test("does not execute task when cron expression does not match", async () => {
        jest.useFakeTimers().setSystemTime(new Date("2020-01-01T00:00:30Z")); // 30 seconds into the minute
        
        const capabilities = getTestCapabilities();
        const taskCallback = jest.fn();
        const retryDelay = fromMilliseconds(0);
        
        // Schedule task to run only at second 0 of each minute (which we've passed)
        const registrations = [
            ["specific-cron-task", "0 * * * *", taskCallback, retryDelay] // Run at minute 0 of each hour
        ];
        
        await capabilities.scheduler.initialize(registrations, { pollIntervalMs: 50 });
        
        // Wait a bit - task should not execute since we're not at the 0th minute of the hour
        await new Promise(resolve => setTimeout(resolve, 200));
        expect(taskCallback).not.toHaveBeenCalled();
        
        await capabilities.scheduler.stop();
        jest.useRealTimers();
    });
});

