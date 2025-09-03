
const taskExecutor = require("../src/scheduler/execution");
const { Duration } = require("luxon");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper, getDatetimeControl, stubScheduler, getSchedulerControl, stubRuntimeStateStorage } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubSleeper(capabilities);
    // Use stubRuntimeStateStorage for faster execution and to expose the race condition
    stubRuntimeStateStorage(capabilities);
    stubScheduler(capabilities);
    return capabilities;
}

describe("scheduler atomicity testing", () => {

    test("attempt map state corruption with direct manipulation", async () => {
        const capabilities = getTestCapabilities();
        const schedulerControl = getSchedulerControl(capabilities);
        schedulerControl.setPollingInterval(1);
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = Duration.fromMillis(20000);

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
        const startTime = 1704106800000 // 2024-01-01T11:00:00.000Z;
        timeControl.setTime(startTime);

        await capabilities.scheduler.initialize(registrations);

        // Wait for scheduler initialization
        await schedulerControl.waitForNextCycleEnd();

        // Should NOT execute immediately on first startup
        expect(task1Finished).toBe(false);
        expect(task2Finished).toBe(false);
        expect(task3Finished).toBe(false);

        // Advance to next scheduled execution (12:00:00)
        timeControl.advanceTime(60 * 60 * 1000); // 1 hour to 12:00:00
        await schedulerControl.waitForNextCycleEnd();

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

        expect(finalState.tasks).toHaveLength(3);

        await capabilities.scheduler.stop();
    });

    test("attempts to create a controlled race condition in task map serialization", async () => {
        const capabilities = getTestCapabilities();
        const schedulerControl = getSchedulerControl(capabilities);
        schedulerControl.setPollingInterval(1);
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = Duration.fromMillis(25000);

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
                        timestamp: capabilities.datetime.getCurrentTime()
                    });

                    // Execute the original task
                    await originalExecutor.runTask(task, mode);

                    executionTimeline.push({
                        event: 'task_complete',
                        callId,
                        taskName: task.name,
                        timestamp: capabilities.datetime.getCurrentTime()
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
                await new Promise(resolve => setTimeout(resolve, 200));
                task2Done = true;
            });

            const registrations = [
                ["controlled-task-1", "0 * * * *", task1, retryDelay],
                ["controlled-task-2", "0 * * * *", task2, retryDelay]
            ];

            const startTime = 1704114000000 // 2024-01-01T13:00:00.000Z;
            timeControl.setTime(startTime);

            await capabilities.scheduler.initialize(registrations);

            // Wait for scheduler initialization
            await schedulerControl.waitForNextCycleEnd();

            // Should NOT execute immediately on first startup
            expect(task1Done).toBe(false);
            expect(task2Done).toBe(false);

            // Advance to next scheduled execution (14:00:00)
            timeControl.advanceTime(60 * 60 * 1000); // 1 hour to 14:00:00
            await schedulerControl.waitForNextCycleEnd();

            expect(task1Done).toBe(true);
            expect(task2Done).toBe(true);

            // Analyze the execution timeline to show concurrency
            capabilities.logger.logDebug({ executionTimeline }, "Task execution timeline");

            await capabilities.scheduler.stop();
        } finally {
            // Restore original function
            taskExecutor.makeTaskExecutor = originalMakeTaskExecutor;
        }
    });
});
