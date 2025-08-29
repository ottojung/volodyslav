/**
 * Tests for failure retry persistence.
 */

const { fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper, getDatetimeControl, stubRuntimeStateStorage, stubScheduler, getSchedulerControl } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubSleeper(capabilities);
    stubRuntimeStateStorage(capabilities);
    stubScheduler(capabilities);
    return capabilities;
}

describe("failure retry persistence", () => {
    test("task failure sets pendingRetryUntil correctly", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);
        schedulerControl.setPollingInterval(1);

        // Set a fixed starting time 
        const startTime = new Date("2020-01-01T00:00:30Z").getTime();
        timeControl.setTime(startTime);

        // Initialize scheduler with registrations
        const retryDelay = fromMilliseconds(5000); // 5 second retry delay
        const callback = jest.fn(() => {
            throw new Error("Task failed");
        });
        const registrations = [
            ["failing-task", "0 * * * *", callback, retryDelay]
        ];

        await capabilities.scheduler.initialize(registrations);

        // Wait for scheduler to start and catch up (will execute for 00:00:00)
        await schedulerControl.waitForNextCycleEnd();

        // Check that task was executed and failed properly
        expect(callback).toHaveBeenCalledTimes(1);

        // Check persisted state to verify failure was recorded
        await capabilities.state.transaction(async (storage) => {
            const currentState = await storage.getExistingState();
            expect(currentState).not.toBeNull();
            expect(currentState.tasks).toHaveLength(1);
            const task = currentState.tasks[0];
            expect(task.pendingRetryUntil).toBeTruthy();
            expect(task.lastFailureTime).toBeTruthy();
        });

        // Advance time just enough to make retry due (but not trigger next cron)
        timeControl.advanceTime(10 * 1000); // 10 seconds (past the 5-second retry delay)
        await schedulerControl.waitForNextCycleEnd();

        // The task should have retried once more
        expect(callback).toHaveBeenCalledTimes(2); // Should have retried once

        await capabilities.scheduler.stop();
    });
});
