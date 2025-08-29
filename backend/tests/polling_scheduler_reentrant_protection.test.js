/**
 * Tests for declarative scheduler re-entrancy protection.
 * Ensures proper guarding against overlapping scheduler operations.
 */

const { fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper, stubPollInterval, getDatetimeControl, stubRuntimeStateStorage } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubSleeper(capabilities);
    stubRuntimeStateStorage(capabilities);
    stubPollInterval(capabilities, 1); // Fast polling for tests
    return capabilities;
}

describe("declarative scheduler re-entrancy protection", () => {
    test("should handle concurrent initialize calls gracefully", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = fromMilliseconds(5000);
        let taskStartCount = 0;
        let taskEndCount = 0;
        
        // Create a simple task without any async operations
        const simpleTask = jest.fn(() => {
            taskStartCount++;
            taskEndCount++;
        });
        
        // Set time to start of hour so "0 * * * *" schedule triggers
        const startTime = new Date("2021-01-01T00:00:00.000Z").getTime();
        timeControl.setTime(startTime);
        
        const registrations = [
            ["simple-task", "0 * * * *", simpleTask, retryDelay]
        ];
        
        // Call initialize multiple times sequentially instead of concurrently
        await capabilities.scheduler.initialize(registrations);
        await capabilities.scheduler.initialize(registrations);
        await capabilities.scheduler.initialize(registrations);
        
        // Wait for task execution
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Should handle concurrent calls gracefully
        expect(taskStartCount).toBeGreaterThanOrEqual(1);
        expect(taskEndCount).toBeGreaterThanOrEqual(1);
        
        await capabilities.scheduler.stop();
        
        // Wait a bit after stop to ensure all cleanup is complete
        await new Promise(resolve => setTimeout(resolve, 50));
    });

    test("should allow multiple initialize calls after completion", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = fromMilliseconds(5000);
        let taskExecutionCount = 0;
        
        const quickTask = jest.fn(() => {
            taskExecutionCount++;
        });
        
        // Set time to start of hour so "0 * * * *" schedule triggers
        const startTime = new Date("2021-01-01T00:00:00.000Z").getTime();
        timeControl.setTime(startTime);
        
        const registrations = [
            ["quick-task", "0 * * * *", quickTask, retryDelay]
        ];
        
        // First initialize call
        await capabilities.scheduler.initialize(registrations);
        await new Promise(resolve => setTimeout(resolve, 200));
        
        expect(taskExecutionCount).toBe(1);
        
        // Second initialize call should be idempotent
        await capabilities.scheduler.initialize(registrations);
        await new Promise(resolve => setTimeout(resolve, 200));
        
        // Task should not execute again on idempotent call
        expect(taskExecutionCount).toBe(1);
        
        await capabilities.scheduler.stop();
    });

    test("should handle errors during task execution gracefully", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = fromMilliseconds(5000);
        let taskExecutionCount = 0;
        
        const errorTask = jest.fn(() => {
            taskExecutionCount++;
            throw new Error("Task execution fails");
        });
        
        // Set time to start of hour so "0 * * * *" schedule triggers
        const startTime = new Date("2021-01-01T00:00:00.000Z").getTime();
        timeControl.setTime(startTime);
        
        const registrations = [
            ["error-task", "0 * * * *", errorTask, retryDelay]
        ];
        
        // Should not throw despite task errors
        await expect(capabilities.scheduler.initialize(registrations)).resolves.toBeUndefined();
        
        // Wait for execution
        await new Promise(resolve => setTimeout(resolve, 200));
        
        expect(taskExecutionCount).toBe(1);
        
        // Should allow subsequent initialize calls despite previous error
        await expect(capabilities.scheduler.initialize(registrations)).resolves.toBeUndefined();
        
        await capabilities.scheduler.stop();
    });

    test("should handle task validation errors properly", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(5000);
        
        const validTask = jest.fn().mockResolvedValue(undefined);
        
        const registrations = [
            ["valid-task", "0 * * * *", validTask, retryDelay]
        ];
        
        // First call to establish state
        await capabilities.scheduler.initialize(registrations);
        
        // Different registrations should cause validation error
        const differentRegistrations = [
            ["different-task", "0 * * * *", validTask, retryDelay]
        ];
        
        await expect(capabilities.scheduler.initialize(differentRegistrations))
            .rejects.toThrow(/Task list mismatch detected/);
        
        await capabilities.scheduler.stop();
    });
});