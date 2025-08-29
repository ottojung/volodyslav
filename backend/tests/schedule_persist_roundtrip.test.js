/**
 * Tests for schedule persistence roundtrip.
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

describe("schedule persist roundtrip", () => {
    let testCapabilities = null;

    beforeEach(() => {
        testCapabilities = getTestCapabilities();
    });

    afterEach(async () => {
        if (testCapabilities) {
            await testCapabilities.scheduler.stop();
            testCapabilities = null;
            // Give a small delay for async cleanup to complete
            await new Promise(resolve => setTimeout(resolve, 50));
        }
    });

    test("schedule, persist, reload -> task present with same cron and retryDelayMs", async () => {
        const capabilities = testCapabilities;
        
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
        
        // Note: scheduler.stop() will be called in afterEach
        
        // Allow cleanup time
        await new Promise(resolve => setTimeout(resolve, 100));
    });
});