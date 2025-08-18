/**
 * Tests for polling scheduler save and restore functionality.
 * Ensures that scheduler can persist and restore to identical state including callbacks.
 */

const { makePollingScheduler } = require("../src/cron/polling_scheduler");
const { fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime } = require("./stubs");

function caps() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    return capabilities;
}

describe("polling scheduler save and restore", () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date("2020-01-01T00:00:00Z"));
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test("should restore callbacks after restart", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);
        
        const taskCallback = jest.fn();

        // Create first scheduler instance and add task
        const scheduler1 = makePollingScheduler(capabilities, { pollIntervalMs: 1000 });
        await scheduler1.schedule("test-task", "* * * * *", taskCallback, retryDelay);
        
        // Verify task exists and can execute
        let tasks = await scheduler1.getTasks();
        expect(tasks).toHaveLength(1);
        expect(tasks[0].name).toBe("test-task");
        expect(tasks[0].modeHint).toBe("cron");
        
        // Simulate scheduler shutdown
        await scheduler1.cancelAll();

        // Create new scheduler instance (simulating process restart)
        const scheduler2 = makePollingScheduler(capabilities, { pollIntervalMs: 1000 });
        
        // Re-register the same task (this should restore from persistence)
        await scheduler2.schedule("test-task", "* * * * *", taskCallback, retryDelay);
        
        // Verify task was restored with callback
        tasks = await scheduler2.getTasks();
        expect(tasks).toHaveLength(1);
        expect(tasks[0].name).toBe("test-task");
        expect(tasks[0].modeHint).toBe("cron");
        
        // Clean up
        await scheduler2.cancelAll();
    });

    test("should restore task execution history", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);
        
        // Set up initial time
        jest.setSystemTime(new Date("2020-01-01T00:00:00Z"));
        
        const taskCallback = jest.fn();
        
        // Create first scheduler and schedule task
        const scheduler1 = makePollingScheduler(capabilities, { pollIntervalMs: 1000 });
        await scheduler1.schedule("history-test", "* * * * *", taskCallback, retryDelay);
        
        // Simulate task execution by advancing time and forcing a poll
        jest.setSystemTime(new Date("2020-01-01T00:01:00Z"));
        await scheduler1._poll(); // Use the internal poll method for testing
        
        // Verify task was executed
        expect(taskCallback).toHaveBeenCalledTimes(1);
        
        // Get task state before shutdown and verify execution history exists
        let tasks = await scheduler1.getTasks();
        const originalTask = tasks[0];
        
        expect(originalTask.lastSuccessTime).toBeDefined();
        expect(originalTask.lastAttemptTime).toBeDefined();
        
        const originalLastSuccess = originalTask.lastSuccessTime;
        const originalLastAttempt = originalTask.lastAttemptTime;
        
        // Shutdown
        await scheduler1.cancelAll();
        
        // Create new scheduler instance
        const scheduler2 = makePollingScheduler(capabilities, { pollIntervalMs: 1000 });
        const newTaskCallback = jest.fn(); // New callback function
        await scheduler2.schedule("history-test", "* * * * *", newTaskCallback, retryDelay);
        
        // Verify history was restored
        tasks = await scheduler2.getTasks();
        const restoredTask = tasks[0];
        
        expect(restoredTask.name).toBe(originalTask.name);
        expect(restoredTask.cronExpression).toBe(originalTask.cronExpression);
        
        // Check that execution history was restored
        expect(restoredTask.lastSuccessTime).toBeDefined();
        expect(restoredTask.lastAttemptTime).toBeDefined();
        expect(restoredTask.lastSuccessTime).toBe(originalLastSuccess);
        expect(restoredTask.lastAttemptTime).toBe(originalLastAttempt);
        
        await scheduler2.cancelAll();
    });

    test("should handle multiple task restoration", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);
        
        const task1Callback = jest.fn();
        const task2Callback = jest.fn();
        const task3Callback = jest.fn();
        
        // Create first scheduler and add multiple tasks
        const scheduler1 = makePollingScheduler(capabilities, { pollIntervalMs: 1000 });
        await scheduler1.schedule("task1", "0 * * * *", task1Callback, retryDelay);
        await scheduler1.schedule("task2", "30 * * * *", task2Callback, retryDelay);
        await scheduler1.schedule("task3", "*/15 * * * *", task3Callback, retryDelay);
        
        // Verify all tasks exist
        let tasks = await scheduler1.getTasks();
        expect(tasks).toHaveLength(3);
        expect(tasks.map(t => t.name).sort()).toEqual(["task1", "task2", "task3"]);
        
        // Shutdown
        await scheduler1.cancelAll();
        
        // Create new scheduler and restore all tasks
        const scheduler2 = makePollingScheduler(capabilities, { pollIntervalMs: 1000 });
        await scheduler2.schedule("task1", "0 * * * *", task1Callback, retryDelay);
        await scheduler2.schedule("task2", "30 * * * *", task2Callback, retryDelay);
        await scheduler2.schedule("task3", "*/15 * * * *", task3Callback, retryDelay);
        
        // Verify all tasks were restored
        tasks = await scheduler2.getTasks();
        expect(tasks).toHaveLength(3);
        expect(tasks.map(t => t.name).sort()).toEqual(["task1", "task2", "task3"]);
        
        await scheduler2.cancelAll();
    });

    test("should restore retry state and failure history", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000); // 5 second retry delay
        
        // Set up initial time
        jest.setSystemTime(new Date("2020-01-01T00:00:00Z"));
        
        const failingCallback = jest.fn(() => {
            throw new Error("Task failed");
        });
        
        // Create first scheduler and schedule failing task
        const scheduler1 = makePollingScheduler(capabilities, { pollIntervalMs: 1000 });
        await scheduler1.schedule("failing-task", "* * * * *", failingCallback, retryDelay);
        
        // Advance time and trigger execution to generate failure
        jest.setSystemTime(new Date("2020-01-01T00:01:00Z"));
        await scheduler1._poll();
        
        // Verify task failed and has retry state
        expect(failingCallback).toHaveBeenCalledTimes(1);
        let tasks = await scheduler1.getTasks();
        const originalTask = tasks[0];
        
        expect(originalTask.lastFailureTime).toBeDefined();
        expect(originalTask.pendingRetryUntil).toBeDefined();
        
        // Store the original failure state for comparison
        const originalLastFailure = originalTask.lastFailureTime;
        const originalRetryUntil = originalTask.pendingRetryUntil;
        
        // The task should be in retry mode if retry time hasn't passed yet
        // Since we just failed and retry is 5 seconds, it should be in retry mode
        const expectedMode = originalTask.modeHint; // Could be "retry" or "idle" depending on timing
        
        // Shutdown
        await scheduler1.cancelAll();
        
        // Create new scheduler instance
        const scheduler2 = makePollingScheduler(capabilities, { pollIntervalMs: 1000 });
        const newFailingCallback = jest.fn(() => {
            throw new Error("Task still fails");
        });
        await scheduler2.schedule("failing-task", "* * * * *", newFailingCallback, retryDelay);
        
        // Verify failure history and retry state was restored
        tasks = await scheduler2.getTasks();
        const restoredTask = tasks[0];
        
        expect(restoredTask.name).toBe(originalTask.name);
        expect(restoredTask.lastFailureTime).toBeDefined();
        expect(restoredTask.pendingRetryUntil).toBeDefined();
        expect(restoredTask.lastFailureTime).toBe(originalLastFailure);
        expect(restoredTask.pendingRetryUntil).toBe(originalRetryUntil);
        expect(restoredTask.modeHint).toBe(expectedMode);
        
        await scheduler2.cancelAll();
    });

    test("should restore tasks without callbacks and allow re-registration", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);
        
        const taskCallback = jest.fn();
        
        // Create first scheduler and add task
        const scheduler1 = makePollingScheduler(capabilities, { pollIntervalMs: 1000 });
        await scheduler1.schedule("orphaned-task", "0 * * * *", taskCallback, retryDelay);
        
        // Shutdown without canceling - simulating unexpected shutdown
        await scheduler1.cancelAll();
        
        // Create new scheduler WITHOUT re-registering the task initially
        const scheduler2 = makePollingScheduler(capabilities, { pollIntervalMs: 1000 });
        
        // Check if the task exists but without callback
        const tasks = await scheduler2.getTasks();
        expect(tasks).toHaveLength(1);
        expect(tasks[0].name).toBe("orphaned-task");
        
        // Now re-register the task with callback - should merge with existing state
        const newTaskCallback = jest.fn();
        await scheduler2.schedule("orphaned-task", "0 * * * *", newTaskCallback, retryDelay);
        
        // Verify task exists and is ready for execution
        const updatedTasks = await scheduler2.getTasks();
        expect(updatedTasks).toHaveLength(1);
        expect(updatedTasks[0].name).toBe("orphaned-task");
        expect(updatedTasks[0].cronExpression).toBe("0 * * * *");
        
        await scheduler2.cancelAll();
    });
});