/**
 * Tests for declarative scheduler retry semantics.
 * Ensures cron schedule is not superseded by retry logic.
 */

const { Duration } = require("luxon");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper, getDatetimeControl, stubScheduler, getSchedulerControl, stubRuntimeStateStorage } = require("./stubs");

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

describe("declarative scheduler retry semantics", () => {

    test("should execute tasks according to cron schedule", async () => {
        const capabilities = getTestCapabilities();
        const schedulerControl = getSchedulerControl(capabilities);
        schedulerControl.setPollingInterval(1);
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = Duration.fromMillis(5 * 60 * 1000); // 5 minutes
        let executionCount = 0;

        const task = jest.fn(() => {
            executionCount++;
        });

        const registrations = [
            // Task runs every 15 minutes (compatible with 10-minute polling)
            ["retry-test", "*/15 * * * *", task, retryDelay]
        ];

        // Set a fixed starting time to 00:05:00 (so 00:00:00 was 5 minutes ago - will catch up)
        const startTime = 1704067500000 // 2024-01-01T00:05:00Z;
        timeControl.setTime(startTime);

        // Initialize with fast polling for tests
        await capabilities.scheduler.initialize(registrations);

        // Wait for scheduler to start (should NOT execute immediately on first startup)
        await schedulerControl.waitForNextCycleEnd();
        expect(executionCount).toBe(0);

        // Advance to the next scheduled time (01:00:00) to verify scheduling works
        timeControl.advanceTime(55 * 60 * 1000); // 55 minutes to reach 01:00:00
        await schedulerControl.waitForNextCycleEnd();
        expect(executionCount).toBe(1);

        await capabilities.scheduler.stop();
    });

    test("should handle retry logic when task fails", async () => {
        const capabilities = getTestCapabilities();
        const schedulerControl = getSchedulerControl(capabilities);
        schedulerControl.setPollingInterval(1);
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = Duration.fromMillis(5 * 60 * 1000); // 5 minutes
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

        // Set a fixed starting time to 00:05:00 (so 00:00:00 was 5 minutes ago - will catch up)
        const startTime = 1704067500000 // 2024-01-01T00:05:00Z;
        timeControl.setTime(startTime);

        // Initialize scheduler with fast polling for tests
        await capabilities.scheduler.initialize(registrations);

        // Wait for initial execution (should NOT execute immediately on first startup)
        await schedulerControl.waitForNextCycleEnd();
        expect(executionCount).toBe(0);

        // Advance to the next scheduled time (01:00:00) to trigger first execution and failure
        timeControl.advanceTime(55 * 60 * 1000); // 55 minutes to reach 01:00:00
        await schedulerControl.waitForNextCycleEnd();
        expect(executionCount).toBeGreaterThanOrEqual(1);

        // Advance time by retry delay (5 minutes) to trigger retry
        timeControl.advanceTime(5 * 60 * 1000); // 5 minutes
        await schedulerControl.waitForNextCycleEnd();

        // Should have retried the failed task
        expect(executionCount).toBeGreaterThan(1);

        await capabilities.scheduler.stop();
    });

    test("should handle successful execution clearing retry state", async () => {
        const capabilities = getTestCapabilities();
        const schedulerControl = getSchedulerControl(capabilities);
        schedulerControl.setPollingInterval(1);
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = Duration.fromMillis(5 * 60 * 1000); // 5 minutes
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

        // Set a fixed starting time to 00:05:00 (so 00:00:00 was 5 minutes ago - will catch up)
        const startTime = 1704067500000 // 2024-01-01T00:05:00Z;
        timeControl.setTime(startTime);

        // Initialize scheduler with fast polling
        await capabilities.scheduler.initialize(registrations);

        // Wait for initial execution (should NOT execute immediately on first startup)
        await schedulerControl.waitForNextCycleEnd();
        expect(executionCount).toBe(0);

        // Advance to next scheduled time (00:15:00) to trigger first execution
        timeControl.advanceTime(10 * 60 * 1000); // 10 minutes to reach 00:15:00
        await schedulerControl.waitForNextCycleEnd();
        expect(executionCount).toBe(1);

        // Advance time by retry delay to trigger retry
        timeControl.advanceTime(5 * 60 * 1000); // 5 minutes
        await schedulerControl.waitForNextCycleEnd();

        // Should have executed successfully
        expect(executionCount).toBe(2);
        expect(task).toHaveBeenCalledTimes(2);

        await capabilities.scheduler.stop();
    });

    test("should handle multiple tasks with different retry delays", async () => {
        const capabilities = getTestCapabilities();
        const schedulerControl = getSchedulerControl(capabilities);
        schedulerControl.setPollingInterval(1);
        const timeControl = getDatetimeControl(capabilities);
        const shortRetryDelay = Duration.fromMillis(3 * 60 * 1000); // 3 minutes
        const longRetryDelay = Duration.fromMillis(8 * 60 * 1000); // 8 minutes

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

        // Set a fixed starting time to 00:05:00 (so 00:00:00 was 5 minutes ago - will catch up)
        const startTime = 1704067500000 // 2024-01-01T00:05:00Z;
        timeControl.setTime(startTime);

        // Initialize scheduler with fast polling
        await capabilities.scheduler.initialize(registrations);

        // Wait for initial executions (should NOT execute immediately on first startup)
        await schedulerControl.waitForNextCycleEnd();
        
        // Verify both tasks have NOT executed yet
        expect(task1Count).toBe(0);
        expect(task2Count).toBe(0);

        // Advance to next scheduled time (00:15:00) to trigger executions
        timeControl.advanceTime(10 * 60 * 1000); // 10 minutes to reach 00:15:00
        await schedulerControl.waitForNextCycleEnd();
        
        // Verify both tasks executed at least once
        expect(task1Count).toBeGreaterThanOrEqual(1);
        expect(task2Count).toBeGreaterThanOrEqual(1);

        // Verify that the scheduler correctly handles multiple tasks with different configurations
        await capabilities.state.transaction(async (storage) => {
            const currentState = await storage.getExistingState();
            expect(currentState).not.toBeNull();
            expect(currentState.tasks).toHaveLength(2);
            
            // Tasks should be registered with correct retry delays
            const tasks = currentState.tasks;
            const retryDelays = tasks.map(task => task.retryDelayMs).sort((a, b) => a - b);
            expect(retryDelays).toEqual([3 * 60 * 1000, 8 * 60 * 1000]);
        });

        await capabilities.scheduler.stop();
    });

    test("should maintain idempotent behavior on multiple initialize calls", async () => {
        const capabilities = getTestCapabilities();
        const schedulerControl = getSchedulerControl(capabilities);
        const timeControl = getDatetimeControl(capabilities);
        schedulerControl.setPollingInterval(1);
        const retryDelay = Duration.fromMillis(30 * 1000); // 30 seconds
        let executionCount = 0;

        const task = jest.fn(() => {
            executionCount++;
        });

        const registrations = [
            ["idempotent-test", "0 * * * *", task, retryDelay]
        ];

        // Multiple initialize calls should be idempotent
        await capabilities.scheduler.initialize(registrations);
        await capabilities.scheduler.initialize(registrations);
        await capabilities.scheduler.initialize(registrations);

        // Wait for execution (should NOT execute immediately on first startup)
        await schedulerControl.waitForNextCycleEnd();

        // Should not execute despite multiple initialize calls (new behavior)
        expect(executionCount).toBe(0);
        expect(task).toHaveBeenCalledTimes(0);

        // Advance to next scheduled time to verify normal execution works
        timeControl.advanceTime(60 * 60 * 1000); // 1 hour to reach 01:00:00
        await schedulerControl.waitForNextCycleEnd();

        // Should execute exactly once at scheduled time
        expect(executionCount).toBe(1);
        expect(task).toHaveBeenCalledTimes(1);

        await capabilities.scheduler.stop();
    });
});
