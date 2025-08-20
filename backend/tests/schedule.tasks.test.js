/**
 * Tests for schedule tasks functionality.
 */

const {
    stubLogger,
    stubEnvironment,
    stubAiTranscriber,
    stubNotifier,
    stubScheduler,
} = require("./stubs");

const { everyHour, daily, allTasks, scheduleAll } = require("../src/schedule/tasks");
const { getMockedRootCapabilities } = require("./spies");
const { _resetState } = require("../src/schedule");

// Mock the runtime state storage
jest.mock("../src/runtime_state_storage", () => ({
    transaction: jest.fn(),
}));

const { transaction } = require("../src/runtime_state_storage");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubLogger(capabilities);
    stubEnvironment(capabilities);
    stubAiTranscriber(capabilities);
    stubNotifier(capabilities);
    stubScheduler(capabilities);
    return capabilities;
}

describe("Schedule Tasks", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        _resetState();
        
        // Mock transaction to return matching state for the expected tasks
        transaction.mockImplementation(async (caps, callback) => {
            const mockStorage = {
                getCurrentState: jest.fn().mockResolvedValue({
                    version: 2,
                    startTime: "2023-01-01T00:00:00Z",
                    tasks: [
                        {
                            name: "every-hour",
                            cronExpression: "0 * * * *",
                            retryDelayMs: 300000,
                        },
                        {
                            name: "daily-2am",
                            cronExpression: "0 2 * * *",
                            retryDelayMs: 300000,
                        },
                    ],
                }),
            };
            return await callback(mockStorage);
        });
    });

    describe("daily", () => {
        test("logs info message when starting", async () => {
            const capabilities = getTestCapabilities();

            await daily(capabilities);

            expect(capabilities.logger.logInfo).toHaveBeenCalledWith({}, "Running daily tasks");
        });

        test("completes without throwing errors", async () => {
            const capabilities = getTestCapabilities();

            await expect(daily(capabilities)).resolves.toBeUndefined();
        });
    });

    describe("everyHour", () => {
        test("logs info message when starting", async () => {
            const capabilities = getTestCapabilities();

            await everyHour(capabilities);

            expect(capabilities.logger.logInfo).toHaveBeenCalledWith({}, "Running every hour tasks");
        });

        test("completes without throwing errors", async () => {
            const capabilities = getTestCapabilities();

            await expect(everyHour(capabilities)).resolves.toBeUndefined();
        });
    });

    describe("allTasks", () => {
        test("completes without throwing errors", async () => {
            const capabilities = getTestCapabilities();

            await expect(allTasks(capabilities)).resolves.toBeUndefined();
        });
    });

    describe("scheduleAll", () => {
        test("initializes the declarative scheduler with both tasks", async () => {
            const capabilities = getTestCapabilities();

            await expect(scheduleAll(capabilities)).resolves.toBeUndefined();
            
            // Should call transaction to validate state
            expect(transaction).toHaveBeenCalled();
        });
    });
});
