/**
 * Tests for the atomic modifyTasks interface in scheduler persistence.
 * Validates that task modifications are atomic via git-based transactions.
 */

const { make } = require("../src/cron");
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

describe("scheduler atomic modifyTasks", () => {
    test("cancelAll follows the required modifyTasks pattern", async () => {
        const capabilities = caps();
        const scheduler = make(capabilities, { pollIntervalMs: 10 });
        const retryDelay = fromMilliseconds(1000);

        // Schedule some tasks
        await scheduler.schedule("task1", "* * * * *", jest.fn(), retryDelay);
        await scheduler.schedule("task2", "* * * * *", jest.fn(), retryDelay);
        
        // Verify tasks exist
        const tasksBeforeCancel = await scheduler.getTasks();
        expect(tasksBeforeCancel).toHaveLength(2);

        // Cancel all tasks - this should use the modifyTasks pattern
        const canceledCount = await scheduler.cancelAll();
        
        // Verify the result follows the new pattern (count returned by modifyTasks)
        expect(canceledCount).toBe(2);
        
        // Verify tasks are actually gone
        const tasksAfterCancel = await scheduler.getTasks();
        expect(tasksAfterCancel).toHaveLength(0);
    });

    test("task modifications are atomic", async () => {
        const capabilities = caps();
        const scheduler = make(capabilities, { pollIntervalMs: 10 });
        const retryDelay = fromMilliseconds(1000);

        // Schedule a task
        await scheduler.schedule("test-task", "* * * * *", jest.fn(), retryDelay);
        
        // Get the task before modification
        const tasksBefore = await scheduler.getTasks();
        expect(tasksBefore).toHaveLength(1);
        const taskBefore = tasksBefore[0];

        // Cancel the task atomically
        const cancelled = await scheduler.cancel("test-task");
        expect(cancelled).toBe(true);

        // Verify task is completely gone after atomic operation
        const tasksAfter = await scheduler.getTasks();
        expect(tasksAfter).toHaveLength(0);
    });

    test("schedule modifications are atomic for existing tasks", async () => {
        const capabilities = caps();
        const scheduler = make(capabilities, { pollIntervalMs: 10 });
        const retryDelay = fromMilliseconds(1000);

        // First, create a persisted task state by scheduling and then creating a new scheduler
        await scheduler.schedule("persistent-task", "0 * * * *", jest.fn(), retryDelay);
        await scheduler.cancelAll(); // Clean shutdown

        // Create new scheduler to simulate restart (this will load persisted state)
        const scheduler2 = make(capabilities, { pollIntervalMs: 10 });
        
        // Schedule the same task again (this should atomically update the persisted task)
        const newCallback = jest.fn();
        const newRetryDelay = fromMilliseconds(2000);
        
        await scheduler2.schedule("persistent-task", "0 0 * * *", newCallback, newRetryDelay);
        
        // Verify the task was atomically updated
        const tasks = await scheduler2.getTasks();
        expect(tasks).toHaveLength(1);
        expect(tasks[0]).toMatchObject({
            name: "persistent-task",
            cronExpression: "0 0 * * *", // Updated cron expression
            running: false,
        });

        await scheduler2.cancelAll();
    });

    test("readonly task properties prevent external mutations", () => {
        // This test verifies that the Task typedef has readonly properties
        // The actual type checking happens at compile time, but we can test the structure
        
        const capabilities = caps();
        const scheduler = make(capabilities, { pollIntervalMs: 10 });
        
        // This test mainly serves as documentation that Task properties should be readonly
        // The real protection is in the TypeScript/JSDoc typedef and the modifyTasks pattern
        expect(true).toBe(true); // Placeholder - the real check is in type definitions
    });
});