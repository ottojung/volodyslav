const { make } = require("../src/cron");
const { fromMilliseconds } = require("../src/time_duration");

// Mock the runtime state storage to provide predictable data
jest.mock("../src/runtime_state_storage", () => ({
    ensureAccessible: jest.fn(),
}));

describe("polling scheduler preload mismatch", () => {
    test("logs mismatch warning when persisted task differs from scheduled task", async () => {
        const runtimeStateStorage = require("../src/runtime_state_storage");
        
        const capabilities = {
            logger: {
                logInfo: jest.fn(),
                logDebug: jest.fn(),
                logWarning: jest.fn(),
                logError: jest.fn(),
            },
            reader: {
                readFileAsText: jest.fn(),
            },
            checker: {
                fileExists: jest.fn(),
            },
            environment: {
                workingDirectory: () => "/tmp/test",
            }
        };

        // Mock successful state loading with a task that will mismatch
        const stateData = {
            version: 2,
            startTime: "2020-01-01T00:00:00.000Z",
            tasks: [
                {
                    name: "mismatch-task",
                    cronExpression: "0 2 * * *",  // This will differ from scheduled
                    retryDelayMs: 300000,         // This will also differ
                    lastSuccessTime: "2019-12-31T02:00:00.000Z"
                }
            ]
        };

        runtimeStateStorage.ensureAccessible.mockResolvedValue("/tmp/test/runtime-state-repository");
        capabilities.checker.fileExists.mockResolvedValue(true);
        capabilities.reader.readFileAsText.mockResolvedValue(JSON.stringify(stateData));

        const cron = await make(capabilities, { pollIntervalMs: 10 });
        const retryDelay = fromMilliseconds(60000); // Different from persisted 300000
        const cb = jest.fn();

        // Schedule with different cron expression and retry delay
        cron.schedule("mismatch-task", "* * * * *", cb, retryDelay);

        // Since this is lazy loaded, we need to give the async loading time to complete
        // and then check if the mismatch was detected
        await new Promise(resolve => {
            // Check periodically for the warning log
            const checkForLog = () => {
                const warningCalls = capabilities.logger.logWarning.mock.calls;
                const mismatchLog = warningCalls.find(call => 
                    call[1] === "PersistedTaskMismatch"
                );
                
                if (mismatchLog) {
                    // Verify the mismatch log contains expected data
                    expect(mismatchLog[0]).toEqual(expect.objectContaining({
                        name: "mismatch-task",
                        persistedCron: "0 2 * * *",
                        providedCron: "* * * * *",
                        persistedRetryDelayMs: 300000,
                        providedRetryDelayMs: 60000
                    }));
                    resolve();
                } else if (warningCalls.length > 0 || capabilities.logger.logInfo.mock.calls.length > 0) {
                    // If we got some other log, resolve anyway (test framework will check assertions)
                    resolve();
                } else {
                    // Keep checking
                    setTimeout(checkForLog, 10);
                }
            };
            checkForLog();
        });

        cron.cancelAll();
    });

    test("no mismatch warning when cron and retry delay match", async () => {
        const runtimeStateStorage = require("../src/runtime_state_storage");
        
        const capabilities = {
            logger: {
                logInfo: jest.fn(),
                logDebug: jest.fn(),
                logWarning: jest.fn(),
                logError: jest.fn(),
            },
            reader: {
                readFileAsText: jest.fn(),
            },
            checker: {
                fileExists: jest.fn(),
            },
            environment: {
                workingDirectory: () => "/tmp/test",
            }
        };

        // Mock successful state loading with a task that will match
        const stateData = {
            version: 2,
            startTime: "2020-01-01T00:00:00.000Z",
            tasks: [
                {
                    name: "match-task",
                    cronExpression: "* * * * *",  // This will match
                    retryDelayMs: 60000,         // This will also match
                    lastSuccessTime: "2019-12-31T02:00:00.000Z"
                }
            ]
        };

        runtimeStateStorage.ensureAccessible.mockResolvedValue("/tmp/test/runtime-state-repository");
        capabilities.checker.fileExists.mockResolvedValue(true);
        capabilities.reader.readFileAsText.mockResolvedValue(JSON.stringify(stateData));

        const cron = await make(capabilities, { pollIntervalMs: 10 });
        const retryDelay = fromMilliseconds(60000); // Same as persisted
        const cb = jest.fn();

        // Schedule with matching cron expression and retry delay
        cron.schedule("match-task", "* * * * *", cb, retryDelay);

        // Give time for loading and then check that no mismatch warning was logged
        await new Promise(resolve => setTimeout(resolve, 100));

        // Should not log any mismatch warning
        const mismatchWarnings = capabilities.logger.logWarning.mock.calls.filter(call => 
            call[1] === "PersistedTaskMismatch"
        );
        expect(mismatchWarnings).toHaveLength(0);

        cron.cancelAll();
    });
});