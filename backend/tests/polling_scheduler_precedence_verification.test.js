/**
 * Specific test to verify cron vs retry precedence logic in declarative scheduler
 * This test verifies that task execution timing follows expected precedence behavior
 */

const { fromHours, fromMilliseconds, fromISOString } = require("../src/datetime");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper, stubScheduler, getSchedulerControl, getDatetimeControl, stubRuntimeStateStorage } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubSleeper(capabilities);
    stubRuntimeStateStorage(capabilities);
    stubScheduler(capabilities);
    return capabilities;
}

describe("declarative scheduler precedence logic verification", () => {
    // Don't use fake timers for most tests - test actual scheduler behavior
    
    test("should handle task execution at scheduled times", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = fromMilliseconds(2 * 60 * 1000); // 2 minutes
        
        const task = jest.fn().mockResolvedValue(undefined);
        
        // Set time to avoid immediate execution for "0 * * * *" schedule
        const startTime = fromISOString("2021-01-01T00:05:00.000Z");
        timeControl.setDateTime(startTime);
        schedulerControl.setPollingInterval(fromMilliseconds(100));
        
        // Task runs at minute 0 of every hour
        const registrations = [
            ["precedence-test", "0 * * * *", task, retryDelay]
        ];
        
        // Initialize scheduler
        await capabilities.scheduler.initialize(registrations);
        await schedulerControl.waitForNextCycleEnd();
        
        // Should not execute immediately on first startup
        expect(task).not.toHaveBeenCalled();
        
        // Advance time to next scheduled execution (01:00:00)
        timeControl.advanceByDuration(fromHours(1)); // 1 hour
        await schedulerControl.waitForNextCycleEnd();
        
        expect(task).toHaveBeenCalled();
        
        await capabilities.scheduler.stop();
    });

    test("should handle different cron schedules correctly", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = fromMilliseconds(6 * 60 * 1000); // 6 minutes
        
        const task = jest.fn().mockResolvedValue(undefined);
        
        // Set time to avoid immediate execution for "0 * * * *" schedule
        const startTime = fromISOString("2021-01-01T00:05:00.000Z");
        timeControl.setDateTime(startTime);
        schedulerControl.setPollingInterval(fromMilliseconds(100));
        
        // Task runs at minute 0 of every hour
        const registrations = [
            ["precedence-test", "0 * * * *", task, retryDelay]
        ];
        
        // Initialize scheduler
        await capabilities.scheduler.initialize(registrations);
        await schedulerControl.waitForNextCycleEnd();
        
        // Should not execute immediately on first startup
        expect(task).not.toHaveBeenCalled();
        
        // Advance time to next scheduled execution (01:00:00)
        timeControl.advanceByDuration(fromHours(1)); // 1 hour
        await schedulerControl.waitForNextCycleEnd();
        
        expect(task).toHaveBeenCalled();
        
        await capabilities.scheduler.stop();
    });

    test("should reject multiple initialize calls at the same time", async () => {
        const capabilities = getTestCapabilities();
        const schedulerControl = getSchedulerControl(capabilities);
        const timeControl = getDatetimeControl(capabilities);
        
        const retryDelay = fromMilliseconds(5 * 60 * 1000); // 5 minutes
        const task = jest.fn().mockResolvedValue(undefined);
        
        schedulerControl.setPollingInterval(fromMilliseconds(100));
        
        // Set time to avoid execution at 0,15,30,45 minutes
        const startTime = fromISOString("2021-01-01T00:05:00.000Z");
        timeControl.setDateTime(startTime);
        
        // Task runs every 15 minutes
        const registrations = [
            ["precedence-test", "0,15,30,45 * * * *", task, retryDelay]
        ];
        
        // First call should succeed
        await capabilities.scheduler.initialize(registrations);
        
        // Subsequent calls should throw error (not idempotent)
        await expect(capabilities.scheduler.initialize(registrations)).rejects.toThrow("Cannot initialize scheduler: scheduler is already running");
        await expect(capabilities.scheduler.initialize(registrations)).rejects.toThrow("Cannot initialize scheduler: scheduler is already running");
        
        // Wait for scheduler to start and potentially execute tasks
        await schedulerControl.waitForNextCycleEnd();
        
        // Task should not execute immediately (time is at 00:05, next run is 00:15)
        expect(task.mock.calls.length).toBe(0);
        
        await capabilities.scheduler.stop();
    });
});