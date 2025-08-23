/**
 * Tests for the new declarative scheduler functionality.
 */

const {
    isTaskListMismatchError,
} = require("../src/schedule");
const {
    stubLogger,
    stubEnvironment,
    stubSleeper,
    stubDatetime,
    stubPollInterval,
} = require("./stubs");
const { getMockedRootCapabilities } = require("./spies");
const { COMMON } = require("../src/time_duration");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubLogger(capabilities);
    stubEnvironment(capabilities);
    stubSleeper(capabilities);
    stubDatetime(capabilities);
    stubPollInterval(1);
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
            await expect(capabilities.scheduler.initialize(registrations)).resolves.toBeUndefined();
            await capabilities.scheduler.stop(capabilities);
        });

        test("succeeds with empty registrations when no persisted state exists", async () => {
            // This test verifies the basic functionality when there's no state
            const capabilities = getTestCapabilities();
            const registrations = [];

            // Empty registrations should succeed (idempotent call does nothing)
            await expect(capabilities.scheduler.initialize(registrations)).resolves.toBeUndefined();
            await capabilities.scheduler.stop(capabilities);
        });

        test("is idempotent - multiple calls have no additional effect", async () => {
            const capabilities = getTestCapabilities();
            const registrations = [
                ["task1", "0 * * * *", jest.fn(), COMMON.FIVE_MINUTES],
            ];

            // First call should succeed
            await expect(capabilities.scheduler.initialize(registrations)).resolves.toBeUndefined();

            // Second call should also succeed and do nothing
            await expect(capabilities.scheduler.initialize(registrations)).resolves.toBeUndefined();

            // Third call should also succeed and do nothing
            await expect(capabilities.scheduler.initialize(registrations)).resolves.toBeUndefined();

            await capabilities.scheduler.stop(capabilities);
        });

        test("throws TaskListMismatchError when tasks differ from persisted state", async () => {
            const capabilities = getTestCapabilities();

            // First, set up some initial persisted state by calling initialize
            const initialRegistrations = [
                ["task1", "0 * * * *", jest.fn(), COMMON.FIVE_MINUTES],
                ["task2", "0 0 * * *", jest.fn(), COMMON.TEN_MINUTES],
            ];

            await capabilities.scheduler.initialize(initialRegistrations);

            // Now try to initialize with different tasks using SAME capabilities (same working directory)
            const differentRegistrations = [
                ["task1", "0 * * * *", jest.fn(), COMMON.FIVE_MINUTES], // same
                ["task3", "0 0 * * *", jest.fn(), COMMON.TEN_MINUTES], // different name
            ];

            await expect(capabilities.scheduler.initialize(differentRegistrations)).rejects.toThrow(/Task list mismatch detected/);
            await capabilities.scheduler.stop(capabilities);
        });

        test("throws TaskListMismatchError when cron expression differs", async () => {
            const capabilities = getTestCapabilities();

            // Set up initial state
            const initialRegistrations = [
                ["task1", "0 * * * *", jest.fn(), COMMON.FIVE_MINUTES],
            ];

            await capabilities.scheduler.initialize(initialRegistrations);

            // Try with different cron expression using same capabilities
            const changedRegistrations = [
                ["task1", "0 0 * * *", jest.fn(), COMMON.FIVE_MINUTES], // different cron
            ];

            await expect(capabilities.scheduler.initialize(changedRegistrations)).rejects.toThrow(/Task list mismatch detected/);
            await capabilities.scheduler.stop(capabilities);
        });

        test("throws TaskListMismatchError when retry delay differs", async () => {
            const capabilities = getTestCapabilities();

            // Set up initial state
            const initialRegistrations = [
                ["task1", "0 * * * *", jest.fn(), COMMON.FIVE_MINUTES],
            ];

            await capabilities.scheduler.initialize(initialRegistrations);

            // Try with different retry delay using same capabilities
            const changedRegistrations = [
                ["task1", "0 * * * *", jest.fn(), COMMON.TEN_MINUTES], // different retry delay
            ];

            await expect(capabilities.scheduler.initialize(changedRegistrations)).rejects.toThrow(/Task list mismatch detected/);
            await capabilities.scheduler.stop(capabilities);
        });

        test("throws TaskListMismatchError when task is missing from registrations", async () => {
            const capabilities = getTestCapabilities();

            // Set up initial state with two tasks
            const initialRegistrations = [
                ["task1", "0 * * * *", jest.fn(), COMMON.FIVE_MINUTES],
                ["task2", "0 0 * * *", jest.fn(), COMMON.TEN_MINUTES],
            ];

            await capabilities.scheduler.initialize(initialRegistrations);

            // Try with only one task (missing task2) using same capabilities
            const missingTaskRegistrations = [
                ["task1", "0 * * * *", jest.fn(), COMMON.FIVE_MINUTES],
            ];

            const error = await capabilities.scheduler.initialize(missingTaskRegistrations).catch(e => e);

            expect(isTaskListMismatchError(error)).toBe(true);
            expect(error.mismatchDetails.missing).toContain("task2");
            await capabilities.scheduler.stop(capabilities);
        });

        test("throws TaskListMismatchError when extra task is in registrations", async () => {
            const capabilities = getTestCapabilities();

            // Set up initial state with one task
            const initialRegistrations = [
                ["task1", "0 * * * *", jest.fn(), COMMON.FIVE_MINUTES],
            ];

            await capabilities.scheduler.initialize(initialRegistrations);

            // Try with extra task using same capabilities
            const extraTaskRegistrations = [
                ["task1", "0 * * * *", jest.fn(), COMMON.FIVE_MINUTES],
                ["task2", "0 0 * * *", jest.fn(), COMMON.TEN_MINUTES], // extra task
            ];

            const error = await capabilities.scheduler.initialize(extraTaskRegistrations).catch(e => e);

            expect(isTaskListMismatchError(error)).toBe(true);
            expect(error.mismatchDetails.extra).toContain("task2");
            await capabilities.scheduler.stop(capabilities);
        });

        test("provides detailed mismatch information in error", async () => {
            const capabilities = getTestCapabilities();

            // Set up initial state
            const initialRegistrations = [
                ["task1", "0 * * * *", jest.fn(), COMMON.FIVE_MINUTES],
                ["task2", "0 0 * * *", jest.fn(), COMMON.TEN_MINUTES],
            ];

            await capabilities.scheduler.initialize(initialRegistrations);

            // Create complex mismatch scenario using same capabilities
            const mismatchedRegistrations = [
                ["task1", "0 */2 * * *", jest.fn(), COMMON.THIRTY_MINUTES], // different cron + retry delay
                ["task3", "0 0 * * *", jest.fn(), COMMON.TEN_MINUTES], // extra task (task2 is missing)
            ];

            const error = await capabilities.scheduler.initialize(mismatchedRegistrations).catch(e => e);

            expect(isTaskListMismatchError(error)).toBe(true);
            expect(error.mismatchDetails.missing).toEqual(["task2"]);
            expect(error.mismatchDetails.extra).toEqual(["task3"]);
            expect(error.mismatchDetails.differing).toHaveLength(2); // task1 has 2 differing fields

            // Check that differing details are specific
            const cronDiff = error.mismatchDetails.differing.find(d => d.field === 'cronExpression');
            const retryDiff = error.mismatchDetails.differing.find(d => d.field === 'retryDelayMs');

            expect(cronDiff).toBeTruthy();
            expect(cronDiff.name).toBe("task1");
            expect(cronDiff.expected).toBe("0 * * * *");
            expect(cronDiff.actual).toBe("0 */2 * * *");

            expect(retryDiff).toBeTruthy();
            expect(retryDiff.name).toBe("task1");
            expect(retryDiff.expected).toBe(COMMON.FIVE_MINUTES.toMilliseconds());
            expect(retryDiff.actual).toBe(COMMON.THIRTY_MINUTES.toMilliseconds());
            await capabilities.scheduler.stop(capabilities);
        });

        test("handles empty registrations with empty persisted state", async () => {
            const capabilities = getTestCapabilities();
            const registrations = [];

            // Should succeed with no tasks
            await expect(capabilities.scheduler.initialize(registrations)).resolves.toBeUndefined();

            // Should be idempotent
            await expect(capabilities.scheduler.initialize(registrations)).resolves.toBeUndefined();
            await capabilities.scheduler.stop(capabilities);
        });

        test("logs appropriate messages for first-time initialization", async () => {
            const capabilities = getTestCapabilities();
            const registrations = [
                ["task1", "0 * * * *", jest.fn(), COMMON.FIVE_MINUTES],
                ["task2", "0 0 * * *", jest.fn(), COMMON.TEN_MINUTES],
            ];

            await capabilities.scheduler.initialize(registrations);

            // Should log first-time initialization message
            expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
                {
                    registeredTaskCount: 2,
                    taskNames: ["task1", "task2"]
                },
                "First-time scheduler initialization: registering initial tasks"
            );

            await capabilities.scheduler.stop(capabilities);
        });
    });

    describe("task execution behavior during initialize", () => {
        // Use real timers for these tests as they test actual scheduler polling behavior

        test("initialize sets up scheduler to execute tasks at proper times", async () => {
            const taskCallback = jest.fn().mockResolvedValue(undefined);

            const registrations = [
                // Task that should run every minute
                ["test-task", "* * * * *", taskCallback, COMMON.FIVE_MINUTES],
            ];

            const capabilities = getTestCapabilities();

            // Initialize the scheduler with very short poll interval for testing
            await capabilities.scheduler.initialize(registrations);

            // Wait for at least one poll cycle to execute
            await new Promise(resolve => setTimeout(resolve, 150));

            // Task should have been executed because it's due to run (first time)
            expect(taskCallback).toHaveBeenCalled();
            await capabilities.scheduler.stop(capabilities);
        });

        test("initialize is idempotent - can be called multiple times safely", async () => {
            const taskCallback = jest.fn().mockResolvedValue(undefined);

            const registrations = [
                ["test-task", "* * * * *", taskCallback, COMMON.FIVE_MINUTES],
            ];

            const capabilities = getTestCapabilities();

            // First call to initialize
            await capabilities.scheduler.initialize(registrations);

            // Wait for initial execution
            await new Promise(resolve => setTimeout(resolve, 150));

            // Task should have been called
            expect(taskCallback).toHaveBeenCalled();

            // Second call to initialize with same capabilities - should be idempotent
            // This should not cause errors or duplicate scheduling issues
            await expect(capabilities.scheduler.initialize(registrations)).resolves.toBeUndefined();
            await capabilities.scheduler.stop(capabilities);
        });

        test("scheduler executes tasks based on cron schedule", async () => {
            const taskCallback = jest.fn().mockResolvedValue(undefined);

            const registrations = [
                // Simple task that runs every minute
                ["minute-task", "* * * * *", taskCallback, COMMON.FIVE_MINUTES],
            ];

            const capabilities = getTestCapabilities();

            await capabilities.scheduler.initialize(registrations);

            // Wait for execution
            await new Promise(resolve => setTimeout(resolve, 150));

            // Task should execute on first run
            expect(taskCallback).toHaveBeenCalled();
            await capabilities.scheduler.stop(capabilities);
        });
    });
});
