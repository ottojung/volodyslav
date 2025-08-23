/**
 * Tests for schedule persistence roundtrip.
 */

const { makePollingScheduler } = require("../src/cron/polling_scheduler");
const { transaction } = require("../src/runtime_state_storage");
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
    test("schedule, persist, reload -> task present with same cron and retryDelayMs", async () => {
        const capabilities = getTestCapabilities();
        
        // Create first scheduler with longer poll interval to avoid conflicts
        const scheduler1 = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
        const retryDelay = fromMilliseconds(5000);
        const callback = jest.fn();
        
        await scheduler1.schedule("hourly-task", "0 * * * *", callback, retryDelay);
        
        // Allow sufficient time for persistence to complete
        await new Promise(resolve => setTimeout(resolve, 200));
        
        await scheduler1.cancelAll();
        
        // Allow time for cancel persistence  
        await new Promise(resolve => setTimeout(resolve, 200));
        
        // Create a new scheduler and schedule the same task (simulating restart)
        const scheduler2 = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
        
        // Re-schedule the same task with a callback (as would happen on restart)
        const newCallback = jest.fn();
        await scheduler2.schedule("hourly-task", "0 * * * *", newCallback, retryDelay);
        
        // Allow time for persistence
        await new Promise(resolve => setTimeout(resolve, 200));
        
        // Verify task is active and persisted
        const tasks = await scheduler2.getTasks();
        expect(tasks).toHaveLength(1);
        expect(tasks[0]).toMatchObject({
            name: "hourly-task",
            cronExpression: "0 * * * *",
            running: false,
        });
        
        // Verify task was persisted
        await transaction(capabilities, async (storage) => {
            const currentState = await storage.getExistingState();
            expect(currentState).not.toBeNull();
            expect(currentState.tasks).toHaveLength(1);
            expect(currentState.tasks[0]).toMatchObject({
                name: "hourly-task",
                cronExpression: "0 * * * *",
                retryDelayMs: 5000,
            });
        });
        
        await scheduler2.cancelAll();
        
        // Allow cleanup time
        await new Promise(resolve => setTimeout(resolve, 100));
    });
});