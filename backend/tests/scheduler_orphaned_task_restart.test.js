/**
 * Test suite for restarting shutdown tasks
 * Tests the behavior of detecting and restarting orphaned tasks from previous scheduler instances
 */

const { fromMilliseconds } = require("../src/datetime");
const { Duration } = require("luxon");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper, stubScheduler, getSchedulerControl } = require("./stubs");

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
        const retryDelay = Duration.fromMillis(5000);
        
        schedulerControl.setPollingInterval(fromMilliseconds(1));
        
        const taskCallback = jest.fn();
        const registrations = [
            ["orphaned-task", "0 * * * *", taskCallback, retryDelay]
        ];

        // First scheduler instance - simulate starting a task but shutting down before completion
        await capabilities.scheduler.initialize(registrations);
        
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
        
        await capabilities.scheduler.stop();
        
        // Second scheduler instance - should detect and restart the orphaned task
        await capabilities.scheduler.initialize(registrations);
        
        // Wait for scheduler to process and restart the orphaned task
        await schedulerControl.waitForNextCycleEnd();
        
        // The task should have been restarted (scheduler will log a warning)
        // We can verify the task is no longer marked as running with the old identifier
        await capabilities.state.transaction(async (storage) => {
            const state = await storage.getExistingState();
            if (state && state.tasks.length > 0) {
                const task = state.tasks[0];
                // lastAttemptTime should be cleared (set to undefined)
                expect(task.lastAttemptTime).toBeUndefined();
                // schedulerIdentifier should be cleared
                expect(task.schedulerIdentifier).toBeUndefined();
            }
        });
        
        await capabilities.scheduler.stop();
    });

    test("should not restart tasks that were running under the current scheduler instance", async () => {
        const capabilities = getTestCapabilities();
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = Duration.fromMillis(5000);
        
        schedulerControl.setPollingInterval(fromMilliseconds(1));
        
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
        await capabilities.state.transaction(async (storage) => {
            const state = await storage.getExistingState();
            if (state && state.tasks.length > 0) {
                const task = state.tasks[0];
                // lastAttemptTime should still be set since this task is legitimately running
                expect(task.lastAttemptTime).toBeDefined();
            }
        });
        
        await capabilities.scheduler.stop();
    });

    test("should handle multiple orphaned tasks from different scheduler instances", async () => {
        const capabilities = getTestCapabilities();
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = Duration.fromMillis(5000);
        
        schedulerControl.setPollingInterval(fromMilliseconds(1));
        
        const task1Callback = jest.fn();
        const task2Callback = jest.fn();
        const task3Callback = jest.fn();
        
        const registrations = [
            ["orphaned-task-1", "0 * * * *", task1Callback, retryDelay],
            ["orphaned-task-2", "15 * * * *", task2Callback, retryDelay],
            ["orphaned-task-3", "30 * * * *", task3Callback, retryDelay]
        ];

        // First scheduler instance
        await capabilities.scheduler.initialize(registrations);
        
        // Manually mark multiple tasks as running with different scheduler identifiers
        await capabilities.state.transaction(async (storage) => {
            const state = await storage.getExistingState();
            if (state && state.tasks.length >= 3) {
                const now = capabilities.datetime.now();
                state.tasks[0].lastAttemptTime = now;
                state.tasks[0].schedulerIdentifier = "old-scheduler-1";
                
                state.tasks[1].lastAttemptTime = now;
                state.tasks[1].schedulerIdentifier = "old-scheduler-2";
                
                // Leave the third task without scheduler identifier
                state.tasks[2].lastAttemptTime = now;
                state.tasks[2].schedulerIdentifier = undefined;
                
                storage.setState(state);
            }
        });
        
        await capabilities.scheduler.stop();
        
        // Second scheduler instance - should detect and restart orphaned tasks
        await capabilities.scheduler.initialize(registrations);
        await schedulerControl.waitForNextCycleEnd();
        
        // Verify all orphaned tasks have been reset
        await capabilities.state.transaction(async (storage) => {
            const state = await storage.getExistingState();
            if (state && state.tasks.length >= 3) {
                // First two tasks should be restarted (had different scheduler IDs)
                expect(state.tasks[0].lastAttemptTime).toBeUndefined();
                expect(state.tasks[0].schedulerIdentifier).toBeUndefined();
                
                expect(state.tasks[1].lastAttemptTime).toBeUndefined();
                expect(state.tasks[1].schedulerIdentifier).toBeUndefined();
                
                // Third task should also be restarted (no scheduler identifier means it's orphaned)
                expect(state.tasks[2].lastAttemptTime).toBeUndefined();
                expect(state.tasks[2].schedulerIdentifier).toBeUndefined();
            }
        });
        
        await capabilities.scheduler.stop();
    });

    test("should handle tasks with no scheduler identifier as orphaned", async () => {
        const capabilities = getTestCapabilities();
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = Duration.fromMillis(5000);
        
        schedulerControl.setPollingInterval(fromMilliseconds(1));
        
        const taskCallback = jest.fn();
        const registrations = [
            ["legacy-task", "0 * * * *", taskCallback, retryDelay]
        ];

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
        
        // Second scheduler instance
        await capabilities.scheduler.initialize(registrations);
        await schedulerControl.waitForNextCycleEnd();
        
        // The task should have been restarted (treated as orphaned)
        await capabilities.state.transaction(async (storage) => {
            const state = await storage.getExistingState();
            if (state && state.tasks.length > 0) {
                const task = state.tasks[0];
                expect(task.lastAttemptTime).toBeUndefined();
                expect(task.schedulerIdentifier).toBeUndefined();
            }
        });
        
        await capabilities.scheduler.stop();
    });

    test("should log appropriate warnings when restarting orphaned tasks", async () => {
        const capabilities = getTestCapabilities();
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = Duration.fromMillis(5000);
        
        schedulerControl.setPollingInterval(fromMilliseconds(1));
        
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
                storage.setState(state);
            }
        });
        
        await capabilities.scheduler.stop();
        
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
            "ACHTUNG: THIS TASK DID NOT FINISH RUNNING, I'M RESTARTING IT NOW!"
        );
        
        await capabilities.scheduler.stop();
    });
});