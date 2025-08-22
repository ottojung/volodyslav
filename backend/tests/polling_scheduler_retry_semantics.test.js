/**
 * Tests for declarative scheduler retry semantics.
 * Ensures cron schedule is not superseded by retry logic.
 */

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

describe("declarative scheduler retry semantics", () => {
    // Use real timers for testing actual scheduler behavior
    
    test("should execute tasks according to cron schedule", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = fromMilliseconds(5 * 60 * 1000); // 5 minutes
        let executionCount = 0;
        
        const task = jest.fn(() => {
            executionCount++;
        });
        
        const registrations = [
            // Task runs every 15 minutes (compatible with 10-minute polling)
            ["retry-test", "*/15 * * * *", task, retryDelay]
        ];

        // Set a fixed starting time
        const startTime = new Date("2024-01-01T00:00:00Z").getTime();
        timeControl.setTime(startTime);

        // Initialize with default polling
        await capabilities.scheduler.initialize(registrations);
        
        // Trigger execution by advancing to 15-minute mark
        timeControl.advanceTime(15 * 60 * 1000); // 15 minutes
        await capabilities.scheduler.pollNow();
        expect(executionCount).toBe(1);
        
        await capabilities.scheduler.stop();
    });

    test("should handle retry logic when task fails", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = fromMilliseconds(5 * 60 * 1000); // 5 minutes
        let executionCount = 0;
        
        const task = jest.fn(() => {
            executionCount++;
            if (executionCount === 1) {
                throw new Error("First execution fails");
            }
            // Second execution succeeds
        });
        
        const registrations = [
            // Task runs every 15 minutes (compatible with 10-minute polling)
            ["retry-test", "*/15 * * * *", task, retryDelay]
        ];

        // Set a fixed starting time
        const startTime = new Date("2024-01-01T00:00:00Z").getTime();
        timeControl.setTime(startTime);

        // Initialize scheduler with default polling (10 minutes)
        await capabilities.scheduler.initialize(registrations);
        
        // Trigger initial execution by advancing to 15-minute mark
        timeControl.advanceTime(15 * 60 * 1000); // 15 minutes
        await capabilities.scheduler.pollNow();
        expect(executionCount).toBeGreaterThanOrEqual(1);
        
        // Advance time by retry delay (5 minutes) to trigger retry
        timeControl.advanceTime(5 * 60 * 1000); // 5 minutes
        await capabilities.scheduler.pollNow();
        
        // Should have retried the failed task
        expect(executionCount).toBeGreaterThan(1);
        
        await capabilities.scheduler.stop();
    });

    test("should handle successful execution clearing retry state", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = fromMilliseconds(5 * 60 * 1000); // 5 minutes
        let executionCount = 0;
        
        const task = jest.fn(() => {
            executionCount++;
            if (executionCount === 1) {
                throw new Error("First execution fails");
            }
            // Second execution succeeds
        });
        
        const registrations = [
            ["clear-retry-test", "*/15 * * * *", task, retryDelay]
        ];

        // Set a fixed starting time
        const startTime = new Date("2024-01-01T00:00:00Z").getTime();
        timeControl.setTime(startTime);

        // Initialize scheduler with default polling
        await capabilities.scheduler.initialize(registrations);
        
        // Trigger initial execution by advancing to 15-minute mark
        timeControl.advanceTime(15 * 60 * 1000); // 15 minutes
        await capabilities.scheduler.pollNow();
        expect(executionCount).toBe(1);
        
        // Advance time by retry delay to trigger retry
        timeControl.advanceTime(5 * 60 * 1000); // 5 minutes
        await capabilities.scheduler.pollNow();
        
        // Should have executed successfully
        expect(executionCount).toBe(2);
        expect(task).toHaveBeenCalledTimes(2);
        
        await capabilities.scheduler.stop();
    });

    test("should handle multiple tasks with different retry delays", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const shortRetryDelay = fromMilliseconds(3 * 60 * 1000); // 3 minutes
        const longRetryDelay = fromMilliseconds(8 * 60 * 1000); // 8 minutes
        
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
            ["task1", "*/15 * * * *", task1, shortRetryDelay],
            ["task2", "*/15 * * * *", task2, longRetryDelay]
        ];

        // Set a fixed starting time
        const startTime = new Date("2024-01-01T00:00:00Z").getTime();
        timeControl.setTime(startTime);

        // Initialize scheduler
        await capabilities.scheduler.initialize(registrations);
        
        // Trigger initial executions by advancing to 15-minute mark
        timeControl.advanceTime(15 * 60 * 1000); // 15 minutes
        await capabilities.scheduler.pollNow();
        expect(task1Count).toBe(1);
        expect(task2Count).toBe(1);
        
        // Advance time by short retry delay (3 minutes) but not long retry delay (8 minutes)
        timeControl.advanceTime(3 * 60 * 1000); // 3 minutes
        await capabilities.scheduler.pollNow();
        
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