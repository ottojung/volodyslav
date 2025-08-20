/**
 * Integration test to verify server can start with declarative scheduler.
 */

const { initialize } = require("../src/server");
const { getMockedRootCapabilities } = require("./spies");
const {
    stubLogger,
    stubEnvironment,
    stubAiTranscriber,
    stubNotifier,
    stubSleeper,
    stubDatetime,
} = require("./stubs");
const { _resetState } = require("../src/schedule");

// Mock express app
const mockApp = {
    use: jest.fn(),
};

// Mock the runtime state storage
jest.mock("../src/runtime_state_storage", () => ({
    transaction: jest.fn(),
}));

const { transaction } = require("../src/runtime_state_storage");

// Mock event log storage
jest.mock("../src/event_log_storage", () => ({
    ensureAccessible: jest.fn().mockResolvedValue(undefined),
}));

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubLogger(capabilities);
    stubEnvironment(capabilities);
    stubAiTranscriber(capabilities);
    stubNotifier(capabilities);
    stubSleeper(capabilities);
    stubDatetime(capabilities);
    
    // Mock the necessary methods that server initialization needs
    capabilities.environment.ensureEnvironmentIsInitialized = jest.fn().mockResolvedValue(undefined);
    capabilities.notifier.ensureNotificationsAvailable = jest.fn().mockResolvedValue(undefined);
    capabilities.git.ensureAvailable = jest.fn().mockResolvedValue(undefined);
    
    return capabilities;
}

describe("Server Integration with Declarative Scheduler", () => {
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

    test("server can initialize with declarative scheduler", async () => {
        const capabilities = getTestCapabilities();

        await expect(initialize(capabilities, mockApp)).resolves.toBeUndefined();
        
        // Should have logged initialization complete
        expect(capabilities.logger.logInfo).toHaveBeenCalledWith({}, "Initialization complete.");
        
        // Should have called transaction to validate scheduler state
        expect(transaction).toHaveBeenCalled();
    });
});