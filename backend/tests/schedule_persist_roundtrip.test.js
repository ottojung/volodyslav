/**
 * Tests for schedule persistence roundtrip.
 */

const { fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubRuntimeStateStorage, stubScheduler } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubRuntimeStateStorage(capabilities);
    stubScheduler(capabilities);
    return capabilities;
}

describe("schedule persist roundtrip", () => {
    test("schedule, persist, reload -> task present with same cron and retryDelayMs", async () => {
        const capabilities = getTestCapabilities();
        
        // Initialize scheduler with registrations
        const retryDelay = fromMilliseconds(5000);
        const callback = jest.fn();
        const registrations = [
            ["hourly-task", "0 * * * *", callback, retryDelay]
        ];
        
        await capabilities.scheduler.initialize(registrations);
        
        // Allow sufficient time for persistence to complete
        await new Promise(resolve => setTimeout(resolve, 200));
        
        await capabilities.scheduler.stop();
        
        // Allow time for cleanup  
        await new Promise(resolve => setTimeout(resolve, 200));
        
        // Re-initialize the same scheduler (simulating restart)
        const newCallback = jest.fn();
        const newRegistrations = [
            ["hourly-task", "0 * * * *", newCallback, retryDelay]
        ];
        
        await capabilities.scheduler.initialize(newRegistrations);
        
        // Allow time for persistence
        await new Promise(resolve => setTimeout(resolve, 200));
        
        // Verify task was persisted correctly by checking state
        await capabilities.state.transaction(async (storage) => {
            const currentState = await storage.getExistingState();
            expect(currentState).not.toBeNull();
            expect(currentState.tasks).toHaveLength(1);
            expect(currentState.tasks[0]).toMatchObject({
                name: "hourly-task",
                cronExpression: "0 * * * *",
                retryDelayMs: 5000,
            });
        });
        
        await capabilities.scheduler.stop();
        
        // Allow cleanup time
        await new Promise(resolve => setTimeout(resolve, 100));
    });
});