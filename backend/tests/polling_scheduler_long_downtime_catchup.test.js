/**
 * Tests for declarative scheduler task execution and scheduling behavior.
 * Focuses on scenarios where the scheduler missed a bunch of executions.
 */

const { Duration } = require("luxon");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper, getDatetimeControl, stubScheduler, getSchedulerControl, stubRuntimeStateStorage } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubSleeper(capabilities);
    stubScheduler(capabilities);
    stubRuntimeStateStorage(capabilities);
    return capabilities;
}

describe("declarative scheduler long downtime catchup behavior", () => {
    test("should not catch up on missed executions during short downtime", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);

        schedulerControl.setPollingInterval(1);
        const retryDelay = Duration.fromMillis(5000);
        const hourlyTask = jest.fn();

        // Start at exactly the hour to trigger immediate execution
        const startTime = 1609459200000 // 2021-01-01T00:00:00.000Z;
        timeControl.setTime(startTime);

        const registrations = [
            ["hourly-task", "0 * * * *", hourlyTask, retryDelay] // Every hour at 0 minutes
        ];

        await capabilities.scheduler.initialize(registrations);
        await schedulerControl.waitForNextCycleEnd();

        // Should NOT execute immediately on first startup
        expect(hourlyTask.mock.calls.length).toBe(0);

        // Advance to next scheduled execution (01:00:00)
        timeControl.advanceTime(60 * 60 * 1000); // 1 hour to 01:00:00
        await schedulerControl.waitForNextCycleEnd();
        
        // Now should have executed once
        expect(hourlyTask.mock.calls.length).toBe(1);
        const initialExecutions = hourlyTask.mock.calls.length;

        // Advance time by 3 hours all at once (simulating 3 missed executions)
        timeControl.advanceTime(3 * 60 * 60 * 1000); // to 04:00:00
        await schedulerControl.waitForNextCycleEnd();

        // Should execute only once more (no catch-up), not 3 times
        expect(hourlyTask.mock.calls.length).toBe(initialExecutions + 1);

        await capabilities.scheduler.stop();
    });

    test("should not catch up on missed executions during short downtime, even if several polls", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);

        schedulerControl.setPollingInterval(1);
        const retryDelay = Duration.fromMillis(5000);
        const hourlyTask = jest.fn();

        // Start at exactly the hour to trigger immediate execution
        const startTime = 1609459200000 // 2021-01-01T00:00:00.000Z;
        timeControl.setTime(startTime);

        const registrations = [
            ["hourly-task", "0 * * * *", hourlyTask, retryDelay] // Every hour at 0 minutes
        ];

        await capabilities.scheduler.initialize(registrations);
        await schedulerControl.waitForNextCycleEnd();

        // Should NOT execute immediately on first startup
        expect(hourlyTask.mock.calls.length).toBe(0);

        // Advance to next scheduled execution (01:00:00)
        timeControl.advanceTime(60 * 60 * 1000); // 1 hour to 01:00:00
        await schedulerControl.waitForNextCycleEnd();
        
        // Now should have executed once
        expect(hourlyTask.mock.calls.length).toBe(1);
        const initialExecutions = hourlyTask.mock.calls.length;

        // Advance time by 3 hours all at once (simulating 3 missed executions)
        timeControl.advanceTime(3 * 60 * 60 * 1000); // to 03:00:00

        for (let i = 0; i < 30; i++) {
            await schedulerControl.waitForNextCycleEnd();
        }

        // Should execute only once more (no catch-up), not 3 times
        expect(hourlyTask.mock.calls.length).toBe(initialExecutions + 1);

        await capabilities.scheduler.stop();
    });

    test("should not catch up on many missed executions during extended downtime", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);

        schedulerControl.setPollingInterval(1);
        const retryDelay = Duration.fromMillis(3000);

        const hourlyTask = jest.fn();
        const dailyTask = jest.fn();

        // Start at a specific time 
        const startTime = 1609466400000 // 2021-01-01T02:00:00.000Z;
        timeControl.setTime(startTime);

        const registrations = [
            ["hourly-catchup", "0 * * * *", hourlyTask, retryDelay],  // Every hour
            ["daily-catchup", "0 6 * * *", dailyTask, retryDelay]     // Daily at 6 AM
        ];

        await capabilities.scheduler.initialize(registrations);
        await schedulerControl.waitForNextCycleEnd();

        const initialHourly = hourlyTask.mock.calls.length;
        const initialDaily = dailyTask.mock.calls.length;

        // Simulate extended downtime - advance 2 full days (48 hours)
        // This would normally trigger 48 hourly executions and 2 daily executions
        timeControl.advanceTime(2 * 24 * 60 * 60 * 1000);

        for (let i = 0; i < 10; i++) {
            await schedulerControl.waitForNextCycleEnd();
        }

        // Due to no-catchup policy: should execute only once per task, not multiple times
        const hourlyExecutions = hourlyTask.mock.calls.length - initialHourly;
        const dailyExecutions = dailyTask.mock.calls.length - initialDaily;

        expect(hourlyExecutions).toBe(1); // Only 1 execution, not 48
        expect(dailyExecutions).toBe(1);  // Only 1 execution, not 2

        await capabilities.scheduler.stop();
    });

    test("should handle different task frequencies consistently during downtime", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);

        schedulerControl.setPollingInterval(1);
        const retryDelay = Duration.fromMillis(5000);

        const every15MinTask = jest.fn();
        const hourlyTask = jest.fn();
        const every6HourTask = jest.fn();

        // Start at midnight for clean schedule boundaries
        const startTime = 1609459200000 // 2021-01-01T00:00:00.000Z;
        timeControl.setTime(startTime);

        const registrations = [
            ["every-15min", "*/15 * * * *", every15MinTask, retryDelay], // Every 15 minutes
            ["hourly", "0 * * * *", hourlyTask, retryDelay],            // Every hour
            ["every-6h", "0 */6 * * *", every6HourTask, retryDelay]     // Every 6 hours
        ];

        await capabilities.scheduler.initialize(registrations);
        await schedulerControl.waitForNextCycleEnd();

        const initial15Min = every15MinTask.mock.calls.length;
        const initialHourly = hourlyTask.mock.calls.length;
        const initial6Hour = every6HourTask.mock.calls.length;

        // Advance 12 hours (would normally trigger many executions)
        // 15-min task: 48 executions, hourly: 12 executions, 6-hour: 2 executions
        timeControl.advanceTime(12 * 60 * 60 * 1000);

        for (let i = 0; i < 10; i++) {
            await schedulerControl.waitForNextCycleEnd();
        }

        // All tasks should execute exactly once more (no catch-up)
        expect(every15MinTask.mock.calls.length - initial15Min).toBe(1);
        expect(hourlyTask.mock.calls.length - initialHourly).toBe(1);
        expect(every6HourTask.mock.calls.length - initial6Hour).toBe(1);

        await capabilities.scheduler.stop();
    });

    test("should handle gradual time advancement after downtime correctly", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);

        schedulerControl.setPollingInterval(1);
        const retryDelay = Duration.fromMillis(3000);
        const hourlyTask = jest.fn();

        // Start at 10:00 AM
        const startTime = 1609495200000 // 2021-01-01T10:00:00.000Z;
        timeControl.setTime(startTime);

        const registrations = [
            ["gradual-test", "0 * * * *", hourlyTask, retryDelay] // Every hour
        ];

        await capabilities.scheduler.initialize(registrations);
        await schedulerControl.waitForNextCycleEnd();

        const initialExecutions = hourlyTask.mock.calls.length;

        // Jump ahead 5 hours at once (simulating downtime)
        timeControl.advanceTime(5 * 60 * 60 * 1000); // to 15:00 (3 PM)
        
        for (let i = 0; i < 10; i++) {
            await schedulerControl.waitForNextCycleEnd();
        }

        // Should execute only once after the big jump (no catch-up)
        expect(hourlyTask.mock.calls.length).toBe(initialExecutions + 1);
        const afterBigJump = hourlyTask.mock.calls.length;

        // Now advance gradually hour by hour to verify normal scheduling resumes
        timeControl.advanceTime(60 * 60 * 1000); // to 16:00 (4 PM)
        for (let i = 0; i < 10; i++) {
            await schedulerControl.waitForNextCycleEnd();
        }
        expect(hourlyTask.mock.calls.length).toBe(afterBigJump + 1);

        timeControl.advanceTime(60 * 60 * 1000); // to 17:00 (5 PM)
        for (let i = 0; i < 10; i++) {
            await schedulerControl.waitForNextCycleEnd();
        }
        expect(hourlyTask.mock.calls.length).toBe(afterBigJump + 2);

        await capabilities.scheduler.stop();
    });

    test("should verify no-catchup policy with very long downtime periods", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);

        schedulerControl.setPollingInterval(1);
        const retryDelay = Duration.fromMillis(5000);

        const task30Min = jest.fn();
        const taskHourly = jest.fn();
        const taskDaily = jest.fn();

        // Start at a known time
        const startTime = 1609459200000 // 2021-01-01T00:00:00.000Z;
        timeControl.setTime(startTime);

        const registrations = [
            ["every-30min", "*/30 * * * *", task30Min, retryDelay],   // Every 30 minutes
            ["hourly-task", "0 * * * *", taskHourly, retryDelay],    // Every hour
            ["daily-task", "0 9 * * *", taskDaily, retryDelay]       // Daily at 9 AM
        ];

        await capabilities.scheduler.initialize(registrations);
        await schedulerControl.waitForNextCycleEnd();

        const initial30Min = task30Min.mock.calls.length;
        const initialHourly = taskHourly.mock.calls.length;
        const initialDaily = taskDaily.mock.calls.length;

        // Simulate very long downtime - advance 1 week (7 days)
        // This would normally trigger:
        // - 30-min task: 7 * 24 * 2 = 336 executions
        // - hourly task: 7 * 24 = 168 executions  
        // - daily task: 7 executions
        timeControl.advanceTime(7 * 24 * 60 * 60 * 1000);
        for (let i = 0; i < 10; i++) {
            await schedulerControl.waitForNextCycleEnd();
        }

        // Verify no-catchup policy: each task should execute exactly once
        expect(task30Min.mock.calls.length - initial30Min).toBe(1);
        expect(taskHourly.mock.calls.length - initialHourly).toBe(1);
        expect(taskDaily.mock.calls.length - initialDaily).toBe(1);

        await capabilities.scheduler.stop();
    });

    test("should demonstrate scheduler restart with proper catchup behavior", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);

        schedulerControl.setPollingInterval(1);
        const retryDelay = Duration.fromMillis(1000);
        const hourlyTask = jest.fn();

        // Start at a specific time
        const startTime = 1609488000000; // 2021-01-01T08:00:00.000Z
        timeControl.setTime(startTime);

        const registrations = [
            ["restart-test", "0 * * * *", hourlyTask, retryDelay] // Every hour
        ];

        // First scheduler instance
        await capabilities.scheduler.initialize(registrations);
        await schedulerControl.waitForNextCycleEnd();
        
        // Should NOT execute immediately on first startup
        expect(hourlyTask.mock.calls.length).toBe(0);
        
        // Advance to next scheduled execution (09:00:00)
        timeControl.advanceTime(60 * 60 * 1000); // 1 hour to 09:00:00
        await schedulerControl.waitForNextCycleEnd();
        
        // Now should have executed once
        expect(hourlyTask.mock.calls.length).toBe(1);

        await capabilities.scheduler.stop();

        // Advance time while scheduler is stopped (simulating downtime)
        timeControl.advanceTime(4 * 60 * 60 * 1000); // 4 hours to 12:00 PM

        // Restart scheduler with same registrations
        await capabilities.scheduler.initialize(registrations);
        for (let i = 0; i < 10; i++) {
            await schedulerControl.waitForNextCycleEnd();
        }

        // Should execute only once after restart, not 4 times for missed executions
        expect(hourlyTask.mock.calls.length).toBe(2); // 1 initial + 1 after restart

        await capabilities.scheduler.stop();
    });

    test("should verify catchup behavior with complex cron expressions", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);

        schedulerControl.setPollingInterval(1);
        const retryDelay = Duration.fromMillis(5000);
        const complexTask = jest.fn();

        // Start at midnight for predictable cron behavior
        const startTime = 1609459200000 // 2021-01-01T00:00:00.000Z;
        timeControl.setTime(startTime);

        const registrations = [
            // Every 15 minutes: 0, 15, 30, 45 minutes past each hour
            ["complex-schedule", "0,15,30,45 * * * *", complexTask, retryDelay]
        ];

        await capabilities.scheduler.initialize(registrations);
        await schedulerControl.waitForNextCycleEnd();

        const initialExecutions = complexTask.mock.calls.length;

        // Advance time by 6 hours - would normally trigger 24 executions (4 per hour * 6 hours)
        timeControl.advanceTime(6 * 60 * 60 * 1000);
        for (let i = 0; i < 10; i++) {
            await schedulerControl.waitForNextCycleEnd();
        }

        // Should execute only once more despite complex schedule (no catch-up)
        expect(complexTask.mock.calls.length - initialExecutions).toBe(1);

        await capabilities.scheduler.stop();
    });
});
