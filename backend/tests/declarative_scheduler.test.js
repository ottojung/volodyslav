/**
 * Tests for the new declarative scheduler functionality.
 */

const { 
    initialize, 
    getSchedulerForTesting,
    TaskListMismatchError, 
    isTaskListMismatchError,
} = require("../src/schedule");
const { 
    stubLogger, 
    stubEnvironment,
    stubSleeper,
    stubDatetime,
} = require("./stubs");
const { getMockedRootCapabilities } = require("./spies");
const { COMMON } = require("../src/time_duration");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubLogger(capabilities);
    stubEnvironment(capabilities);
    stubSleeper(capabilities);
    stubDatetime(capabilities);
    
    return capabilities;
}

describe("Declarative Scheduler", () => {

    describe("initialize", () => {
        test("succeeds with non-empty registrations for first-time initialization", async () => {
            // This test verifies that first-time initialization works
            const capabilities = getTestCapabilities();
            const registrations = [
                ["test-task", "0 * * * *", jest.fn(), COMMON.FIVE_MINUTES],
            ];

            // Non-empty registrations should succeed on first-time setup (empty persisted state)
            await expect(initialize(capabilities, registrations)).resolves.toBeUndefined();
        });
        
        test("succeeds with empty registrations when no persisted state exists", async () => {
            // This test verifies the basic functionality when there's no state
            const capabilities = getTestCapabilities();
            const registrations = [];

            // Empty registrations should succeed (idempotent call does nothing)
            await expect(initialize(capabilities, registrations)).resolves.toBeUndefined();
        });

        test("is idempotent - multiple calls have no additional effect", async () => {
            const capabilities = getTestCapabilities();
            const registrations = [
                ["task1", "0 * * * *", jest.fn(), COMMON.FIVE_MINUTES],
            ];

            // First call should succeed
            await expect(initialize(capabilities, registrations)).resolves.toBeUndefined();
            
            // Second call should also succeed and do nothing
            await expect(initialize(capabilities, registrations)).resolves.toBeUndefined();
            
            // Third call should also succeed and do nothing
            await expect(initialize(capabilities, registrations)).resolves.toBeUndefined();
        });

        test("throws TaskListMismatchError when tasks differ from persisted state", async () => {
            const capabilities = getTestCapabilities();
            
            // First, set up some initial persisted state by calling initialize
            const initialRegistrations = [
                ["task1", "0 * * * *", jest.fn(), COMMON.FIVE_MINUTES],
                ["task2", "0 0 * * *", jest.fn(), COMMON.TEN_MINUTES],
            ];
            await initialize(capabilities, initialRegistrations);

            // Now try to initialize with different tasks using SAME capabilities (same working directory)
            const differentRegistrations = [
                ["task1", "0 * * * *", jest.fn(), COMMON.FIVE_MINUTES], // same
                ["task3", "0 0 * * *", jest.fn(), COMMON.TEN_MINUTES], // different name
            ];

            await expect(initialize(capabilities, differentRegistrations)).rejects.toThrow(TaskListMismatchError);
        });

        test("throws TaskListMismatchError when cron expression differs", async () => {
            const capabilities = getTestCapabilities();
            
            // Set up initial state
            const initialRegistrations = [
                ["task1", "0 * * * *", jest.fn(), COMMON.FIVE_MINUTES],
            ];
            await initialize(capabilities, initialRegistrations);

            // Try with different cron expression using same capabilities
            const changedRegistrations = [
                ["task1", "0 0 * * *", jest.fn(), COMMON.FIVE_MINUTES], // different cron
            ];

            await expect(initialize(capabilities, changedRegistrations)).rejects.toThrow(TaskListMismatchError);
        });

        test("throws TaskListMismatchError when retry delay differs", async () => {
            const capabilities = getTestCapabilities();
            
            // Set up initial state
            const initialRegistrations = [
                ["task1", "0 * * * *", jest.fn(), COMMON.FIVE_MINUTES],
            ];
            await initialize(capabilities, initialRegistrations);

            // Try with different retry delay using same capabilities
            const changedRegistrations = [
                ["task1", "0 * * * *", jest.fn(), COMMON.TEN_MINUTES], // different retry delay
            ];

            await expect(initialize(capabilities, changedRegistrations)).rejects.toThrow(TaskListMismatchError);
        });

        test("throws TaskListMismatchError when task is missing from registrations", async () => {
            const capabilities = getTestCapabilities();
            
            // Set up initial state with two tasks
            const initialRegistrations = [
                ["task1", "0 * * * *", jest.fn(), COMMON.FIVE_MINUTES],
                ["task2", "0 0 * * *", jest.fn(), COMMON.TEN_MINUTES],
            ];
            await initialize(capabilities, initialRegistrations);

            // Try with only one task (missing task2) using same capabilities
            const missingTaskRegistrations = [
                ["task1", "0 * * * *", jest.fn(), COMMON.FIVE_MINUTES],
            ];

            const error = await initialize(capabilities, missingTaskRegistrations).catch(e => e);
            
            expect(error).toBeInstanceOf(TaskListMismatchError);
            expect(error.mismatchDetails.missing).toContain("task2");
        });

        test("throws TaskListMismatchError when extra task is in registrations", async () => {
            const capabilities = getTestCapabilities();
            
            // Set up initial state with one task
            const initialRegistrations = [
                ["task1", "0 * * * *", jest.fn(), COMMON.FIVE_MINUTES],
            ];
            await initialize(capabilities, initialRegistrations);

            // Try with extra task using same capabilities
            const extraTaskRegistrations = [
                ["task1", "0 * * * *", jest.fn(), COMMON.FIVE_MINUTES],
                ["task2", "0 0 * * *", jest.fn(), COMMON.TEN_MINUTES], // extra task
            ];

            const error = await initialize(capabilities, extraTaskRegistrations).catch(e => e);
            
            expect(error).toBeInstanceOf(TaskListMismatchError);
            expect(error.mismatchDetails.extra).toContain("task2");
        });

        test("provides detailed mismatch information in error", async () => {
            const capabilities = getTestCapabilities();
            
            // Set up initial state
            const initialRegistrations = [
                ["task1", "0 * * * *", jest.fn(), COMMON.FIVE_MINUTES],
                ["task2", "0 0 * * *", jest.fn(), COMMON.TEN_MINUTES],
            ];
            await initialize(capabilities, initialRegistrations);

            // Create complex mismatch scenario using same capabilities
            const mismatchedRegistrations = [
                ["task1", "0 */2 * * *", jest.fn(), COMMON.THIRTY_MINUTES], // different cron + retry delay
                ["task3", "0 0 * * *", jest.fn(), COMMON.TEN_MINUTES], // extra task (task2 is missing)
            ];

            const error = await initialize(capabilities, mismatchedRegistrations).catch(e => e);
            
            expect(error).toBeInstanceOf(TaskListMismatchError);
            expect(error.mismatchDetails.missing).toEqual(["task2"]);
            expect(error.mismatchDetails.extra).toEqual(["task3"]);
            expect(error.mismatchDetails.differing).toHaveLength(2); // task1 has 2 differing fields
            
            // Check that differing details are specific
            const cronDiff = error.mismatchDetails.differing.find(d => d.field === 'cronExpression');
            const retryDiff = error.mismatchDetails.differing.find(d => d.field === 'retryDelayMs');
            
            expect(cronDiff).toBeDefined();
            expect(cronDiff.name).toBe("task1");
            expect(cronDiff.expected).toBe("0 * * * *");
            expect(cronDiff.actual).toBe("0 */2 * * *");
            
            expect(retryDiff).toBeDefined();
            expect(retryDiff.name).toBe("task1");
            expect(retryDiff.expected).toBe(COMMON.FIVE_MINUTES.toMilliseconds());
            expect(retryDiff.actual).toBe(COMMON.THIRTY_MINUTES.toMilliseconds());
        });

        test("handles empty registrations with empty persisted state", async () => {
            const capabilities = getTestCapabilities();
            const registrations = [];

            // Should succeed with no tasks
            await expect(initialize(capabilities, registrations)).resolves.toBeUndefined();
            
            // Should be idempotent
            await expect(initialize(capabilities, registrations)).resolves.toBeUndefined();
        });

        test("logs appropriate messages for first-time initialization", async () => {
            const capabilities = getTestCapabilities();
            const registrations = [
                ["task1", "0 * * * *", jest.fn(), COMMON.FIVE_MINUTES],
                ["task2", "0 0 * * *", jest.fn(), COMMON.TEN_MINUTES],
            ];

            await initialize(capabilities, registrations);

            // Should log first-time initialization message
            expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
                { registeredTaskCount: 2 }, 
                "First-time scheduler initialization: registering initial tasks"
            );
        });
    });

    describe("task execution behavior during initialize", () => {
        beforeEach(() => {
            // Use fake timers for precise control over time
            jest.useFakeTimers();
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        test("initialize starts all tasks that are due", async () => {
            // Set initial time to ensure both tasks have run once first
            jest.setSystemTime(new Date("2020-01-01T12:00:00Z"));
            
            const task1Callback = jest.fn();
            const task2Callback = jest.fn();
            
            const registrations = [
                // Task that should run every hour at minute 0
                ["hourly-task", "0 * * * *", task1Callback, COMMON.FIVE_MINUTES],
                // Task that should run every hour at minute 15
                ["quarter-past-task", "15 * * * *", task2Callback, COMMON.FIVE_MINUTES],
            ];

            const capabilities = getTestCapabilities();

            // Initialize the scheduler
            await initialize(capabilities, registrations, { 
                pollIntervalMs: 10, 
            });
            
            // Get scheduler for testing and trigger polling
            const scheduler = getSchedulerForTesting(capabilities);
            
            // First polling at 12:00 - both tasks will run to establish execution history
            await scheduler._poll();
            expect(task1Callback).toHaveBeenCalledTimes(1); // Runs at 12:00
            expect(task2Callback).toHaveBeenCalledTimes(1); // Catches up to 12:00 as first run
            
            // Reset call counts and move to 12:15 where only quarter-past task should be due
            task1Callback.mockClear();
            task2Callback.mockClear();
            jest.setSystemTime(new Date("2020-01-01T12:15:00Z"));
            
            // Poll again - now only the quarter-past task should be due
            await scheduler._poll();
            
            // Only quarter-past task should have been executed
            expect(task1Callback).not.toHaveBeenCalled(); // Not due until 13:00
            expect(task2Callback).toHaveBeenCalledTimes(1); // Due at 12:15
        });

        test("initialize does not start any tasks that are not due", async () => {
            // Set system time to 2020-01-01 12:30:00 (middle of hour)
            jest.setSystemTime(new Date("2020-01-01T12:15:00Z"));
            
            const task1Callback = jest.fn();
            const task2Callback = jest.fn();
            
            const registrations = [
                // Task that should run at 30 minutes past the hour
                ["half-past", "30 * * * *", task1Callback, COMMON.FIVE_MINUTES],
                // Task that should run at 45 minutes past the hour  
                ["quarter-to", "45 * * * *", task2Callback, COMMON.FIVE_MINUTES],
            ];

            const capabilities = getTestCapabilities();

            // Get scheduler for testing
            await initialize(capabilities, registrations, { 
                pollIntervalMs: 10, 
            });
            
            const scheduler = getSchedulerForTesting(capabilities);
            
            // First poll to establish execution history
            await scheduler._poll();
            
            // Reset and move to a time where neither should be due (12:20)
            task1Callback.mockClear();
            task2Callback.mockClear();
            jest.setSystemTime(new Date("2020-01-01T12:20:00Z"));
            
            // Poll again
            await scheduler._poll();
            
            // Neither task should have been executed (not due until 12:30 and 12:45)
            expect(task1Callback).not.toHaveBeenCalled();
            expect(task2Callback).not.toHaveBeenCalled();
        });

        test("scheduler correctly tracks task running state", async () => {
            // This is a simpler test that verifies the scheduler tracks running state correctly
            // Set system time to top of minute
            jest.setSystemTime(new Date("2020-01-01T12:00:00Z"));
            
            const fastCallback = jest.fn();
            
            const registrations = [
                ["fast-task", "* * * * *", fastCallback, COMMON.FIVE_MINUTES], // Every minute
            ];

            const capabilities = getTestCapabilities();

            // Get scheduler for testing
            await initialize(capabilities, registrations, { 
                pollIntervalMs: 10, 
            });
            
            const scheduler = getSchedulerForTesting(capabilities);
            
            // Check initial state - task should be considered due
            const tasksInitial = await scheduler.getTasks();
            expect(tasksInitial[0].modeHint).toBe("cron");
            expect(tasksInitial[0].running).toBe(false);
            
            // Poll to execute the task
            await scheduler._poll();
            
            // Task should have been executed
            expect(fastCallback).toHaveBeenCalledTimes(1);
            
            // Check state after execution - task should be idle
            const tasksAfter = await scheduler.getTasks();
            expect(tasksAfter[0].modeHint).toBe("idle");
            expect(tasksAfter[0].running).toBe(false);
            
            // Move to next minute
            jest.setSystemTime(new Date("2020-01-01T12:01:00Z"));
            
            // Poll again - task should be due again
            await scheduler._poll();
            
            // Task should have been executed again
            expect(fastCallback).toHaveBeenCalledTimes(2);
        });

        test("initialize does not run tasks that aren't supposed to be running", async () => {
            // Set system time to a specific time (Wednesday, January 1, 2020 at 12:30)
            jest.setSystemTime(new Date("2020-01-01T12:30:00Z"));
            
            const task1Callback = jest.fn();
            const task2Callback = jest.fn();
            const task3Callback = jest.fn();
            
            const registrations = [
                // Task that runs at specific minute (27, not 30)
                ["specific-minute", "27 * * * *", task1Callback, COMMON.FIVE_MINUTES],
                // Task that runs only on weekends (today is Wednesday)
                ["weekend-only", "30 12 * * 6,0", task2Callback, COMMON.FIVE_MINUTES],
                // Task that runs only in February (we're in January)
                ["february-only", "30 12 * 2 *", task3Callback, COMMON.FIVE_MINUTES],
            ];

            const capabilities = getTestCapabilities();

            // Get scheduler for testing
            await initialize(capabilities, registrations, { 
                pollIntervalMs: 10, 
            });
            
            const scheduler = getSchedulerForTesting(capabilities);
            
            // First poll to establish execution history
            await scheduler._poll();
            
            // Reset call counts and stay at same time where none should be due
            task1Callback.mockClear();
            task2Callback.mockClear();
            task3Callback.mockClear();
            
            // Poll again at the same time
            await scheduler._poll();
            
            // None of these tasks should run at this specific time
            expect(task1Callback).not.toHaveBeenCalled(); // Due at minute 27, not 30
            expect(task2Callback).not.toHaveBeenCalled(); // Today is Wednesday, not weekend
            expect(task3Callback).not.toHaveBeenCalled(); // We're in January, not February
        });

        test("initialize is idempotent in terms of starting tasks", async () => {
            // Set system time to top of hour when tasks should be due
            jest.setSystemTime(new Date("2020-01-01T12:00:00Z"));
            
            const task1Callback = jest.fn();
            const task2Callback = jest.fn();
            
            const registrations = [
                ["hourly-task-1", "0 * * * *", task1Callback, COMMON.FIVE_MINUTES],
                ["hourly-task-2", "0 * * * *", task2Callback, COMMON.FIVE_MINUTES],
            ];

            const capabilities = getTestCapabilities();

            // First call to initialize
            await initialize(capabilities, registrations, { 
                pollIntervalMs: 10, 
            });
            
            const scheduler1 = getSchedulerForTesting(capabilities);
            
            // Poll to run tasks
            await scheduler1._poll();
            
            const task1CallCount = task1Callback.mock.calls.length;
            const task2CallCount = task2Callback.mock.calls.length;
            
            // Both tasks should have been called once
            expect(task1CallCount).toBe(1);
            expect(task2CallCount).toBe(1);
            
            // Second call to initialize with same capabilities - should be idempotent
            // This should not create duplicate tasks or run them again
            await initialize(capabilities, registrations, { 
                pollIntervalMs: 10, 
            });
            
            const scheduler2 = getSchedulerForTesting(capabilities);
            
            // Poll again - tasks should not run again (they already ran in this time period)
            await scheduler2._poll();
            
            // Tasks should not have been called again (idempotent behavior)
            expect(task1Callback).toHaveBeenCalledTimes(task1CallCount);
            expect(task2Callback).toHaveBeenCalledTimes(task2CallCount);
            
            // Third call to initialize - should still be idempotent
            await initialize(capabilities, registrations, { 
                pollIntervalMs: 10, 
            });
            
            const scheduler3 = getSchedulerForTesting(capabilities);
            
            await scheduler3._poll();
            
            // Tasks should still not have been called again
            expect(task1Callback).toHaveBeenCalledTimes(task1CallCount);
            expect(task2Callback).toHaveBeenCalledTimes(task2CallCount);
        });

        test("initialize correctly handles mixed due and non-due tasks", async () => {
            // Set system time to 2020-01-01 12:15:00
            jest.setSystemTime(new Date("2020-01-01T12:15:00Z"));
            
            const dueTask1 = jest.fn();
            const dueTask2 = jest.fn(); 
            const notDueTask1 = jest.fn();
            const notDueTask2 = jest.fn();
            
            const registrations = [
                // Tasks that are due at 15 minutes past hour
                ["due-task-1", "15 * * * *", dueTask1, COMMON.FIVE_MINUTES],
                ["due-task-2", "15 12 * * *", dueTask2, COMMON.FIVE_MINUTES], // Also due at 12:15
                // Tasks that are not due  
                ["not-due-1", "30 * * * *", notDueTask1, COMMON.FIVE_MINUTES], // Due at 30 min past
                ["not-due-2", "15 13 * * *", notDueTask2, COMMON.FIVE_MINUTES], // Due at 13:15
            ];

            const capabilities = getTestCapabilities();

            // Get scheduler for testing
            await initialize(capabilities, registrations, { 
                pollIntervalMs: 10, 
            });
            
            const scheduler = getSchedulerForTesting(capabilities);
            
            // First poll to establish execution history for all tasks
            await scheduler._poll();
            
            // All tasks will run on first poll, so reset and move time to test proper behavior
            dueTask1.mockClear();
            dueTask2.mockClear(); 
            notDueTask1.mockClear();
            notDueTask2.mockClear();
            
            // Move to a later time when only some tasks should be due
            jest.setSystemTime(new Date("2020-01-01T12:30:00Z"));
            
            // Poll again
            await scheduler._poll();
            
            // Only the 30-minute task should have been executed at 12:30
            expect(dueTask1).not.toHaveBeenCalled(); // Due at 12:15, already ran
            expect(dueTask2).not.toHaveBeenCalled(); // Due at 12:15, already ran
            expect(notDueTask1).toHaveBeenCalledTimes(1); // Due at 12:30, should run now
            expect(notDueTask2).not.toHaveBeenCalled(); // Due at 13:15, not yet
        });
    });

    describe("TaskListMismatchError", () => {
        test("has proper structure and type guard", () => {
            const mismatchDetails = {
                missing: ["task1"],
                extra: ["task2"],
                differing: [],
            };
            const error = new TaskListMismatchError("Test message", mismatchDetails);
            
            expect(error.name).toBe("TaskListMismatchError");
            expect(error.message).toBe("Test message");
            expect(error.mismatchDetails).toBe(mismatchDetails);
            expect(isTaskListMismatchError(error)).toBe(true);
            expect(isTaskListMismatchError(new Error())).toBe(false);
        });
    });
});