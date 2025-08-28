// @ts-check
/**
 * Debug version of the failing time advancement test.
 */

const { getTestCapabilities, stubDatetime, stubLogger, stubRuntimeStateStorage, stubScheduler, stubSleeper, stubPollInterval, getDatetimeControl } = require("./stubs");
const { fromMilliseconds } = require("../src/time_duration");

function getDebugCapabilities() {
    const capabilities = getTestCapabilities();
    stubSleeper(capabilities);
    stubRuntimeStateStorage(capabilities);
    stubPollInterval(1); // Fast polling for tests - use real timers
    return capabilities;
}

describe("debug scheduler time advancement", () => {
    test("debug timing issue", async () => {
        const capabilities = getDebugCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = fromMilliseconds(5000);
        const taskCallback = jest.fn();

        // Set initial time to 00:05:00
        const startTime = new Date("2021-01-01T00:05:00.000Z").getTime();
        timeControl.setTime(startTime);
        console.log(`Start time: ${new Date(startTime).toISOString()}`);

        // Schedule a task that runs at 30 minutes past each hour
        const registrations = [
            ["half-hour-task", "30 * * * *", taskCallback, retryDelay] // Runs at minute 30 of each hour
        ];

        console.log("Initializing scheduler...");
        await capabilities.scheduler.initialize(registrations);

        // Wait for scheduler to start and possibly catch up
        await new Promise(resolve => setTimeout(resolve, 100));

        console.log(`Initial calls: ${taskCallback.mock.calls.length}`);
        const initialCalls = taskCallback.mock.calls.length;
        
        // Now test that advancing time triggers new executions
        // Advance time to 00:30:00 (first execution after initialization)
        console.log("Advancing time to 00:30:00...");
        timeControl.advanceTime(25 * 60 * 1000); // 25 minutes to reach 00:30:00
        const afterAdvanceTime = timeControl.getCurrentTime();
        console.log(`After advance time: ${new Date(afterAdvanceTime).toISOString()}`);
        
        await new Promise(resolve => setTimeout(resolve, 200)); // Wait longer for polling
        
        console.log(`Calls after first advance: ${taskCallback.mock.calls.length}`);
        
        // Let's manually trigger a poll to see if that helps
        if (capabilities.scheduler.poll) {
            console.log("Manually triggering poll...");
            await capabilities.scheduler.poll();
            console.log(`Calls after manual poll: ${taskCallback.mock.calls.length}`);
        }

        await capabilities.scheduler.stop();
    });
});