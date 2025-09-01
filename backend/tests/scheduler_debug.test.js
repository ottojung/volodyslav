/**
 * Debug test to understand task execution behavior.
 */

const { Duration } = require("luxon");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper, getDatetimeControl, stubScheduler, getSchedulerControl } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubSleeper(capabilities);
    // NOTE: NOT stubbing runtime state storage
    stubScheduler(capabilities);
    return capabilities;
}

describe("scheduler debug", () => {
    test("debug task execution", async () => {
        const capabilities = getTestCapabilities();
        const schedulerControl = getSchedulerControl(capabilities);
        schedulerControl.setPollingInterval(50);
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = Duration.fromMillis(1000);

        let executions = 0;
        const task = jest.fn(async () => {
            console.log(`Task executing! Count: ${++executions}`);
        });

        // Use a simple schedule
        const registrations = [
            ["debug-task", "0 * * * *", task, retryDelay], // Every hour
        ];

        // Set time to trigger
        const startTime = new Date("2021-01-01T01:00:00.000Z").getTime();
        timeControl.setTime(startTime);

        console.log("Initializing scheduler...");
        await capabilities.scheduler.initialize(registrations);
        
        console.log("Waiting for first cycle...");
        await schedulerControl.waitForNextCycleEnd();

        console.log(`After first cycle: executions=${executions}`);
        console.log(`Task mock call count: ${task.mock.calls.length}`);

        await capabilities.scheduler.stop();
    });
});