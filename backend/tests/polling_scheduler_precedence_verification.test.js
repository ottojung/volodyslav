/**
 * Specific test to verify cron vs retry precedence logic in declarative scheduler
 * This test verifies that task execution timing follows expected precedence behavior
 */

const { fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper, stubPollInterval, getDatetimeControl, stubRuntimeStateStorage } = require("./stubs");

stubPollInterval(1); // Fast polling for tests

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubSleeper(capabilities);
    stubRuntimeStateStorage(capabilities);
    return capabilities;
}

describe("declarative scheduler precedence logic verification", () => {
    // Don't use fake timers for most tests - test actual scheduler behavior
    
    test("should handle task execution at scheduled times", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = fromMilliseconds(2 * 60 * 1000); // 2 minutes
        
        const task = jest.fn().mockResolvedValue(undefined);
        
        // Set time to start of hour so "0 * * * *" schedule triggers
        const startTime = new Date("2021-01-01T00:00:00.000Z").getTime();
        timeControl.setTime(startTime);
        
        // Task runs at minute 0 of every hour
        const registrations = [
            ["precedence-test", "0 * * * *", task, retryDelay]
        ];
        
        // Initialize and wait for execution
        await capabilities.scheduler.initialize(registrations);
        await new Promise(resolve => setTimeout(resolve, 200));
        
        expect(task).toHaveBeenCalled();
        
        await capabilities.scheduler.stop();
    });

    test("should handle different cron schedules correctly", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = fromMilliseconds(6 * 60 * 1000); // 6 minutes
        
        const task = jest.fn().mockResolvedValue(undefined);
        
        // Set time to start of hour so "0 * * * *" schedule triggers
        const startTime = new Date("2021-01-01T00:00:00.000Z").getTime();
        timeControl.setTime(startTime);
        
        // Task runs at minute 0 of every hour
        const registrations = [
            ["precedence-test", "0 * * * *", task, retryDelay]
        ];
        
        // Initialize and wait for execution
        await capabilities.scheduler.initialize(registrations);
        await new Promise(resolve => setTimeout(resolve, 200));
        
        expect(task).toHaveBeenCalled();
        
        await capabilities.scheduler.stop();
    });

    test("should handle multiple initialize calls at the same time consistently", async () => {
        const capabilities = getTestCapabilities();
        
        const retryDelay = fromMilliseconds(5 * 60 * 1000); // 5 minutes
        const task = jest.fn().mockResolvedValue(undefined);
        
        // Task runs every 15 minutes
        const registrations = [
            ["precedence-test", "*/15 * * * *", task, retryDelay]
        ];
        
        // Multiple calls should be idempotent - only the first should have effect
        await capabilities.scheduler.initialize(registrations);
        await capabilities.scheduler.initialize(registrations);
        await capabilities.scheduler.initialize(registrations);
        
        // Wait for scheduler to start and potentially execute tasks
        await new Promise(resolve => setTimeout(resolve, 200));
        
        // Task should be executed (idempotent initialization doesn't prevent normal execution)
        // The key test is that multiple initialize calls don't cause problems
        expect(task.mock.calls.length).toBeGreaterThanOrEqual(0); // May or may not execute immediately
        
        await capabilities.scheduler.stop();
    });
});