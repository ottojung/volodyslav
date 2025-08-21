/**
 * Tests for declarative scheduler retry semantics.
 * Ensures cron schedule is not superseded by retry logic.
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

describe("declarative scheduler retry semantics", () => {
    // Use real timers for testing actual scheduler behavior
    
    test("should execute tasks according to cron schedule", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(5 * 60 * 1000); // 5 minutes
        let executionCount = 0;
        
        const task = jest.fn(() => {
            executionCount++;
        });
        
        const registrations = [
            // Task runs every minute
            ["retry-test", "* * * * *", task, retryDelay]
        ];

        // Initialize with fast polling for testing
        await capabilities.scheduler.initialize(registrations, { pollIntervalMs: 100 });
        
        // Wait for first execution
        await new Promise(resolve => setTimeout(resolve, 200));
        expect(executionCount).toBe(1);
        
        await capabilities.scheduler.stop();
    });

    test("should handle retry logic when task fails", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(1000); // 1 second for quick testing
        let executionCount = 0;
        
        const task = jest.fn(() => {
            executionCount++;
            if (executionCount === 1) {
                throw new Error("First execution fails");
            }
            // Second execution succeeds
        });
        
        const registrations = [
            // Task runs every minute
            ["retry-test", "* * * * *", task, retryDelay]
        ];

        // Initialize scheduler
        await capabilities.scheduler.initialize(registrations, { pollIntervalMs: 100 });
        
        // Wait for first execution and retry
        await new Promise(resolve => setTimeout(resolve, 300));
        expect(executionCount).toBeGreaterThanOrEqual(1);
        
        // Wait a bit more for potential retry
        await new Promise(resolve => setTimeout(resolve, 1100));
        
        // Should have retried the failed task
        expect(executionCount).toBeGreaterThan(1);
        
        await capabilities.scheduler.stop();
    });

    test("should handle successful execution clearing retry state", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(1000); // 1 second for quick testing
        let executionCount = 0;
        
        const task = jest.fn(() => {
            executionCount++;
            if (executionCount === 1) {
                throw new Error("First execution fails");
            }
            // Second execution succeeds
        });
        
        const registrations = [
            ["clear-retry-test", "* * * * *", task, retryDelay]
        ];

        // Initialize scheduler
        await capabilities.scheduler.initialize(registrations, { pollIntervalMs: 100 });
        
        // Wait for first execution and successful retry
        await new Promise(resolve => setTimeout(resolve, 300));
        expect(executionCount).toBe(1);
        
        // Wait for retry execution
        await new Promise(resolve => setTimeout(resolve, 1100));
        
        // Should have executed successfully
        expect(executionCount).toBe(2);
        expect(task).toHaveBeenCalledTimes(2);
        
        await capabilities.scheduler.stop();
    });

    test("should handle multiple tasks with different retry delays", async () => {
        const capabilities = getTestCapabilities();
        const shortRetryDelay = fromMilliseconds(500);
        const longRetryDelay = fromMilliseconds(2000);
        
        let task1Count = 0;
        let task2Count = 0;
        
        const task1 = jest.fn(() => {
            task1Count++;
            if (task1Count === 1) {
                throw new Error("Task 1 first execution fails");
            }
        });
        
        const task2 = jest.fn(() => {
            task2Count++;
            if (task2Count === 1) {
                throw new Error("Task 2 first execution fails");
            }
        });
        
        const registrations = [
            ["task1", "* * * * *", task1, shortRetryDelay],
            ["task2", "* * * * *", task2, longRetryDelay]
        ];

        // Initialize scheduler
        await capabilities.scheduler.initialize(registrations, { pollIntervalMs: 100 });
        
        // Wait for first executions
        await new Promise(resolve => setTimeout(resolve, 300));
        expect(task1Count).toBe(1);
        expect(task2Count).toBe(1);
        
        // Wait for short retry but not long retry
        await new Promise(resolve => setTimeout(resolve, 700));
        
        // Task1 should have retried, task2 should not yet
        expect(task1Count).toBe(2);
        expect(task2Count).toBe(1);
        
        await capabilities.scheduler.stop();
    });

    test("should maintain idempotent behavior on multiple initialize calls", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(30 * 1000); // 30 seconds
        let executionCount = 0;
        
        const task = jest.fn(() => {
            executionCount++;
        });
        
        const registrations = [
            ["idempotent-test", "* * * * *", task, retryDelay]
        ];

        // Multiple initialize calls should be idempotent
        await capabilities.scheduler.initialize(registrations, { pollIntervalMs: 100 });
        await capabilities.scheduler.initialize(registrations, { pollIntervalMs: 100 });
        await capabilities.scheduler.initialize(registrations, { pollIntervalMs: 100 });
        
        // Wait for execution
        await new Promise(resolve => setTimeout(resolve, 300));
        
        // Should only execute once despite multiple initialize calls
        expect(executionCount).toBe(1);
        expect(task).toHaveBeenCalledTimes(1);
        
        await capabilities.scheduler.stop();
    });
});