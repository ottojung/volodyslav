/**
 * Tests for scheduler first startup semantics.
 * Verifies that tasks do NOT execute immediately on first startup,
 * even if their cron expression matches the current time.
 */

const { Duration, DateTime } = require("luxon");
const { fromEpochMs } = require("../src/datetime");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper, stubRuntimeStateStorage, stubScheduler, getSchedulerControl, getDatetimeControl } = require("./stubs");

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

describe("scheduler first startup semantics", () => {
    describe("cron expression matching current time", () => {
        test("should execute task if cron exactly matches current time on first startup", async () => {
            const capabilities = getTestCapabilities();
            const schedulerControl = getSchedulerControl(capabilities);
            const datetimeControl = getDatetimeControl(capabilities);
            
            // Set time to 15:30:00 on a Tuesday (day 2)
            const tuesdayAt1530 = DateTime.fromISO("2024-01-02T15:30:00.000Z").toMillis(); // Tuesday, 15:30
            datetimeControl.setDateTime(fromEpochMs(tuesdayAt1530));
            
            schedulerControl.setPollingInterval(1);
            const retryDelay = Duration.fromMillis(5000);

            const taskCallback = jest.fn();
            
            // Cron expression that matches exactly: "30 15 * * 2" (15:30 on Tuesday)
            const registrations = [
                ["exact-match-task", "30 15 * * 2", taskCallback, retryDelay]
            ];

            await capabilities.scheduler.initialize(registrations);
            await schedulerControl.waitForNextCycleEnd();

            // With new startup semantics, task should execute immediately if cron matches exactly
            expect(taskCallback).toHaveBeenCalledTimes(1);

            await capabilities.scheduler.stop();
        });

        test("should NOT execute task if cron does not match current time on first startup", async () => {
            const capabilities = getTestCapabilities();
            const schedulerControl = getSchedulerControl(capabilities);
            const datetimeControl = getDatetimeControl(capabilities);
            
            // Set time to 15:30:00 on a Tuesday (day 2)
            const tuesdayAt1530 = DateTime.fromISO("2024-01-02T15:30:00.000Z").toMillis(); // Tuesday, 15:30
            datetimeControl.setDateTime(fromEpochMs(tuesdayAt1530));
            
            schedulerControl.setPollingInterval(1);
            const retryDelay = Duration.fromMillis(5000);

            const taskCallback = jest.fn();
            
            // Cron expression that does NOT match: "20 15 * * 2" (15:20 on Tuesday)
            const registrations = [
                ["non-match-task", "20 15 * * 2", taskCallback, retryDelay]
            ];

            await capabilities.scheduler.initialize(registrations);
            await schedulerControl.waitForNextCycleEnd();

            // Task should NOT execute on first startup since cron doesn't match current time
            expect(taskCallback).toHaveBeenCalledTimes(0);

            await capabilities.scheduler.stop();
        });

        test("should execute task at next scheduled time after first startup non-match", async () => {
            const capabilities = getTestCapabilities();
            const schedulerControl = getSchedulerControl(capabilities);
            const datetimeControl = getDatetimeControl(capabilities);
            
            // Set time to 15:30:00 on a Tuesday
            const tuesdayAt1530 = DateTime.fromISO("2024-01-02T15:30:00.000Z").toMillis(); // Tuesday, 15:30
            datetimeControl.setDateTime(fromEpochMs(tuesdayAt1530));
            
            schedulerControl.setPollingInterval(1);
            const retryDelay = Duration.fromMillis(5000);

            const taskCallback = jest.fn();
            
            // Cron expression for 15:35 on Tuesday (5 minutes later)
            const registrations = [
                ["future-task", "35 15 * * 2", taskCallback, retryDelay]
            ];

            await capabilities.scheduler.initialize(registrations);
            await schedulerControl.waitForNextCycleEnd();

            // Task should NOT execute on first startup
            expect(taskCallback).toHaveBeenCalledTimes(0);

            // Advance time to 15:35
            datetimeControl.setDateTime(fromEpochMs(DateTime.fromISO("2024-01-02T15:35:00.000Z").toMillis()));
            await schedulerControl.waitForNextCycleEnd();

            // Now task should execute
            expect(taskCallback).toHaveBeenCalledTimes(1);

            await capabilities.scheduler.stop();
        });
    });

    describe("multiple task scenarios", () => {
        test("should execute only matching tasks on first startup", async () => {
            const capabilities = getTestCapabilities();
            const schedulerControl = getSchedulerControl(capabilities);
            const datetimeControl = getDatetimeControl(capabilities);
            
            // Set time to 15:30:00 on a Tuesday
            const tuesdayAt1530 = DateTime.fromISO("2024-01-02T15:30:00.000Z").toMillis(); // Tuesday, 15:30
            datetimeControl.setDateTime(fromEpochMs(tuesdayAt1530));
            
            schedulerControl.setPollingInterval(1);
            const retryDelay = Duration.fromMillis(5000);

            const matchingTaskCallback = jest.fn();
            const nonMatchingTaskCallback1 = jest.fn();
            const nonMatchingTaskCallback2 = jest.fn();
            
            const registrations = [
                ["matching-task", "30 15 * * 2", matchingTaskCallback, retryDelay], // Matches current time
                ["non-matching-1", "20 15 * * 2", nonMatchingTaskCallback1, retryDelay], // 10 minutes ago
                ["non-matching-2", "40 15 * * 2", nonMatchingTaskCallback2, retryDelay], // 10 minutes in future
            ];

            await capabilities.scheduler.initialize(registrations);
            await schedulerControl.waitForNextCycleEnd();

            // Only the matching task should execute
            expect(matchingTaskCallback).toHaveBeenCalledTimes(1);
            expect(nonMatchingTaskCallback1).toHaveBeenCalledTimes(0);
            expect(nonMatchingTaskCallback2).toHaveBeenCalledTimes(0);

            await capabilities.scheduler.stop();
        });

        test("should handle minute-precision matching correctly", async () => {
            const capabilities = getTestCapabilities();
            const schedulerControl = getSchedulerControl(capabilities);
            const datetimeControl = getDatetimeControl(capabilities);
            
            // Set time to exactly 15:30:00
            const tuesdayAt1530 = DateTime.fromISO("2024-01-02T15:30:00.000Z").toMillis();
            datetimeControl.setDateTime(fromEpochMs(tuesdayAt1530));
            
            schedulerControl.setPollingInterval(1);
            const retryDelay = Duration.fromMillis(5000);

            const exactMatchCallback = jest.fn();
            const oneMinuteOffCallback = jest.fn();
            
            const registrations = [
                ["exact-30", "30 15 * * *", exactMatchCallback, retryDelay], // Exactly 15:30
                ["off-31", "31 15 * * *", oneMinuteOffCallback, retryDelay], // 15:31 (1 minute off)
            ];

            await capabilities.scheduler.initialize(registrations);
            await schedulerControl.waitForNextCycleEnd();

            // Only exact match should execute
            expect(exactMatchCallback).toHaveBeenCalledTimes(1);
            expect(oneMinuteOffCallback).toHaveBeenCalledTimes(0);

            await capabilities.scheduler.stop();
        });
    });

    describe("edge cases", () => {
        test("should handle wildcard expressions correctly", async () => {
            const capabilities = getTestCapabilities();
            const schedulerControl = getSchedulerControl(capabilities);
            const datetimeControl = getDatetimeControl(capabilities);
            
            // Set time to 15:30:00 on Tuesday
            const tuesdayAt1530 = DateTime.fromISO("2024-01-02T15:30:00.000Z").toMillis();
            datetimeControl.setDateTime(fromEpochMs(tuesdayAt1530));
            
            // Set a very short polling interval BEFORE creating registrations
            schedulerControl.setPollingInterval(1);
            const retryDelay = Duration.fromMillis(5000);

            const everyMinuteCallback = jest.fn();
            const everyHourCallback = jest.fn();
            
            const registrations = [
                ["every-15min", "*/15 * * * *", everyMinuteCallback, retryDelay], // Every 15 minutes (safer than every minute)
                ["every-hour-30", "30 * * * *", everyHourCallback, retryDelay], // Every hour at :30 (should match)
            ];

            await capabilities.scheduler.initialize(registrations);
            await schedulerControl.waitForNextCycleEnd();

            // With new startup semantics, only matching tasks execute immediately
            expect(everyMinuteCallback).toHaveBeenCalledTimes(1); // */15 matches :30
            expect(everyHourCallback).toHaveBeenCalledTimes(1); // 30 * matches :30

            await capabilities.scheduler.stop();
        });

        test("should handle day-of-week matching correctly", async () => {
            const capabilities = getTestCapabilities();
            const schedulerControl = getSchedulerControl(capabilities);
            const datetimeControl = getDatetimeControl(capabilities);
            
            // Set time to Tuesday (day 2)
            const tuesdayAt1530 = DateTime.fromISO("2024-01-02T15:30:00.000Z").toMillis();
            datetimeControl.setDateTime(fromEpochMs(tuesdayAt1530)); // Tuesday
            
            schedulerControl.setPollingInterval(1);
            const retryDelay = Duration.fromMillis(5000);

            const tuesdayCallback = jest.fn();
            const wednesdayCallback = jest.fn();
            
            const registrations = [
                ["tuesday-task", "30 15 * * 2", tuesdayCallback, retryDelay], // Tuesday at 15:30
                ["wednesday-task", "30 15 * * 3", wednesdayCallback, retryDelay], // Wednesday at 15:30
            ];

            await capabilities.scheduler.initialize(registrations);
            await schedulerControl.waitForNextCycleEnd();

            // Only Tuesday task should execute
            expect(tuesdayCallback).toHaveBeenCalledTimes(1);
            expect(wednesdayCallback).toHaveBeenCalledTimes(0);

            await capabilities.scheduler.stop();
        });
    });
});