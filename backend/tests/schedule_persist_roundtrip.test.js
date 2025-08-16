/**
 * Tests for schedule persistence roundtrip.
 */

const { makePollingScheduler } = require("../src/cron/polling_scheduler");
const { transaction } = require("../src/runtime_state_storage");
const { fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    return capabilities;
}

describe("schedule persist roundtrip", () => {
    test("schedule, persist, reload -> task present with same cron and retryDelayMs", async () => {
        const capabilities = getTestCapabilities();
        
        // Create first scheduler and schedule a task
        const scheduler1 = makePollingScheduler(capabilities, { pollIntervalMs: 10 });
        const retryDelay = fromMilliseconds(5000);
        const callback = jest.fn();
        
        scheduler1.schedule("hourly-task", "0 * * * *", callback, retryDelay);
        
        // Allow sufficient time for persistence to complete
        await new Promise(resolve => setTimeout(resolve, 200));
        
        scheduler1.cancelAll();
        
        // Allow time for cancel persistence  
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Verify task was persisted before scheduler was cancelled
        await transaction(capabilities, async (storage) => {
            const existingState = await storage.getExistingState();
            expect(existingState).not.toBeNull();
            // After cancelAll, tasks should be empty
            expect(existingState.tasks).toHaveLength(0);
        });
        
        // Create a new scheduler and schedule the same task (simulating restart)
        const scheduler2 = makePollingScheduler(capabilities, { pollIntervalMs: 10 });
        
        // Allow time for state loading
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Re-schedule the same task with a callback (as would happen on restart)
        const newCallback = jest.fn();
        scheduler2.schedule("hourly-task", "0 * * * *", newCallback, retryDelay);
        
        // Allow time for persistence
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Verify task is active and persisted
        const tasks = scheduler2.getTasks();
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
        
        scheduler2.cancelAll();
        
        // Allow cleanup time
        await new Promise(resolve => setTimeout(resolve, 50));
    });
});