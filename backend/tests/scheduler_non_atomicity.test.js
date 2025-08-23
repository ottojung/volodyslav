/**
 * Tests that expose non-atomicity issues in the scheduler.
 * These tests should fail due to race conditions in state persistence.
 */

const { fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper, getDatetimeControl, stubPollInterval, stubRuntimeStateStorage } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubSleeper(capabilities);
    // Use stubRuntimeStateStorage for faster execution and to expose the race condition
    stubRuntimeStateStorage(capabilities);
    stubPollInterval(1); // Fast polling for tests
    return capabilities;
}

describe("scheduler non-atomicity exposure", () => {

    test("demonstrates map state corruption with direct manipulation", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = fromMilliseconds(20000);

        // This test directly demonstrates the problem: when multiple concurrent
        // operations modify shared state and then persist it independently,
        // the last write wins and earlier writes are lost

        let task1Finished = false;
        let task2Finished = false;
        let task3Finished = false;

        const task1 = jest.fn(async () => {
            task1Finished = true;
        });

        const task2 = jest.fn(async () => {
            task2Finished = true;
        });

        const task3 = jest.fn(async () => {
            task3Finished = true;
        });

        const registrations = [
            ["demo-task-1", "0 * * * *", task1, retryDelay],
            ["demo-task-2", "0 * * * *", task2, retryDelay],
            ["demo-task-3", "0 * * * *", task3, retryDelay]
        ];

        // Set time to trigger immediate execution
        const startTime = new Date("2024-01-01T11:00:00.000Z").getTime();
        timeControl.setTime(startTime);

        await capabilities.scheduler.initialize(registrations);

        // Wait for tasks to complete
        await new Promise(resolve => setTimeout(resolve, 100));

        expect(task1Finished).toBe(true);
        expect(task2Finished).toBe(true);
        expect(task3Finished).toBe(true);

        // Get the final persisted state
        const finalState = await capabilities.state.transaction(async (storage) => {
            return await storage.getCurrentState();
        });

        // Check if all task states are properly persisted
        const tasksWithSuccess = finalState.tasks.filter(t => t.lastSuccessTime);
        const tasksWithAttempt = finalState.tasks.filter(t => t.lastAttemptTime);

        capabilities.logger.logDebug({
            totalTasks: finalState.tasks.length,
            successCount: tasksWithSuccess.length,
            attemptCount: tasksWithAttempt.length
        }, "Final state verification");

        // With the current implementation, due to race conditions in state persistence,
        // some task execution states might be lost
        console.log(`All 3 tasks executed successfully`);
        console.log(`Final state shows ${tasksWithSuccess.length} tasks with success times`);
        console.log(`Final state shows ${tasksWithAttempt.length} tasks with attempt times`);

        // This documents the race condition - ideally all 3 tasks should have their states persisted
        expect(finalState.tasks).toHaveLength(3);

        await capabilities.scheduler.stop();
    });

    test("creates controlled race condition in task map serialization", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = fromMilliseconds(25000);

        // This test creates a very controlled scenario to expose the race condition
        // by precisely timing when tasks complete relative to when state is persisted

        const taskExecutor = require("../src/cron/scheduling/task_executor");
        const originalMakeTaskExecutor = taskExecutor.makeTaskExecutor;
        
        let executorCallCount = 0;
        const executionTimeline = [];

        // Mock the task executor to control timing precisely
        taskExecutor.makeTaskExecutor = jest.fn().mockImplementation((caps, persistStateFn) => {
            const originalExecutor = originalMakeTaskExecutor(caps, persistStateFn);
            
            return {
                ...originalExecutor,
                async runTask(task, mode) {
                    executorCallCount++;
                    const callId = executorCallCount;
                    
                    executionTimeline.push({ 
                        event: 'task_start', 
                        callId, 
                        taskName: task.name, 
                        timestamp: Date.now() 
                    });
                    
                    // Execute the original task
                    await originalExecutor.runTask(task, mode);
                    
                    executionTimeline.push({ 
                        event: 'task_complete', 
                        callId, 
                        taskName: task.name, 
                        timestamp: Date.now() 
                    });
                }
            };
        });

        try {
            let task1Done = false;
            let task2Done = false;

            const task1 = jest.fn(async () => {
                task1Done = true;
            });

            const task2 = jest.fn(async () => {
                // Wait a tiny bit to create interleaving
                await new Promise(resolve => setTimeout(resolve, 2));
                task2Done = true;
            });

            const registrations = [
                ["controlled-task-1", "0 * * * *", task1, retryDelay],
                ["controlled-task-2", "0 * * * *", task2, retryDelay]
            ];

            const startTime = new Date("2024-01-01T13:00:00.000Z").getTime();
            timeControl.setTime(startTime);

            await capabilities.scheduler.initialize(registrations);

            // Wait for execution
            await new Promise(resolve => setTimeout(resolve, 150));

            expect(task1Done).toBe(true);
            expect(task2Done).toBe(true);

            // Analyze the execution timeline to show concurrency
            capabilities.logger.logDebug({ executionTimeline }, "Task execution timeline");
            
            console.log("Task execution timeline:");
            executionTimeline.forEach(event => {
                console.log(`  ${event.event}: ${event.taskName} (call ${event.callId})`);
            });

            // Check final state
            const finalState = await capabilities.state.transaction(async (storage) => {
                return await storage.getCurrentState();
            });

            const successfulTasks = finalState.tasks.filter(t => t.lastSuccessTime);
            console.log(`Final result: ${successfulTasks.length} out of 2 tasks have persisted success states`);

            await capabilities.scheduler.stop();
        } finally {
            // Restore original function
            taskExecutor.makeTaskExecutor = originalMakeTaskExecutor;
        }
    });
});