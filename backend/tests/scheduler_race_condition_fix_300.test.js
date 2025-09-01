/**
 * Test that verifies the fix for scheduler race condition issue #300.
 * 
 * This test demonstrates that the scheduler properly handles task execution
 * state tracking when NOT using stubbed runtime state storage. Before the fix,
 * there was a race condition where lastAttemptTime was set during evaluation
 * instead of execution, causing tasks to be incorrectly marked as "already run".
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
    // Critical: NOT stubbing runtime state storage to test real persistence behavior
    stubScheduler(capabilities);
    return capabilities;
}

describe("scheduler race condition fix #300", () => {
    test("should execute task at least once with real state persistence", async () => {
        const capabilities = getTestCapabilities();
        const schedulerControl = getSchedulerControl(capabilities);
        schedulerControl.setPollingInterval(50);
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = Duration.fromMillis(1000);

        let executions = 0;
        const task = jest.fn(async () => {
            executions++;
        });

        // Use hourly schedule compatible with real polling frequency
        const registrations = [
            ["fix-test-task", "0 * * * *", task, retryDelay], // Every hour at minute 0
        ];

        // Start at exactly 03:00:00 to trigger the task
        const startTime = new Date("2021-01-01T03:00:00.000Z").getTime();
        timeControl.setTime(startTime);

        await capabilities.scheduler.initialize(registrations);
        await schedulerControl.waitForNextCycleEnd();

        // Task should execute at least once - this verifies the race condition is fixed
        // Before the fix, even this might fail due to state corruption
        expect(executions).toBeGreaterThanOrEqual(1);

        await capabilities.scheduler.stop();
    });
});