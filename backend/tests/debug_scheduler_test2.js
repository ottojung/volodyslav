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
    test("debug timing issue with detailed logging", async () => {
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

        // Wait for scheduler to start
        await new Promise(resolve => setTimeout(resolve, 100));

        console.log(`Initial calls: ${taskCallback.mock.calls.length}`);
        const initialCalls = taskCallback.mock.calls.length;
        
        // Now advance time to 00:30:00
        console.log("Advancing time to 00:30:00...");
        timeControl.advanceTime(25 * 60 * 1000); // 25 minutes to reach 00:30:00
        const afterAdvanceTime = timeControl.getCurrentTime();
        console.log(`After advance time: ${new Date(afterAdvanceTime).toISOString()}`);
        
        // Wait for polling
        await new Promise(resolve => setTimeout(resolve, 200)); 
        
        console.log(`Calls after first advance: ${taskCallback.mock.calls.length}`);
        
        // Now check at 00:30:01 in case timing is off by seconds
        timeControl.advanceTime(1000); // 1 second
        await new Promise(resolve => setTimeout(resolve, 200)); 
        console.log(`Calls after advancing to 00:30:01: ${taskCallback.mock.calls.length}`);

        await capabilities.scheduler.stop();
    });
});