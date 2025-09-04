/**
 * Tests for failure retry persistence.
 */

const { Duration, DateTime } = require("luxon");
const { fromEpochMs, fromObject } = require("../src/datetime");
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
        schedulerControl.setPollingInterval(fromObject({milliseconds: 1}));

        // Set a fixed starting time that does NOT match the cron schedule
        const startTime = DateTime.fromISO("2020-01-01T00:05:30.000Z").toMillis(); // 00:05:30 - doesn't match "0 * * * *"
        timeControl.setDateTime(fromEpochMs(startTime));

        // Initialize scheduler with registrations
        const retryDelay = Duration.fromMillis(5000); // 5 second retry delay
        const callback = jest.fn(() => {
            throw new Error("Task failed");
        });
        const registrations = [
            ["failing-task", "0 * * * *", callback, retryDelay]
        ];

        await capabilities.scheduler.initialize(registrations);

        // Should NOT execute immediately on first startup
        await schedulerControl.waitForNextCycleEnd();
        expect(callback).toHaveBeenCalledTimes(0);

        // Advance to next scheduled execution (01:00:00)
        timeControl.setDateTime(fromEpochMs(DateTime.fromISO("2020-01-01T01:00:00.000Z").toMillis())); // Set to exact time for execution
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
        timeControl.advanceByDuration(fromObject({seconds: 10})); // 10 seconds (past the 5-second retry delay)
        await schedulerControl.waitForNextCycleEnd();

        // The task should have retried once more
        expect(callback).toHaveBeenCalledTimes(2); // Should have retried once

        await capabilities.scheduler.stop();
    });
});
