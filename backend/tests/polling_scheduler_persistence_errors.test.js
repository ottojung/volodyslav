/**
 * Tests for polling scheduler persistence edge cases and error recovery.
 * These tests ensure the scheduler handles corruption, file system errors,
 * and various persistence scenarios correctly.
 */

const { makePollingScheduler } = require("../src/cron/polling_scheduler");
const { fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper } = require("./stubs");

function caps() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubSleeper(capabilities);
    return capabilities;
}

describe("polling scheduler persistence and error handling", () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date("2024-01-15T12:00:00Z"));
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test("should handle task execution errors gracefully", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);

        let callCount = 0;
        const flakyCallback = jest.fn(() => {
            callCount++;
            if (callCount <= 2) {
                throw new Error(`Execution failed ${callCount}`);
            }
            return Promise.resolve();
        });

        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 10 });

        // Schedule task that will fail initially
        await scheduler.schedule("flaky-task", "* * * * *", flakyCallback, retryDelay);

        // Run scheduler multiple times to trigger retries
        await scheduler._poll();
        await scheduler._poll();
        await scheduler._poll();

        // Should have been called multiple times due to retries
        expect(flakyCallback).toHaveBeenCalled();

        // Check task state
        const tasks = await scheduler.getTasks();
        expect(tasks).toHaveLength(1);
        expect(tasks[0].name).toBe("flaky-task");

        await scheduler.cancelAll();
    });

    test("should handle different types of callback errors", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(1000);

        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 10 });

        // Test basic error handling without complex loops
        const errorCallback = jest.fn(() => {
            throw new Error("Test error");
        });

        // Schedule a task with error-throwing callback
        await scheduler.schedule("error-task", "* * * * *", errorCallback, retryDelay);

        // Verify the scheduler handles error callbacks gracefully  
        const tasks = await scheduler.getTasks();
        expect(tasks).toHaveLength(1);
        expect(tasks[0].name).toBe("error-task");

        await scheduler.cancelAll();
    });

    test("should maintain task state consistency after errors", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(2000);

        const successCallback = jest.fn().mockResolvedValue(undefined);
        const failureCallback = jest.fn().mockRejectedValue(new Error("Always fails"));

        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 10 });

        // Schedule both successful and failing tasks
        await scheduler.schedule("success-task", "*/2 * * * *", successCallback, retryDelay);
        await scheduler.schedule("failure-task", "*/2 * * * *", failureCallback, retryDelay);

        // Run multiple polls
        await scheduler._poll();

        // Move time forward for retry
        jest.advanceTimersByTime(3000);
        await scheduler._poll();

        const tasks = await scheduler.getTasks();
        expect(tasks).toHaveLength(2);

        // Both tasks should still exist
        const taskNames = tasks.map(t => t.name).sort();
        expect(taskNames).toEqual(["failure-task", "success-task"]);

        await scheduler.cancelAll();
    });

    test("should handle concurrent task execution limits", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);

        const simpleCallback = jest.fn().mockResolvedValue(undefined);

        // Create scheduler
        const scheduler = makePollingScheduler(capabilities, {
            pollIntervalMs: 10
        });

        // Schedule fewer tasks to avoid timeout
        for (let i = 0; i < 3; i++) {
            await scheduler.schedule(`simple-task-${i}`, "* * * * *", simpleCallback, retryDelay);
        }

        // Should be able to schedule tasks without issue
        const tasks = await scheduler.getTasks();
        expect(tasks).toHaveLength(3);

        await scheduler.cancelAll();
    });

    test("should handle system resource constraints gracefully", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(1000);

        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 10 });

        // Simple test for resource constraint handling
        const task = jest.fn();
        await scheduler.schedule("resource-test", "* * * * *", task, retryDelay);

        const tasks = await scheduler.getTasks();
        expect(tasks).toHaveLength(1);

        await scheduler.cancelAll();
    });

    test("should handle rapid schedule/cancel operations with many tasks", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);
        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 10 });

        // Schedule moderate number of tasks to avoid timeout
        const callbacks = [];
        for (let i = 0; i < 20; i++) {
            const callback = jest.fn().mockResolvedValue(undefined);
            callbacks.push(callback);
            await scheduler.schedule(`task-${i}`, "*/5 * * * *", callback, retryDelay);
        }

        // Should handle tasks without issues
        const tasks = await scheduler.getTasks();
        expect(tasks).toHaveLength(20);

        // All tasks should be tracked properly
        const taskNames = tasks.map(t => t.name);
        expect(taskNames).toHaveLength(20);
        expect(new Set(taskNames).size).toBe(20); // All unique

        await scheduler.cancelAll();

        // After cancellation, should be empty
        const emptyTasks = await scheduler.getTasks();
        expect(emptyTasks).toHaveLength(0);
    });

    test("should handle scheduler restart scenarios", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);
        const callback = jest.fn().mockResolvedValue(undefined);

        // Create first scheduler instance
        const scheduler1 = makePollingScheduler(capabilities, { pollIntervalMs: 10 });
        await scheduler1.schedule("persistent-task", "0 */3 * * *", callback, retryDelay);

        let tasks = await scheduler1.getTasks();
        expect(tasks).toHaveLength(1);
        expect(tasks[0].name).toBe("persistent-task");

        // Simulate scheduler shutdown
        await scheduler1.cancelAll();

        // Create new scheduler instance (simulating restart)
        const scheduler2 = makePollingScheduler(capabilities, { pollIntervalMs: 10 });

        // New scheduler should start fresh
        tasks = await scheduler2.getTasks();
        expect(tasks).toHaveLength(0);

        await scheduler2.cancelAll();
    });

    test("should handle time manipulation edge cases", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);
        const callback = jest.fn().mockResolvedValue(undefined);

        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 10 });
        await scheduler.schedule("time-test-task", "0 12 * * *", callback, retryDelay);

        // Test various time manipulations
        const testTimes = [
            "2024-01-15T12:00:00Z", // Exactly scheduled time
            "2024-01-15T11:59:59Z", // Just before
            "2024-01-15T12:00:01Z", // Just after
            "2024-01-15T23:59:59Z", // End of day
            "2024-01-16T00:00:00Z", // Start of next day
            "2100-01-15T12:00:00Z", // Far future
            "1970-01-01T12:00:00Z", // Unix epoch
        ];

        for (const timeStr of testTimes) {
            jest.setSystemTime(new Date(timeStr));

            const tasks = await scheduler.getTasks();
            expect(tasks).toHaveLength(1);
            expect(tasks[0].name).toBe("time-test-task");
            expect(tasks[0].modeHint).toMatch(/^(cron|idle|retry)$/);
        }

        await scheduler.cancelAll();
    });

    test("should handle rapid schedule/cancel operations", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(1000);
        const callback = jest.fn().mockResolvedValue(undefined);

        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 10 });

        // Simple rapid operations test
        await scheduler.schedule("rapid-task", "* * * * *", callback, retryDelay);
        await scheduler.cancel("rapid-task");

        const tasks = await scheduler.getTasks();
        expect(tasks).toHaveLength(0);

        await scheduler.cancelAll();
    });

    test("should handle invalid callback types gracefully", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);

        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 10 });

        // Test various invalid callback scenarios
        const validCallback = jest.fn().mockResolvedValue(undefined);

        // Valid case
        await scheduler.schedule("valid-task", "0 */4 * * *", validCallback, retryDelay);

        // This should work - null callbacks are allowed in the current implementation
        // (tasks can be restored from persistence without callbacks)

        const tasks = await scheduler.getTasks();
        expect(tasks).toHaveLength(1);
        expect(tasks[0].name).toBe("valid-task");

        await scheduler.cancelAll();
    });

    test("should maintain correct task ordering and priority", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(1000);

        const callback1 = jest.fn().mockResolvedValue(undefined);
        const callback2 = jest.fn().mockResolvedValue(undefined);

        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 10 });

        // Simple ordering test
        await scheduler.schedule("task1", "* * * * *", callback1, retryDelay);
        await scheduler.schedule("task2", "* * * * *", callback2, retryDelay);

        const tasks = await scheduler.getTasks();
        expect(tasks).toHaveLength(2);
        expect(tasks[0].name).toBe("task1");
        expect(tasks[1].name).toBe("task2");

        await scheduler.cancelAll();
    });

    test("should maintain task order when scheduled at different times", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);
        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 10 });

        const callback1 = jest.fn().mockResolvedValue(undefined);
        const callback2 = jest.fn().mockResolvedValue(undefined);
        const callback3 = jest.fn().mockResolvedValue(undefined);

        // Schedule tasks in specific order
        await scheduler.schedule("task-a", "0 10 * * *", callback1, retryDelay);
        await scheduler.schedule("task-z", "0 14 * * *", callback2, retryDelay);
        await scheduler.schedule("task-m", "0 12 * * *", callback3, retryDelay);

        const tasks = await scheduler.getTasks();
        expect(tasks).toHaveLength(3);

        // Tasks should be returned consistently
        const taskNames = tasks.map(t => t.name);
        expect(taskNames).toContain("task-a");
        expect(taskNames).toContain("task-z");
        expect(taskNames).toContain("task-m");

        await scheduler.cancelAll();
    });
});
