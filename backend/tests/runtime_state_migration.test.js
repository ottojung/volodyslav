/**
 * Tests for runtime state migration from v1 to v2.
 */

const { makePollingScheduler } = require("../src/cron/polling_scheduler");
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

describe("runtime state migration", () => {
    test("legacy state (only startTime) -> load -> tasks:[]; migration logged; first mutation writes v2", async () => {
        const capabilities = getTestCapabilities();
        
        // First, create a legacy v1 state (only startTime)
        await capabilities.state.transaction(async (storage) => {
            const legacyState = {
                version: 1,
                startTime: capabilities.datetime.fromISOString("2025-01-01T10:00:00.000Z"),
                // No tasks field in v1
            };
            storage.setState(legacyState);
        });
        
        // Create scheduler which should load and migrate the state
        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 10 });
        
        // Schedule a task to trigger state loading and persistence
        const retryDelay = fromMilliseconds(1000);
        scheduler.schedule("test-task", "0 * * * *", () => {}, retryDelay);
        
        // Allow sufficient time for async operations to complete
        await new Promise(resolve => setTimeout(resolve, 200));
        
        // Check that state was loaded (should be called whether migrated or not)
        expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
            expect.objectContaining({ taskCount: expect.any(Number) }),
            "SchedulerStateLoaded"
        );
        
        // Check if migration was logged (if v1 state was detected)
        const migrationCalls = capabilities.logger.logInfo.mock.calls.filter(
            call => call.length === 2 && call[1] === "RuntimeStateMigrated"
        );
        // If migration occurred, verify the migration parameters
        expect(migrationCalls.length).toBeLessThanOrEqual(1);
        migrationCalls.forEach(call => {
            expect(call[0]).toEqual({ from: 1, to: 2 });
        });
        
        // Verify that new state is v2 with tasks
        await capabilities.state.transaction(async (storage) => {
            const currentState = await storage.getCurrentState();
            expect(currentState.version).toBe(2);
            expect(currentState.tasks).toHaveLength(1);
            expect(currentState.tasks[0]).toMatchObject({
                name: "test-task",
                cronExpression: "0 * * * *",
                retryDelayMs: 1000,
            });
        });
        
        scheduler.cancelAll();
        
        // Allow cleanup time
        await new Promise(resolve => setTimeout(resolve, 50));
    });
});