/**
 * Tests for missed cron catchup persistence.
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

describe("missed cron catchup persistence", () => {
    test("task with old lastSuccessTime shows cron mode hint for catchup", async () => {
        jest.useFakeTimers().setSystemTime(new Date("2020-01-01T00:00:30Z")); // 30 seconds into the minute
        
        const capabilities = getTestCapabilities();
        
        // Create scheduler and schedule a task
        const scheduler1 = makePollingScheduler(capabilities, { pollIntervalMs: 60000 }); // Longer interval to avoid race conditions
        const retryDelay = fromMilliseconds(1000);
        const callback = jest.fn();
        
        await scheduler1.schedule("hourly-task", "0 * * * *", callback, retryDelay); // Every hour at minute 0
        
        // Manually set lastSuccessTime to a previous hour to simulate missed execution
        await capabilities.state.transaction(async (storage) => {
            const currentState = await storage.getCurrentState();
            // Since the task was just scheduled, there should be one task
            if (currentState.tasks.length > 0) {
                currentState.tasks[0].lastSuccessTime = capabilities.datetime.fromISOString("2019-12-31T23:00:00.000Z");
                storage.setState(currentState);
            }
        });
        
        await scheduler1.cancelAll();
        
        // Advance time to after the hour boundary (1:05 AM) 
        jest.setSystemTime(new Date("2020-01-01T01:05:00Z"));
        
        // Create new scheduler (simulating restart)
        const scheduler2 = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
        
        // Re-schedule the task with same name to load persisted state
        const newCallback = jest.fn();
        await scheduler2.schedule("hourly-task", "0 * * * *", newCallback, retryDelay);
        
        // Verify task should be due for catchup execution
        const tasks = await scheduler2.getTasks();
        expect(tasks).toHaveLength(1);
        expect(tasks[0].modeHint).toBe("cron"); // Should be due for cron execution
        
        await scheduler2.cancelAll();
        jest.useRealTimers();
    });
});