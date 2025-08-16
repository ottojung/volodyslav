/**
 * Tests for success persistence.
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

describe("success persistence", () => {
    test("run success, persist, reload -> lastSuccessTime retained; modeHint reflects cron", async () => {
        jest.useFakeTimers().setSystemTime(new Date("2020-01-01T00:00:00Z"));
        
        const capabilities = getTestCapabilities();
        
        // Create scheduler and schedule a task
        const scheduler1 = makePollingScheduler(capabilities, { pollIntervalMs: 10 });
        const retryDelay = fromMilliseconds(1000);
        const callback = jest.fn();
        
        await scheduler1.schedule("test-task", "* * * * *", callback, retryDelay);
        
        // Allow first poll to run the task
        jest.advanceTimersByTime(10);
        expect(callback).toHaveBeenCalledTimes(1);
        
        // Allow time for persistence
        await Promise.resolve();
        
        await scheduler1.cancelAll();
        
        // Advance time to next minute
        jest.setSystemTime(new Date("2020-01-01T00:01:00Z"));
        
        // Create new scheduler (simulating restart)
        const scheduler2 = makePollingScheduler(capabilities, { pollIntervalMs: 10 });
        
        // Allow time for state loading
        await new Promise(resolve => setTimeout(resolve, 50));
        
        // Re-schedule the task with a new callback
        const newCallback = jest.fn();
        await scheduler2.schedule("test-task", "* * * * *", newCallback, retryDelay);
        
        // Verify task has lastSuccessTime from before restart
        const tasks = await scheduler2.getTasks();
        expect(tasks).toHaveLength(1);
        expect(tasks[0].lastSuccessTime).toBeTruthy();
        expect(tasks[0].modeHint).toBe("cron"); // Should be due for next run
        
        // Verify state persistence includes lastSuccessTime
        await transaction(capabilities, async (storage) => {
            const currentState = await storage.getExistingState();
            expect(currentState.tasks[0].lastSuccessTime).toBeTruthy();
        });
        
        await scheduler2.cancelAll();
        jest.useRealTimers();
    });
});