/**
 * Tests that expose non-atomicity issues in the scheduler.
 * These tests should fail due to race conditions in state persistence.
 */

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
    stubPollInterval(1); // Fast polling for tests
    return capabilities;
}

describe("scheduler non-atomicity exposure", () => {
    test("exposes state persistence race condition with concurrent task completions", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = fromMilliseconds(60000); // 1 minute retry delay

        // Track task executions and their completion times
        let task1CompletionTime = null;
        let task2CompletionTime = null;
        let task3CompletionTime = null;

        // Create tasks that complete at nearly the same time
        const task1 = jest.fn(async () => {
            // Simulate some work with a small delay
            await new Promise(resolve => setTimeout(resolve, 5));
            task1CompletionTime = Date.now();
        });

        const task2 = jest.fn(async () => {
            // Simulate some work with a similar small delay
            await new Promise(resolve => setTimeout(resolve, 5));
            task2CompletionTime = Date.now();
        });

        const task3 = jest.fn(async () => {
            // Simulate some work with a similar small delay
            await new Promise(resolve => setTimeout(resolve, 5));
            task3CompletionTime = Date.now();
        });

        const registrations = [
            ["concurrent-task-1", "0 * * * *", task1, retryDelay],
            ["concurrent-task-2", "0 * * * *", task2, retryDelay],
            ["concurrent-task-3", "0 * * * *", task3, retryDelay]
        ];

        // Set time to trigger immediate execution (start of hour)
        const startTime = new Date("2024-01-01T10:00:00.000Z").getTime();
        timeControl.setTime(startTime);

        await capabilities.scheduler.initialize(registrations);

        // Wait for all tasks to complete
        await new Promise(resolve => setTimeout(resolve, 100));

        // Verify all tasks were executed
        expect(task1).toHaveBeenCalled();
        expect(task2).toHaveBeenCalled();
        expect(task3).toHaveBeenCalled();

        // Verify tasks completed around the same time (concurrency)
        expect(task1CompletionTime).toBeDefined();
        expect(task2CompletionTime).toBeDefined();
        expect(task3CompletionTime).toBeDefined();

        // Get final task states to verify persistence
        const finalState = await capabilities.state.transaction(async (storage) => {
            return await storage.getCurrentState();
        });
        
        // All tasks should have successful execution recorded
        expect(finalState.tasks).toHaveLength(3);
        
        const task1State = finalState.tasks.find(t => t.name === "concurrent-task-1");
        const task2State = finalState.tasks.find(t => t.name === "concurrent-task-2");
        const task3State = finalState.tasks.find(t => t.name === "concurrent-task-3");

        expect(task1State).toBeDefined();
        expect(task2State).toBeDefined();
        expect(task3State).toBeDefined();

        // The critical assertion: ALL tasks should have their success states persisted
        // This test will fail due to race conditions where concurrent persistState() calls
        // can overwrite each other's state updates
        expect(task1State.lastSuccessTime).toBeDefined();
        expect(task2State.lastSuccessTime).toBeDefined();
        expect(task3State.lastSuccessTime).toBeDefined();

        // Additional verification that last attempt time is also persisted for all
        expect(task1State.lastAttemptTime).toBeDefined();
        expect(task2State.lastAttemptTime).toBeDefined();
        expect(task3State.lastAttemptTime).toBeDefined();

        await capabilities.scheduler.stop();
    });

    test("exposes state loss in concurrent failure and success scenarios", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = fromMilliseconds(30000); // 30 second retry delay

        let successTaskCompleted = false;
        let failureTaskCompleted = false;

        // One task succeeds, one fails - both complete concurrently
        const successTask = jest.fn(async () => {
            await new Promise(resolve => setTimeout(resolve, 10));
            successTaskCompleted = true;
        });

        const failureTask = jest.fn(async () => {
            await new Promise(resolve => setTimeout(resolve, 10));
            failureTaskCompleted = true;
            throw new Error("Intentional task failure");
        });

        const registrations = [
            ["success-task", "0 * * * *", successTask, retryDelay],
            ["failure-task", "0 * * * *", failureTask, retryDelay]
        ];

        // Set time to trigger immediate execution
        const startTime = new Date("2024-01-01T12:00:00.000Z").getTime();
        timeControl.setTime(startTime);

        await capabilities.scheduler.initialize(registrations);

        // Wait for both tasks to complete
        await new Promise(resolve => setTimeout(resolve, 100));

        expect(successTaskCompleted).toBe(true);
        expect(failureTaskCompleted).toBe(true);

        // Get final states
        const finalState = await capabilities.state.transaction(async (storage) => {
            return await storage.getCurrentState();
        });
        
        expect(finalState.tasks).toHaveLength(2);
        
        const successTaskState = finalState.tasks.find(t => t.name === "success-task");
        const failureTaskState = finalState.tasks.find(t => t.name === "failure-task");

        expect(successTaskState).toBeDefined();
        expect(failureTaskState).toBeDefined();

        // Both tasks should have their execution states properly persisted
        // The race condition can cause one task's state update to be lost
        expect(successTaskState.lastSuccessTime).toBeDefined();
        expect(successTaskState.lastAttemptTime).toBeDefined();
        
        expect(failureTaskState.lastFailureTime).toBeDefined();
        expect(failureTaskState.lastAttemptTime).toBeDefined();
        expect(failureTaskState.pendingRetryUntil).toBeDefined();

        await capabilities.scheduler.stop();
    });

    test("exposes state corruption with high-concurrency task execution", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = fromMilliseconds(45000); // 45 second retry delay

        const taskCount = 12; // Even more tasks to increase race condition probability
        const executionCounts = {};
        const completionTimes = {};

        // Create multiple tasks that will execute concurrently
        const tasks = [];
        const registrations = [];

        for (let i = 1; i <= taskCount; i++) {
            const taskName = `concurrent-task-${i}`;
            executionCounts[taskName] = 0;
            
            const task = jest.fn(async () => {
                executionCounts[taskName]++;
                // No delay at all - maximize concurrency and race condition chance
                completionTimes[taskName] = Date.now();
            });
            
            tasks.push(task);
            registrations.push([taskName, "0 * * * *", task, retryDelay]);
        }

        // Set time to trigger immediate execution for all tasks
        const startTime = new Date("2024-01-01T15:00:00.000Z").getTime();
        timeControl.setTime(startTime);

        await capabilities.scheduler.initialize(registrations);

        // Wait for all tasks to complete
        await new Promise(resolve => setTimeout(resolve, 200));

        // Verify all tasks executed
        for (let i = 1; i <= taskCount; i++) {
            const taskName = `concurrent-task-${i}`;
            expect(executionCounts[taskName]).toBe(1);
            expect(completionTimes[taskName]).toBeDefined();
        }

        // Get final states
        const finalState = await capabilities.state.transaction(async (storage) => {
            return await storage.getCurrentState();
        });
        
        expect(finalState.tasks).toHaveLength(taskCount);

        // Critical test: ALL tasks should have their execution state persisted
        // Due to the race condition in state persistence, some tasks' state updates
        // will be lost when concurrent persistState() calls overwrite each other
        let tasksWithSuccessTime = 0;
        let tasksWithAttemptTime = 0;

        for (const taskState of finalState.tasks) {
            if (taskState.lastSuccessTime) {
                tasksWithSuccessTime++;
            }
            if (taskState.lastAttemptTime) {
                tasksWithAttemptTime++;
            }
        }

        // This assertion should fail due to the non-atomic state persistence
        // Some tasks' success/attempt times will be lost in the race condition
        expect(tasksWithSuccessTime).toBe(taskCount);
        expect(tasksWithAttemptTime).toBe(taskCount);

        await capabilities.scheduler.stop();
    });
});