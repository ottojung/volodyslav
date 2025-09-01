/**
 * Test to verify the fix for the scheduler race condition bug.
 * This test demonstrates that task execution state is properly tracked
 * when not using stubbed runtime state storage.
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
    // NOTE: NOT stubbing runtime state storage to test real state persistence
    stubScheduler(capabilities);
    return capabilities;
}

describe("scheduler race condition fix verification", () => {
    test("should properly track task execution with real state storage", async () => {
        const capabilities = getTestCapabilities();
        const schedulerControl = getSchedulerControl(capabilities);
        schedulerControl.setPollingInterval(50);
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = Duration.fromMillis(1000);

        let executions = 0;
        const task = jest.fn(async () => {
            executions++;
        });

        // Use a schedule compatible with real polling - every hour should work
        const registrations = [
            ["test-task", "0 * * * *", task, retryDelay], // Every hour at minute 0
        ];

        // Set time to exactly when the task should trigger (start of hour)
        const startTime = new Date("2021-01-01T03:00:00.000Z").getTime();
        timeControl.setTime(startTime);

        console.log(`Starting at: ${new Date(startTime).toISOString()}`);
        
        await capabilities.scheduler.initialize(registrations);
        await schedulerControl.waitForNextCycleEnd();

        console.log(`After first cycle: executions=${executions}`);

        // Task should execute once
        expect(executions).toBe(1);

        // Advance to next hour (4:00:00)
        timeControl.advanceTime(60 * 60 * 1000);
        console.log(`Advanced to: ${new Date(startTime + 60 * 60 * 1000).toISOString()}`);
        await schedulerControl.waitForNextCycleEnd();

        console.log(`After second cycle: executions=${executions}`);

        // Task should execute again
        expect(executions).toBe(2);

        // Advance to next hour again (5:00:00)  
        timeControl.advanceTime(60 * 60 * 1000);
        console.log(`Advanced to: ${new Date(startTime + 2 * 60 * 60 * 1000).toISOString()}`);
        await schedulerControl.waitForNextCycleEnd();

        console.log(`After third cycle: executions=${executions}`);

        // Task should execute a third time
        expect(executions).toBe(3);

        await capabilities.scheduler.stop();

        console.log(`Total executions: ${executions}`);
    });

    test("should handle task failures properly with real state storage", async () => {
        const capabilities = getTestCapabilities();
        const schedulerControl = getSchedulerControl(capabilities);
        schedulerControl.setPollingInterval(50);
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = Duration.fromMillis(5 * 60 * 1000); // 5 minute retry delay

        let executions = 0;
        let shouldFail = true;

        const flakyTask = jest.fn(async () => {
            executions++;
            if (shouldFail) {
                shouldFail = false; // Only fail once
                throw new Error("Task failure");
            }
        });

        const registrations = [
            ["flaky-task", "0 */2 * * *", flakyTask, retryDelay], // Every 2 hours
        ];

        // Set time to trigger the task
        const startTime = new Date("2021-01-01T02:00:00.000Z").getTime();
        timeControl.setTime(startTime);

        await capabilities.scheduler.initialize(registrations);
        await schedulerControl.waitForNextCycleEnd();

        // Task should execute once and fail
        expect(executions).toBe(1);

        // Advance by 5 minutes to trigger retry
        timeControl.advanceTime(5 * 60 * 1000);
        await schedulerControl.waitForNextCycleEnd();

        // Task should retry and succeed
        expect(executions).toBe(2);

        await capabilities.scheduler.stop();

        console.log(`Total executions: ${executions} (1 failure + 1 success)`);
    });
});