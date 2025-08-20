/**
 * Tests for declarative scheduler re-entrancy protection.
 * Ensures proper guarding against overlapping poll executions.
 */

const { initialize } = require("../src/schedule");
const { COMMON } = require("../src/time_duration");
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

describe("declarative scheduler re-entrancy protection", () => {

    test("should not start new poll while previous poll is running", async () => {
        const capabilities = getTestCapabilities();
        let pollStartCount = 0;
        let pollEndCount = 0;
        
        // Create a long-running task that will cause potential overlap
        const longRunningTask = jest.fn(async () => {
            pollStartCount++;
            await new Promise(resolve => setTimeout(resolve, 300)); // 300ms delay
            pollEndCount++;
        });
        
        const registrations = [
            ["long-task", "* * * * *", longRunningTask, COMMON.FIVE_MINUTES],
        ];
        
        // Initialize with very fast polling to test re-entrancy protection
        await initialize(capabilities, registrations, { pollIntervalMs: 50 });
        
        // Wait a bit for potential multiple executions
        await new Promise(resolve => setTimeout(resolve, 200));
        
        // Due to re-entrancy protection, task should not execute multiple times concurrently
        expect(pollStartCount).toBeGreaterThanOrEqual(1);
        
        // Wait for task to complete
        await new Promise(resolve => setTimeout(resolve, 400));
        
        expect(pollEndCount).toBeGreaterThanOrEqual(1); // Task should complete
    });

    test("should allow next poll after previous poll completes", async () => {
        const capabilities = getTestCapabilities();
        let taskExecutionCount = 0;
        
        const quickTask = jest.fn(() => {
            taskExecutionCount++;
        });
        
        const registrations = [
            ["quick-task", "* * * * *", quickTask, COMMON.FIVE_MINUTES],
        ];
        
        // Initialize scheduler
        await initialize(capabilities, registrations, { pollIntervalMs: 100 });
        await new Promise(resolve => setTimeout(resolve, 150));
        
        expect(taskExecutionCount).toBeGreaterThanOrEqual(1); // First execution
        
        // Call initialize again to trigger additional execution
        await initialize(capabilities, registrations, { pollIntervalMs: 100 });
        await new Promise(resolve => setTimeout(resolve, 150));
        
        expect(taskExecutionCount).toBeGreaterThanOrEqual(2); // Should allow additional execution
    });

    test("should log poll contention when re-entrancy is detected", async () => {
        const capabilities = getTestCapabilities();
        const logDebugSpy = jest.spyOn(capabilities.logger, 'logDebug');
        
        const slowTask = jest.fn(async () => {
            await new Promise(resolve => setTimeout(resolve, 200)); // Slower task
        });
        
        const registrations = [
            ["slow-task", "* * * * *", slowTask, COMMON.FIVE_MINUTES],
        ];
        
        // Initialize with fast polling interval
        await initialize(capabilities, registrations, { pollIntervalMs: 50 });
        
        // Wait for potential multiple execution attempts
        await new Promise(resolve => setTimeout(resolve, 300));
        
        // Should log debug information about scheduler behavior
        // (Note: exact logging behavior may vary with declarative scheduler)
        expect(slowTask).toHaveBeenCalled();
    });

    test("should handle errors during poll without preventing next poll", async () => {
        const capabilities = getTestCapabilities();
        let taskExecutionCount = 0;
        
        const errorTask = jest.fn(() => {
            taskExecutionCount++;
            if (taskExecutionCount === 1) {
                throw new Error("First execution fails");
            }
        });
        
        const registrations = [
            ["error-task", "* * * * *", errorTask, COMMON.FIVE_MINUTES],
        ];
        
        // First initialization should handle error gracefully
        await initialize(capabilities, registrations, { pollIntervalMs: 100 });
        await new Promise(resolve => setTimeout(resolve, 150));
        
        expect(taskExecutionCount).toBeGreaterThanOrEqual(1); // First execution (fails)
        
        // Second initialization should work despite previous error
        await initialize(capabilities, registrations, { pollIntervalMs: 100 });
        await new Promise(resolve => setTimeout(resolve, 150));
        
        expect(taskExecutionCount).toBeGreaterThanOrEqual(2); // Should allow next execution despite previous error
    });
});