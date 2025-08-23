/**
 * Tests for success persistence.
 */

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

describe("success persistence", () => {
    test("state persistence roundtrip preserves task metadata", async () => {
        const capabilities = getTestCapabilities();
        
        // Test basic state persistence without relying on scheduler execution
        await capabilities.state.transaction(async (storage) => {
            const currentState = await storage.getCurrentState();
            const taskWithSuccess = {
                version: 2,
                startTime: currentState.startTime,
                tasks: [
                    {
                        name: "test-task",
                        cronExpression: "0 * * * *",
                        retryDelayMs: 1000,
                        lastSuccessTime: capabilities.datetime.fromISOString("2020-01-01T00:00:00Z"),
                        lastAttemptTime: capabilities.datetime.fromISOString("2020-01-01T00:00:00Z")
                    }
                ]
            };
            storage.setState(taskWithSuccess);
        });
        
        // Verify state was persisted correctly
        await capabilities.state.transaction(async (storage) => {
            const reloadedState = await storage.getExistingState();
            expect(reloadedState).not.toBeNull();
            expect(reloadedState.tasks).toHaveLength(1);
            expect(reloadedState.tasks[0].name).toBe("test-task");
            expect(reloadedState.tasks[0].lastSuccessTime).toBeTruthy();
        });
    });
});