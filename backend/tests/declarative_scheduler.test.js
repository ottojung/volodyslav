/**
 * Tests for the new declarative scheduler functionality.
 */

const { 
    initialize, 
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