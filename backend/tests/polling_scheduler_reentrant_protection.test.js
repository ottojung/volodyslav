/**
 * Tests for declarative scheduler re-entrancy protection.
 * Ensures proper guarding against overlapping scheduler operations.
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

describe("declarative scheduler re-entrancy protection", () => {
    test("should handle concurrent initialize calls gracefully", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(5000);
        let taskStartCount = 0;
        let taskEndCount = 0;
        
        // Create a long-running task 
        const longRunningTask = jest.fn(async () => {
            taskStartCount++;
            await new Promise(resolve => setTimeout(resolve, 300)); // 300ms delay
            taskEndCount++;
        });
        
        const registrations = [
            ["long-task", "* * * * *", longRunningTask, retryDelay]
        ];
        
        // Call initialize multiple times concurrently
        const promises = [
            capabilities.scheduler.initialize(registrations, { pollIntervalMs: 100 }),
            capabilities.scheduler.initialize(registrations, { pollIntervalMs: 100 }),
            capabilities.scheduler.initialize(registrations, { pollIntervalMs: 100 }),
        ];
        
        await Promise.all(promises);
        
        // Wait for task execution
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Should handle concurrent calls gracefully
        expect(taskStartCount).toBeGreaterThanOrEqual(1);
        expect(taskEndCount).toBeGreaterThanOrEqual(1);
        
        await capabilities.scheduler.stop(capabilities);
    });

    test("should allow multiple initialize calls after completion", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(5000);
        let taskExecutionCount = 0;
        
        const quickTask = jest.fn(() => {
            taskExecutionCount++;
        });
        
        const registrations = [
            ["quick-task", "* * * * *", quickTask, retryDelay]
        ];
        
        // First initialize call
        await capabilities.scheduler.initialize(registrations, { pollIntervalMs: 100 });
        await new Promise(resolve => setTimeout(resolve, 200));
        
        expect(taskExecutionCount).toBe(1);
        
        // Second initialize call should be idempotent
        await capabilities.scheduler.initialize(registrations, { pollIntervalMs: 100 });
        await new Promise(resolve => setTimeout(resolve, 200));
        
        // Task should not execute again on idempotent call
        expect(taskExecutionCount).toBe(1);
        
        await capabilities.scheduler.stop(capabilities);
    });

    test("should handle errors during task execution gracefully", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(5000);
        let taskExecutionCount = 0;
        
        const errorTask = jest.fn(() => {
            taskExecutionCount++;
            throw new Error("Task execution fails");
        });
        
        const registrations = [
            ["error-task", "* * * * *", errorTask, retryDelay]
        ];
        
        // Should not throw despite task errors
        await expect(capabilities.scheduler.initialize(registrations, { pollIntervalMs: 100 })).resolves.toBeUndefined();
        
        // Wait for execution
        await new Promise(resolve => setTimeout(resolve, 200));
        
        expect(taskExecutionCount).toBe(1);
        
        // Should allow subsequent initialize calls despite previous error
        await expect(capabilities.scheduler.initialize(registrations, { pollIntervalMs: 100 })).resolves.toBeUndefined();
        
        await capabilities.scheduler.stop(capabilities);
    });

    test("should handle task validation errors properly", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(5000);
        
        const validTask = jest.fn().mockResolvedValue(undefined);
        
        const registrations = [
            ["valid-task", "* * * * *", validTask, retryDelay]
        ];
        
        // First call to establish state
        await capabilities.scheduler.initialize(registrations, { pollIntervalMs: 100 });
        
        // Different registrations should cause validation error
        const differentRegistrations = [
            ["different-task", "* * * * *", validTask, retryDelay]
        ];
        
        await expect(capabilities.scheduler.initialize(differentRegistrations, { pollIntervalMs: 100 }))
            .rejects.toThrow(/Task list mismatch detected/);
        
        await capabilities.scheduler.stop(capabilities);
    });
});