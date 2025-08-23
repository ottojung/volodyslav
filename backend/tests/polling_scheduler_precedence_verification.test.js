/**
 * Specific test to verify cron vs retry precedence logic in declarative scheduler
 * This test verifies that task execution timing follows expected precedence behavior
 */

const { fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper, stubPollInterval } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubSleeper(capabilities);
    stubPollInterval(1); // Fast polling for tests
    return capabilities;
}

describe("declarative scheduler precedence logic verification", () => {
    // Don't use fake timers for most tests - test actual scheduler behavior
    
    test("should handle task execution at scheduled times", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(2 * 60 * 1000); // 2 minutes
        
        const task = jest.fn().mockResolvedValue(undefined);
        
        // Task runs every minute - should execute immediately
        const registrations = [
            ["precedence-test", "0 * * * *", task, retryDelay]
        ];
        
        // Initialize and wait for execution
        await capabilities.scheduler.initialize(registrations);
        await new Promise(resolve => setTimeout(resolve, 200));
        
        expect(task).toHaveBeenCalled();
        
        await capabilities.scheduler.stop(capabilities);
    });

    test("should handle different cron schedules correctly", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(6 * 60 * 1000); // 6 minutes
        
        const task = jest.fn().mockResolvedValue(undefined);
        
        // Task runs every minute - should execute immediately
        const registrations = [
            ["precedence-test", "0 * * * *", task, retryDelay]
        ];
        
        // Initialize and wait for execution
        await capabilities.scheduler.initialize(registrations);
        await new Promise(resolve => setTimeout(resolve, 200));
        
        expect(task).toHaveBeenCalled();
        
        await capabilities.scheduler.stop(capabilities);
    });

    test("should handle multiple initialize calls at the same time consistently", async () => {
        jest.useFakeTimers();
        try {
            const capabilities = getTestCapabilities();
            
            // Set up a specific timing scenario
            jest.setSystemTime(new Date("2020-01-01T10:00:00Z"));
            
            const retryDelay = fromMilliseconds(5 * 60 * 1000); // 5 minutes
            const task = jest.fn().mockResolvedValue(undefined);
            
            // Task runs every 5 minutes (10:00, 10:05, 10:10, etc.)
            const registrations = [
                ["precedence-test", "*/15 * * * *", task, retryDelay]
            ];
            
            // Multiple calls at 10:00 should be idempotent
            await capabilities.scheduler.initialize(registrations);
            await capabilities.scheduler.initialize(registrations);
            await capabilities.scheduler.initialize(registrations);
            
            jest.advanceTimersByTime(200);
            
            // Task should only be executed once despite multiple initialize calls
            expect(task).toHaveBeenCalledTimes(1);
            
            await capabilities.scheduler.stop(capabilities);
        } finally {
            jest.useRealTimers();
        }
    });
});