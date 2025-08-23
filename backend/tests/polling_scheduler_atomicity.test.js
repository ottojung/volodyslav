/**
 * Tests that expose non-atomicity issues in the polling scheduler.
 * These tests should fail due to race conditions in state persistence.
 */

const { makePollingScheduler } = require("../src/cron/polling_scheduler");
const { fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper, getDatetimeControl, stubPollInterval } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubSleeper(capabilities);
    // Don't stub runtime state storage - use real transactions to expose race condition!
    stubPollInterval(1); // Very fast polling for tests
    return capabilities;
}

describe("polling scheduler atomicity exposure", () => {
    test("exposes race condition in concurrent task state persistence", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = fromMilliseconds(30000); // 30 second retry delay

        const scheduler = makePollingScheduler(capabilities);
        
        // Track task executions
        let task1Executed = false;
        let task2Executed = false;
        let task3Executed = false;
        let task4Executed = false;

        // Create tasks that complete at nearly the same time
        const task1 = jest.fn(async () => {
            // Add a tiny bit of async processing
            await new Promise(resolve => setImmediate(resolve));
            task1Executed = true;
        });

        const task2 = jest.fn(async () => {
            await new Promise(resolve => setImmediate(resolve));
            task2Executed = true;
        });

        const task3 = jest.fn(async () => {
            await new Promise(resolve => setImmediate(resolve));
            task3Executed = true;
        });

        const task4 = jest.fn(async () => {
            await new Promise(resolve => setImmediate(resolve));
            task4Executed = true;
        });

        // Set time to trigger immediate execution (start of hour)
        const startTime = new Date("2024-01-01T10:00:00.000Z").getTime();
        timeControl.setTime(startTime);

        // Schedule all tasks with the same cron expression for simultaneous execution
        await scheduler.schedule("concurrent-task-1", "0 * * * *", task1, retryDelay);
        await scheduler.schedule("concurrent-task-2", "0 * * * *", task2, retryDelay);
        await scheduler.schedule("concurrent-task-3", "0 * * * *", task3, retryDelay);
        await scheduler.schedule("concurrent-task-4", "0 * * * *", task4, retryDelay);

        // Wait for all tasks to complete
        await new Promise(resolve => setTimeout(resolve, 200));

        // Verify all tasks executed
        expect(task1Executed).toBe(true);
        expect(task2Executed).toBe(true);
        expect(task3Executed).toBe(true);
        expect(task4Executed).toBe(true);

        // Get task states to verify persistence
        const finalTasks = await scheduler.getTasks();
        expect(finalTasks).toHaveLength(4);

        // All tasks should have their execution state properly persisted
        // The race condition might cause some state updates to be lost
        const tasksWithSuccess = finalTasks.filter(t => t.lastSuccessTime);
        const tasksWithAttempt = finalTasks.filter(t => t.lastAttemptTime);

        // This test should expose the race condition by showing that not all
        // task state updates are properly persisted
        expect(tasksWithSuccess).toHaveLength(4);
        expect(tasksWithAttempt).toHaveLength(4);

        await scheduler.cancelAll();
    });

    test("exposes state loss with mixed success and failure concurrent execution", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = fromMilliseconds(15000); // 15 second retry delay

        const scheduler = makePollingScheduler(capabilities);
        
        let successTaskCompleted = false;
        let failTaskCompleted = false;

        // One task succeeds, one fails - executing concurrently
        const successTask = jest.fn(async () => {
            await new Promise(resolve => setImmediate(resolve));
            successTaskCompleted = true;
        });

        const failTask = jest.fn(async () => {
            await new Promise(resolve => setImmediate(resolve));
            failTaskCompleted = true;
            throw new Error("Intentional task failure for atomicity test");
        });

        // Set time to trigger immediate execution
        const startTime = new Date("2024-01-01T12:00:00.000Z").getTime();
        timeControl.setTime(startTime);

        // Schedule both tasks to execute at the same time
        await scheduler.schedule("success-task", "0 * * * *", successTask, retryDelay);
        await scheduler.schedule("fail-task", "0 * * * *", failTask, retryDelay);

        // Wait for both tasks to complete
        await new Promise(resolve => setTimeout(resolve, 100));

        expect(successTaskCompleted).toBe(true);
        expect(failTaskCompleted).toBe(true);

        // Get final states
        const finalTasks = await scheduler.getTasks();
        expect(finalTasks).toHaveLength(2);

        const successTaskState = finalTasks.find(t => t.name === "success-task");
        const failTaskState = finalTasks.find(t => t.name === "fail-task");

        expect(successTaskState).toBeDefined();
        expect(failTaskState).toBeDefined();

        // Both tasks should have their execution states properly persisted
        // The race condition can cause one task's state update to be lost
        expect(successTaskState.lastSuccessTime).toBeDefined();
        expect(successTaskState.lastAttemptTime).toBeDefined();
        
        expect(failTaskState.lastFailureTime).toBeDefined();
        expect(failTaskState.lastAttemptTime).toBeDefined();
        expect(failTaskState.pendingRetryUntil).toBeDefined();

        await scheduler.cancelAll();
    });

    test("exposes atomicity issues with high concurrency load", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = fromMilliseconds(60000); // 1 minute retry delay

        const scheduler = makePollingScheduler(capabilities);
        
        const taskCount = 10;
        const executionCounts = {};
        const tasks = [];

        // Create multiple tasks that will execute concurrently
        for (let i = 1; i <= taskCount; i++) {
            const taskName = `load-task-${i}`;
            executionCounts[taskName] = 0;
            
            const task = jest.fn(async () => {
                executionCounts[taskName]++;
                // No delay to maximize concurrency
            });
            
            tasks.push(task);
            
            // Schedule the task
            await scheduler.schedule(taskName, "0 * * * *", task, retryDelay);
        }

        // Set time to trigger immediate execution for all tasks
        const startTime = new Date("2024-01-01T14:00:00.000Z").getTime();
        timeControl.setTime(startTime);

        // Wait for all tasks to complete
        await new Promise(resolve => setTimeout(resolve, 250));

        // Verify all tasks executed
        for (let i = 1; i <= taskCount; i++) {
            const taskName = `load-task-${i}`;
            expect(executionCounts[taskName]).toBe(1);
        }

        // Get final states
        const finalTasks = await scheduler.getTasks();
        expect(finalTasks).toHaveLength(taskCount);

        // Critical test: ALL tasks should have their execution state persisted
        // Due to race conditions, some task state updates might be lost
        let tasksWithSuccessTime = 0;
        let tasksWithAttemptTime = 0;

        for (const taskState of finalTasks) {
            if (taskState.lastSuccessTime) {
                tasksWithSuccessTime++;
            }
            if (taskState.lastAttemptTime) {
                tasksWithAttemptTime++;
            }
        }

        // This assertion should fail due to non-atomic state persistence
        expect(tasksWithSuccessTime).toBe(taskCount);
        expect(tasksWithAttemptTime).toBe(taskCount);

        await scheduler.cancelAll();
    });
});