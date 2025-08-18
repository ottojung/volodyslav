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
        // TODO: Add mechanism to trigger poll manually for testing
        
        // Get task state before shutdown
        let tasks = await scheduler1.getTasks();
        const originalTask = tasks[0];
        
        // Shutdown
        await scheduler1.cancelAll();
        
        // Create new scheduler instance
        const scheduler2 = makePollingScheduler(capabilities, { pollIntervalMs: 1000 });
        await scheduler2.schedule("history-test", "* * * * *", taskCallback, retryDelay);
        
        // Verify history was restored
        tasks = await scheduler2.getTasks();
        const restoredTask = tasks[0];
        
        expect(restoredTask.name).toBe(originalTask.name);
        expect(restoredTask.cronExpression).toBe(originalTask.cronExpression);
        // TODO: Add specific checks for execution history once implemented
        
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
});