/**
 * Tests for duplicate task handling in persisted state.
 */

const { transaction } = require("../src/runtime_state_storage");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubRuntimeStateStorage } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubRuntimeStateStorage(capabilities);
    return capabilities;
}

describe("duplicate in state skipped", () => {
    test("craft file with duplicate names; load -> second skipped with WARN", async () => {
        const capabilities = getTestCapabilities();
        
        // Test the duplicate detection logic directly through state storage
        await transaction(capabilities, async (storage) => {
            const currentState = await storage.getCurrentState();
            const duplicateState = {
                version: 2,
                startTime: currentState.startTime,
                tasks: [
                    {
                        name: "duplicate-task",
                        cronExpression: "0 * * * *",
                        retryDelayMs: 1000,
                    },
                    {
                        name: "duplicate-task", // Same name - should be skipped
                        cronExpression: "30 * * * *",
                        retryDelayMs: 2000,
                    },
                    {
                        name: "unique-task",
                        cronExpression: "0 12 * * *",
                        retryDelayMs: 1500,
                    },
                ]
            };
            storage.setState(duplicateState);
        });
        
        // Verify duplicate was logged as skipped during state deserialization
        await transaction(capabilities, async (storage) => {
            await storage.getExistingState(); // This triggers deserialization and duplicate detection
        });
        
        expect(capabilities.logger.logWarning).toHaveBeenCalledWith(
            expect.objectContaining({
                value: "duplicate-task",
                errorType: "TaskInvalidValueError"
            }),
            "SkippedInvalidTask"
        );
    });
});