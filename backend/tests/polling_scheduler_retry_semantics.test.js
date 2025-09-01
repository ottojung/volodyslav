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
        const startTime = new Date("2024-01-01T00:05:00Z").getTime();
        timeControl.setTime(startTime);

        // Initialize with fast polling for tests
        await capabilities.scheduler.initialize(registrations);

        // Wait for scheduler to start and catch up (will execute for 00:00:00)
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
        const startTime = new Date("2024-01-01T00:05:00Z").getTime();
        timeControl.setTime(startTime);

        // Initialize scheduler with fast polling for tests
        await capabilities.scheduler.initialize(registrations);

        // Wait for initial execution and catch-up
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
        const startTime = new Date("2024-01-01T00:05:00Z").getTime();
        timeControl.setTime(startTime);

        // Initialize scheduler with fast polling
        await capabilities.scheduler.initialize(registrations);

        // Wait for initial execution (catch up for 00:00:00)
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
        const startTime = new Date("2024-01-01T00:05:00Z").getTime();
        timeControl.setTime(startTime);

        // Initialize scheduler with fast polling
        await capabilities.scheduler.initialize(registrations);

        // Wait for initial executions (catch up for 00:00:00)
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

        // Wait for execution
        await schedulerControl.waitForNextCycleEnd();

        // Should only execute once despite multiple initialize calls
        expect(executionCount).toBe(1);
        expect(task).toHaveBeenCalledTimes(1);

        await capabilities.scheduler.stop();
    });
});
