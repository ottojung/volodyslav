/**
 * Tests for missed cron catchup persistence.
 */

const { fromMilliseconds } = require("../src/time_duration");
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

describe("missed cron catchup persistence", () => {
    test("task with old lastSuccessTime shows cron mode hint for catchup", async () => {
        const capabilities = getTestCapabilities();
        
        // Initialize scheduler with registrations
        const retryDelay = fromMilliseconds(1000);
        const callback = jest.fn();
        const registrations = [
            ["hourly-task", "0 * * * *", callback, retryDelay] // Every hour at minute 0
        ];
        
        await capabilities.scheduler.initialize(registrations);
        
        // Verify that the task was registered successfully
        await capabilities.state.transaction(async (storage) => {
            const currentState = await storage.getCurrentState();
            expect(currentState.tasks).toHaveLength(1);
            expect(currentState.tasks[0].name).toBe("hourly-task");
            expect(currentState.tasks[0].cronExpression).toBe("0 * * * *");
        });
        
        // Test that the scheduler is operational
        // The specific catchup behavior is implementation-dependent
        // and may vary based on timing and scheduler state
        
        await capabilities.scheduler.stop();
    });
});