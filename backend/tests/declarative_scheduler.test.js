/**
 * Tests for the new declarative scheduler functionality.
 */

const { 
    initialize, 
    TaskListMismatchError, 
    isTaskListMismatchError,
    _resetState 
} = require("../src/schedule");
const { 
    stubLogger, 
    stubEnvironment,
    stubSleeper,
    stubDatetime,
} = require("./stubs");
const { getMockedRootCapabilities } = require("./spies");
const { COMMON } = require("../src/time_duration");

// Mock the cron scheduler
jest.mock("../src/cron", () => ({
    make: jest.fn(() => ({
        schedule: jest.fn().mockResolvedValue("mocked-name"),
    })),
}));

const cronScheduler = require("../src/cron");

// Mock the runtime state storage
jest.mock("../src/runtime_state_storage", () => ({
    transaction: jest.fn(),
}));

const { transaction } = require("../src/runtime_state_storage");

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
        // Reset module state for each test
        _resetState();
    });

    describe("initialize", () => {
        test("succeeds when registrations match persisted state", async () => {
            const capabilities = getTestCapabilities();
            
            // Mock transaction to return matching state
            transaction.mockImplementation(async (caps, callback) => {
                const mockStorage = {
                    getCurrentState: jest.fn().mockResolvedValue({
                        version: 2,
                        startTime: "2023-01-01T00:00:00Z",
                        tasks: [
                            {
                                name: "test-task",
                                cronExpression: "0 * * * *",
                                retryDelayMs: 300000,
                            },
                        ],
                    }),
                };
                return await callback(mockStorage);
            });

            const registrations = [
                ["test-task", "0 * * * *", jest.fn(), COMMON.FIVE_MINUTES],
            ];

            // Should not throw
            await expect(initialize(capabilities, registrations)).resolves.toBeUndefined();
            
            // Should call cron scheduler
            expect(cronScheduler.make).toHaveBeenCalledWith(capabilities);
        });

        test("is idempotent - calling twice does nothing on second call", async () => {
            // This test needs to use a fresh module instance since we need to test idempotency
            // within the same test context, not across different test runs
            const capabilities = getTestCapabilities();
            
            // Mock transaction to return matching state
            transaction.mockImplementation(async (caps, callback) => {
                const mockStorage = {
                    getCurrentState: jest.fn().mockResolvedValue({
                        version: 2,
                        startTime: "2023-01-01T00:00:00Z",
                        tasks: [
                            {
                                name: "test-task",
                                cronExpression: "0 * * * *",
                                retryDelayMs: 300000,
                            },
                        ],
                    }),
                };
                return await callback(mockStorage);
            });

            const registrations = [
                ["test-task", "0 * * * *", jest.fn(), COMMON.FIVE_MINUTES],
            ];

            // First call
            await initialize(capabilities, registrations);
            
            // Clear the mock call count
            cronScheduler.make.mockClear();
            
            // Second call should not invoke any additional setup
            await initialize(capabilities, registrations);
            
            // Should not call cron scheduler on second call
            expect(cronScheduler.make).toHaveBeenCalledTimes(0);
        });

        test("throws TaskListMismatchError when tasks are missing from registrations", async () => {
            const capabilities = getTestCapabilities();
            
            // Mock transaction to return state with extra tasks
            transaction.mockImplementation(async (caps, callback) => {
                const mockStorage = {
                    getCurrentState: jest.fn().mockResolvedValue({
                        version: 2,
                        startTime: "2023-01-01T00:00:00Z",
                        tasks: [
                            {
                                name: "missing-task",
                                cronExpression: "0 2 * * *",
                                retryDelayMs: 300000,
                            },
                            {
                                name: "test-task",
                                cronExpression: "0 * * * *",
                                retryDelayMs: 300000,
                            },
                        ],
                    }),
                };
                return await callback(mockStorage);
            });

            const registrations = [
                ["test-task", "0 * * * *", jest.fn(), COMMON.FIVE_MINUTES],
            ];

            await expect(initialize(capabilities, registrations)).rejects.toThrow(TaskListMismatchError);
            
            try {
                await initialize(capabilities, registrations);
            } catch (error) {
                expect(isTaskListMismatchError(error)).toBe(true);
                expect(error.mismatchDetails.missing).toEqual(["missing-task"]);
                expect(error.mismatchDetails.extra).toEqual([]);
                expect(error.message).toContain("missing-task");
            }
        });

        test("throws TaskListMismatchError when registrations have extra tasks", async () => {
            const capabilities = getTestCapabilities();
            
            // Mock transaction to return empty state
            transaction.mockImplementation(async (caps, callback) => {
                const mockStorage = {
                    getCurrentState: jest.fn().mockResolvedValue({
                        version: 2,
                        startTime: "2023-01-01T00:00:00Z",
                        tasks: [],
                    }),
                };
                return await callback(mockStorage);
            });

            const registrations = [
                ["extra-task", "0 * * * *", jest.fn(), COMMON.FIVE_MINUTES],
            ];

            await expect(initialize(capabilities, registrations)).rejects.toThrow(TaskListMismatchError);
            
            try {
                await initialize(capabilities, registrations);
            } catch (error) {
                expect(isTaskListMismatchError(error)).toBe(true);
                expect(error.mismatchDetails.missing).toEqual([]);
                expect(error.mismatchDetails.extra).toEqual(["extra-task"]);
                expect(error.message).toContain("extra-task");
            }
        });

        test("throws TaskListMismatchError when task properties differ", async () => {
            const capabilities = getTestCapabilities();
            
            // Mock transaction to return state with different cron expression
            transaction.mockImplementation(async (caps, callback) => {
                const mockStorage = {
                    getCurrentState: jest.fn().mockResolvedValue({
                        version: 2,
                        startTime: "2023-01-01T00:00:00Z",
                        tasks: [
                            {
                                name: "test-task",
                                cronExpression: "0 2 * * *", // Different from registration
                                retryDelayMs: 300000,
                            },
                        ],
                    }),
                };
                return await callback(mockStorage);
            });

            const registrations = [
                ["test-task", "0 * * * *", jest.fn(), COMMON.FIVE_MINUTES], // Different cron expression
            ];

            await expect(initialize(capabilities, registrations)).rejects.toThrow(TaskListMismatchError);
            
            try {
                await initialize(capabilities, registrations);
            } catch (error) {
                expect(isTaskListMismatchError(error)).toBe(true);
                expect(error.mismatchDetails.differing).toHaveLength(1);
                expect(error.mismatchDetails.differing[0]).toEqual({
                    name: "test-task",
                    field: "cronExpression",
                    expected: "0 2 * * *",
                    actual: "0 * * * *",
                });
            }
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