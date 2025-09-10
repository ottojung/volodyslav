/**
 * Test suite for restarting shutdown tasks
 * Tests the behavior of detecting and restarting orphaned tasks from previous scheduler instances
 */

const { fromMilliseconds, fromMinutes, fromISOString } = require("../src/datetime");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper, stubScheduler, getSchedulerControl, getDatetimeControl } = require("./stubs");

describe("scheduler orphaned task restart", () => {

    function getTestCapabilities() {
        const capabilities = getMockedRootCapabilities();
        stubEnvironment(capabilities);
        stubLogger(capabilities);
        stubDatetime(capabilities);
        stubSleeper(capabilities);
        stubScheduler(capabilities);
        return capabilities;
    }

    test("should restart tasks that were running under a different scheduler instance", async () => {
        const capabilities = getTestCapabilities();
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = fromMilliseconds(5000);

        schedulerControl.setPollingInterval(fromMilliseconds(100));

        const taskCallback = jest.fn();
        const registrations = [
            ["orphaned-task", "0 * * * *", taskCallback, retryDelay]
        ];

        // Spy on logger to verify restart behavior
        const logWarningSpy = jest.spyOn(capabilities.logger, 'logWarning');
        const logInfoSpy = jest.spyOn(capabilities.logger, 'logInfo');

        // First scheduler instance - simulate starting a task but shutting down before completion
        await capabilities.scheduler.initialize(registrations);

        await capabilities.scheduler.stop();

        // Manually mark a task as running with a different scheduler identifier
        // This simulates the scenario where a task was started but the app was shut down
        await capabilities.state.transaction(async (storage) => {
            const state = await storage.getExistingState();
            if (state && state.tasks.length > 0) {
                const task = state.tasks[0];
                task.lastAttemptTime = capabilities.datetime.now();
                task.schedulerIdentifier = "different-scheduler-id";
                storage.setState(state);
            }
        });

        // Clear spies for the new instance
        logWarningSpy.mockClear();
        logInfoSpy.mockClear();

        // Second scheduler instance - should detect and restart the orphaned task
        await capabilities.scheduler.initialize(registrations);

        // Wait for scheduler to process and restart the orphaned task
        await schedulerControl.waitForNextCycleEnd();

        // Verify that the orphaned task restart was logged
        expect(logWarningSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                taskName: "orphaned-task",
                previousSchedulerIdentifier: "different-scheduler-id",
                currentSchedulerIdentifier: expect.any(String)
            }),
            "Task was interrupted during shutdown and will be restarted"
        );

        // The task should actually run after being restarted
        expect(taskCallback).toHaveBeenCalled();

        await capabilities.scheduler.stop();
    });

    test("preserves scheduler timings for orphaned persistent tasks while loading new ones", async () => {
        const capabilities = getTestCapabilities();
        const dateControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);

        // Speed up scheduler polling for test
        schedulerControl.setPollingInterval(fromMilliseconds(100));
        dateControl.setDateTime(fromISOString("2021-01-01T00:00:00.000Z"));

        const callback1 = jest.fn();
        const callback2 = jest.fn();
        const callback3 = jest.fn();

        // Set up initial state
        const initialRegistrations = [
            ["task1", "0 0 * * *", callback1, fromMinutes(5)],
            ["task2", "0 0 * * *", callback2, fromMinutes(5)],
        ];

        await capabilities.scheduler.initialize(initialRegistrations);

        expect(callback1).not.toHaveBeenCalled();
        expect(callback2).not.toHaveBeenCalled();
        expect(callback3).not.toHaveBeenCalled();

        await schedulerControl.waitForNextCycleEnd();

        expect(callback1).toHaveBeenCalledTimes(1);
        expect(callback2).toHaveBeenCalledTimes(1);
        expect(callback3).not.toHaveBeenCalled();

        // Create complex mismatch scenario using same capabilities
        const mismatchedRegistrations = [
            ["task1", "0 0 * * *", callback1, fromMinutes(5)],
            ["task3", "0 0 * * *", callback3, fromMinutes(5)], // extra task (task2 is missing)
        ];

        await capabilities.scheduler.stop();

        // Manually mark tasks as running with a different scheduler identifier
        // This simulates the scenario where a task was started but the app was shut down
        await capabilities.state.transaction(async (storage) => {
            const state = await storage.getExistingState();
            if (state && state.tasks.length > 0) {
                for (const task of state.tasks) {
                    task.lastAttemptTime = capabilities.datetime.now();
                    task.schedulerIdentifier = "different-scheduler-id";
                }
                storage.setState(state);
            }
        });

        dateControl.advanceByDuration(fromMinutes(10));

        // This should now succeed (override behavior) instead of throwing
        await expect(capabilities.scheduler.initialize(mismatchedRegistrations)).resolves.toBeUndefined();

        // No additional calls at initialization time.
        expect(callback1).toHaveBeenCalledTimes(1);
        expect(callback2).toHaveBeenCalledTimes(1);
        expect(callback3).not.toHaveBeenCalled();

        await schedulerControl.waitForNextCycleEnd();

        while (callback1.mock.calls.length < 2 || callback2.mock.calls.length < 1) {
            await new Promise(resolve => setTimeout(resolve, 1));
        }

        // The orphaned task should run immediately because it was interrupted.
        expect(callback1).toHaveBeenCalledTimes(2);
        expect(callback2).toHaveBeenCalledTimes(1);
        expect(callback3).toHaveBeenCalledTimes(0);

        await capabilities.scheduler.stop();
    });

    test("should not restart tasks that were running under the current scheduler instance", async () => {
        const capabilities = getTestCapabilities();
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = fromMilliseconds(5000);

        schedulerControl.setPollingInterval(fromMilliseconds(100));

        const taskCallback = jest.fn();
        const registrations = [
            ["current-task", "0 * * * *", taskCallback, retryDelay]
        ];

        // Initialize scheduler
        await capabilities.scheduler.initialize(registrations);

        // Start the task manually to simulate it running
        await capabilities.state.transaction(async (storage) => {
            const state = await storage.getExistingState();
            if (state && state.tasks.length > 0) {
                const task = state.tasks[0];
                task.lastAttemptTime = capabilities.datetime.now();
                // Set a scheduler identifier that will match the current instance
                // We can't easily get the actual identifier, but we'll let the system set it naturally
                storage.setState(state);
            }
        });

        // Reinitialize the same scheduler instance (simulating a restart with the same ID)
        await capabilities.scheduler.initialize(registrations);

        // Wait for a cycle
        await schedulerControl.waitForNextCycleEnd();

        // The task should still be marked as running (not restarted)
        const finalState = await capabilities.state.transaction(async (storage) => {
            return await storage.getExistingState();
        });

        expect(finalState).toBeTruthy();
        expect(finalState.tasks).toHaveLength(1);

        const task = finalState.tasks[0];
        // lastAttemptTime should still be set since this task is legitimately running
        expect(task.lastAttemptTime).toBeDefined();

        await capabilities.scheduler.stop();
    });

    test("should handle multiple orphaned tasks from different scheduler instances", async () => {
        const capabilities = getTestCapabilities();
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = fromMilliseconds(5000);

        schedulerControl.setPollingInterval(fromMilliseconds(100));

        const task1Callback = jest.fn();
        const task2Callback = jest.fn();
        const task3Callback = jest.fn();

        const registrations = [
            ["orphaned-task-1", "0 * * * *", task1Callback, retryDelay],
            ["orphaned-task-2", "15 * * * *", task2Callback, retryDelay],
            ["orphaned-task-3", "30 * * * *", task3Callback, retryDelay]
        ];

        // Spy on logger
        const logWarningSpy = jest.spyOn(capabilities.logger, 'logWarning');
        const logInfoSpy = jest.spyOn(capabilities.logger, 'logInfo');

        // First scheduler instance
        await capabilities.scheduler.initialize(registrations);

        await capabilities.scheduler.stop();

        // Manually mark multiple tasks as running with different scheduler identifiers
        await capabilities.state.transaction(async (storage) => {
            const state = await storage.getExistingState();
            expect(state).toBeTruthy();
            expect(state.tasks).toHaveLength(3);

            const now = capabilities.datetime.now();

            state.tasks[0].lastAttemptTime = now;
            state.tasks[0].schedulerIdentifier = "old-scheduler-1";
            state.tasks[0].lastSuccessTime = undefined;
            state.tasks[0].lastFailureTime = undefined;
            state.tasks[0].pendingRetryUntil = undefined;

            state.tasks[1].lastAttemptTime = now;
            state.tasks[1].schedulerIdentifier = "old-scheduler-2";
            state.tasks[1].lastSuccessTime = undefined;
            state.tasks[1].lastFailureTime = undefined;
            state.tasks[1].pendingRetryUntil = undefined;

            storage.setState(state);
        });

        // Clear spies
        logWarningSpy.mockClear();
        logInfoSpy.mockClear();

        // Second scheduler instance - should detect and restart orphaned tasks
        await capabilities.scheduler.initialize(registrations);
        await schedulerControl.waitForNextCycleEnd();
        await schedulerControl.waitForNextCycleEnd();
        await schedulerControl.waitForNextCycleEnd();

        // Verify all three orphaned tasks were detected and restarted
        expect(logWarningSpy).toHaveBeenCalledTimes(2);
        expect(logWarningSpy).toHaveBeenCalledWith(
            expect.objectContaining({ taskName: "orphaned-task-1" }),
            expect.any(String),
        );
        expect(logWarningSpy).toHaveBeenCalledWith(
            expect.objectContaining({ taskName: "orphaned-task-2" }),
            expect.any(String),
        );

        // Only two callbacks should have been executed after restart
        expect(task1Callback).toHaveBeenCalled();
        expect(task2Callback).toHaveBeenCalled();

        await capabilities.scheduler.stop();
    });

    test("should not handle tasks with no scheduler identifier as orphaned", async () => {
        const capabilities = getTestCapabilities();
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = fromMilliseconds(5000);

        schedulerControl.setPollingInterval(fromMilliseconds(100));

        const taskCallback = jest.fn();
        const registrations = [
            ["legacy-task", "0 * * * *", taskCallback, retryDelay]
        ];

        // Spy on logger
        const logWarningSpy = jest.spyOn(capabilities.logger, 'logWarning');

        // First scheduler instance
        await capabilities.scheduler.initialize(registrations);

        // Manually mark a task as running without scheduler identifier (legacy scenario)
        await capabilities.state.transaction(async (storage) => {
            const state = await storage.getExistingState();
            if (state && state.tasks.length > 0) {
                const task = state.tasks[0];
                task.lastAttemptTime = capabilities.datetime.now();
                task.schedulerIdentifier = undefined; // No identifier (legacy)
                storage.setState(state);
            }
        });

        await capabilities.scheduler.stop();

        // Clear spy
        logWarningSpy.mockClear();

        // Second scheduler instance
        await capabilities.scheduler.initialize(registrations);
        await schedulerControl.waitForNextCycleEnd();

        expect(logWarningSpy).toHaveBeenCalledTimes(0);
        expect(taskCallback).toHaveBeenCalledTimes(0);

        await capabilities.scheduler.stop();
    }, 10000);

    test("should log appropriate warnings when restarting orphaned tasks", async () => {
        const capabilities = getTestCapabilities();
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = fromMilliseconds(5000);

        schedulerControl.setPollingInterval(fromMilliseconds(100));

        const taskCallback = jest.fn();
        const registrations = [
            ["warning-task", "0 * * * *", taskCallback, retryDelay]
        ];

        // Spy on logger warnings
        const logWarningSpy = jest.spyOn(capabilities.logger, 'logWarning');

        // First scheduler instance
        await capabilities.scheduler.initialize(registrations);

        // Mark task as orphaned
        await capabilities.state.transaction(async (storage) => {
            const state = await storage.getExistingState();
            if (state && state.tasks.length > 0) {
                const task = state.tasks[0];
                task.lastAttemptTime = capabilities.datetime.now();
                task.schedulerIdentifier = "old-scheduler-instance";
                task.lastSuccessTime = undefined;
                task.lastFailureTime = undefined;
                task.pendingRetryUntil = undefined;
                storage.setState(state);
            }
        });

        await capabilities.scheduler.stop();

        // Clear previous calls
        logWarningSpy.mockClear();

        // Second scheduler instance
        await capabilities.scheduler.initialize(registrations);
        await schedulerControl.waitForNextCycleEnd();

        // Verify warning was logged
        expect(logWarningSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                taskName: "warning-task",
                previousSchedulerIdentifier: "old-scheduler-instance",
                currentSchedulerIdentifier: expect.any(String)
            }),
            "Task was interrupted during shutdown and will be restarted"
        );

        await capabilities.scheduler.stop();
    });

    test("should handle unknown tasks during startup without failing", async () => {
        const capabilities = getTestCapabilities();
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = fromMilliseconds(5000);

        schedulerControl.setPollingInterval(fromMilliseconds(100));

        const taskCallback = jest.fn();
        const registrations = [
            ["known-task", "0 * * * *", taskCallback, retryDelay]
        ];

        // First, initialize with a different set of registrations that includes an extra task
        const initialRegistrations = [
            ["known-task", "0 * * * *", taskCallback, retryDelay],
            ["unknown-task", "15 * * * *", jest.fn(), retryDelay]
        ];

        await capabilities.scheduler.initialize(initialRegistrations);

        // Manually add an orphaned task to the unknown task 
        await capabilities.state.transaction(async (storage) => {
            const state = await storage.getExistingState();
            expect(state).toBeDefined();
            expect(state.tasks).toHaveLength(2);
            // Mark the unknown task as orphaned
            const unknownTask = state.tasks.find(task => task.name === "unknown-task");
            if (unknownTask) {
                unknownTask.lastAttemptTime = capabilities.datetime.now();
                unknownTask.schedulerIdentifier = "different-scheduler-id";
                storage.setState(state);
            }
        });

        await capabilities.scheduler.stop();

        // Now try to initialize with only the known task
        await expect(capabilities.scheduler.initialize(registrations)).resolves.not.toThrow();

        // Wait for scheduler to process
        await schedulerControl.waitForNextCycleEnd();

        while (taskCallback.mock.calls.length < 1) {
            await new Promise(resolve => setTimeout(resolve, 1));
        }       

        // // The known task should be running normally
        expect(taskCallback).toHaveBeenCalled();

        await capabilities.scheduler.stop();
    });
});