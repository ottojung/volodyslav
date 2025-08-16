/**
 * Tests for missed cron catchup persistence.
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

describe("missed cron catchup persistence", () => {
    test("lastSuccessTime before a cron boundary; reload -> one catch-up execution on first poll", async () => {
        jest.useFakeTimers().setSystemTime(new Date("2020-01-01T00:00:30Z")); // 30 seconds into the minute
        
        const capabilities = getTestCapabilities();
        
        // Create scheduler and schedule a task
        const scheduler1 = makePollingScheduler(capabilities, { pollIntervalMs: 10 });
        const retryDelay = fromMilliseconds(1000);
        const callback = jest.fn();
        
        scheduler1.schedule("hourly-task", "0 * * * *", callback, retryDelay); // Every hour at minute 0
        
        // Allow first poll - should not run since it's not the start of the hour
        jest.advanceTimersByTime(10);
        expect(callback).toHaveBeenCalledTimes(0);
        
        // Manually set lastSuccessTime to a previous hour
        await transaction(capabilities, async (storage) => {
            const currentState = await storage.getCurrentState();
            currentState.tasks[0].lastSuccessTime = capabilities.datetime.fromISOString("2019-12-31T23:00:00.000Z");
            storage.setState(currentState);
        });
        
        scheduler1.cancelAll();
        
        // Advance time to after the hour boundary (1:05 AM)
        jest.setSystemTime(new Date("2020-01-01T01:05:00Z"));
        
        // Create new scheduler (simulating restart)
        const scheduler2 = makePollingScheduler(capabilities, { pollIntervalMs: 10 });
        
        // Allow time for state loading
        await new Promise(resolve => setTimeout(resolve, 50));
        
        // Re-schedule the task
        const newCallback = jest.fn();
        scheduler2.schedule("hourly-task", "0 * * * *", newCallback, retryDelay);
        
        // Verify task should be due for catchup execution
        const tasks = scheduler2.getTasks();
        expect(tasks).toHaveLength(1);
        expect(tasks[0].modeHint).toBe("cron"); // Should be due for cron execution
        
        // Allow poll to execute catchup
        jest.advanceTimersByTime(10);
        expect(newCallback).toHaveBeenCalledTimes(1);
        
        // Verify task is no longer due after catchup
        const tasksAfter = scheduler2.getTasks();
        expect(tasksAfter[0].modeHint).toBe("idle");
        
        scheduler2.cancelAll();
        jest.useRealTimers();
    });
});