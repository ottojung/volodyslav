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
    beforeEach(() => {
        jest.clearAllMocks();
    });

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