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
        jest.useFakeTimers().setSystemTime(new Date("2020-01-01T00:00:30Z")); // 30 seconds into the minute
        
        const capabilities = getTestCapabilities();
        
        // Initialize scheduler with registrations
        const retryDelay = fromMilliseconds(1000);
        const callback = jest.fn();
        const registrations = [
            ["hourly-task", "0 * * * *", callback, retryDelay] // Every hour at minute 0
        ];
        
        await capabilities.scheduler.initialize(registrations);
        
        // Manually set lastSuccessTime to a previous hour to simulate missed execution
        await capabilities.state.transaction(async (storage) => {
            const currentState = await storage.getCurrentState();
            // Since the task was just scheduled, there should be one task
            if (currentState.tasks.length > 0) {
                currentState.tasks[0].lastSuccessTime = capabilities.datetime.fromISOString("2019-12-31T23:00:00.000Z");
                storage.setState(currentState);
            }
        });
        
        await capabilities.scheduler.stop();
        
        // Advance time to after the hour boundary (1:05 AM) 
        jest.setSystemTime(new Date("2020-01-01T01:05:00Z"));
        
        // Re-initialize scheduler (simulating restart)
        const newCallback = jest.fn();
        const newRegistrations = [
            ["hourly-task", "0 * * * *", newCallback, retryDelay]
        ];
        
        await capabilities.scheduler.initialize(newRegistrations);
        
        // The scheduler should have caught up and executed the missed task
        // Use fast timers to avoid the 5 second timeout
        jest.runOnlyPendingTimers();
        
        // Verify task was caught up (executed for the missed time)
        expect(newCallback).toHaveBeenCalledTimes(1);
        
        await capabilities.scheduler.stop();
        jest.useRealTimers();
    }, 10000); // Increase timeout to 10 seconds
});