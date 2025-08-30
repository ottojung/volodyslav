/**
 * Demonstration test showing how to use datetime mocking to observe 
 * multiple scheduler task invocations by advancing time.
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

describe("scheduler stories", () => {
    test("should observe multiple task invocations by advancing time gradually", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = fromMilliseconds(5000);
        const taskCallback = jest.fn();

        // Set initial time to 00:05:00
        const startTime = new Date("2021-01-01T00:05:00.000Z").getTime();
        timeControl.setTime(startTime);
        schedulerControl.setPollingInterval(1);

        // Schedule a task that runs at 30 minutes past each hour
        const registrations = [
            ["half-hour-task", "30 * * * *", taskCallback, retryDelay] // Runs at minute 30 of each hour
        ];

        await capabilities.scheduler.initialize(registrations);

        // Wait for scheduler to start and possibly catch up
        // With fast polling (1ms), we should see execution within 100ms
        // await new Promise(resolve => setTimeout(resolve, 100));
        await schedulerControl.waitForNextCycleEnd();

        // The scheduler may or may not catch up immediately - check current call count
        const initialCalls = taskCallback.mock.calls.length;
        
        // Now test that advancing time triggers new executions
        // Advance time to 00:30:00 (first execution after initialization)
        timeControl.advanceTime(25 * 60 * 1000); // 25 minutes to reach 00:30:00
        await schedulerControl.waitForNextCycleEnd();

        // Should have at least one more call than initial
        expect(taskCallback.mock.calls.length).toBeGreaterThan(initialCalls);
        
        const afterFirstAdvance = taskCallback.mock.calls.length;

        // Advance to 01:30:00
        timeControl.advanceTime(60 * 60 * 1000); // 1 hour
        await schedulerControl.waitForNextCycleEnd();
        expect(taskCallback.mock.calls.length).toBeGreaterThan(afterFirstAdvance);

        const afterSecondAdvance = taskCallback.mock.calls.length;

        // Advance to 02:30:00
        timeControl.advanceTime(60 * 60 * 1000); // 1 hour
        await schedulerControl.waitForNextCycleEnd();
        expect(taskCallback.mock.calls.length).toBeGreaterThan(afterSecondAdvance);

        await capabilities.scheduler.stop();
    });

    test("should handle multiple tasks with different schedules", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = fromMilliseconds(5000);

        const hourlyTask = jest.fn();
        const dailyTask = jest.fn();

        // Set start time to 01:15:00 on Jan 1, 2021
        const startTime = new Date("2021-01-01T01:15:00.000Z").getTime();
        timeControl.setTime(startTime);
        schedulerControl.setPollingInterval(1);

        const registrations = [
            ["hourly-task", "0 * * * *", hourlyTask, retryDelay],   // Every hour at 0 minutes
            ["daily-task", "0 0 * * *", dailyTask, retryDelay],    // Every day at midnight (0:00)
        ];

        await capabilities.scheduler.initialize(registrations);

        // Wait for scheduler to start up and potentially catch up
        await schedulerControl.waitForNextCycleEnd();

        // Both tasks should catch up for their previous occurrences
        expect(hourlyTask.mock.calls.length).toBeGreaterThan(0);
        expect(dailyTask.mock.calls.length).toBeGreaterThan(0);

        // Test that the scheduler is running and tasks are registered
        // This is mainly a smoke test to ensure the multiple task scheduling works
        
        await capabilities.scheduler.stop();
    });

    test("should demonstrate sub-hour polling with time advancement", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = fromMilliseconds(1000);
        const taskCallback = jest.fn();

        // Set initial time to 00:00:00 (midnight)
        const startTime = new Date("2021-01-01T00:00:00.000Z").getTime();
        timeControl.setTime(startTime);
        schedulerControl.setPollingInterval(1);

        // Use fast polling to allow minute-level tasks
        const registrations = [
            ["every-minute", "*/30 * * * *", taskCallback, retryDelay] // Every 30 minutes
        ];

        await capabilities.scheduler.initialize(registrations);

        // Wait for scheduler to start
        await schedulerControl.waitForNextCycleEnd();

        // Check initial execution count
        const initialCalls = taskCallback.mock.calls.length;

        // Advance by 30 minutes to reach the next minute boundary (00:30:00)
        timeControl.advanceTime(30 * 60 * 1000);
        await schedulerControl.waitForNextCycleEnd();
        // Should have executed at least once more
        expect(taskCallback.mock.calls.length).toBeGreaterThan(initialCalls);
        const afterFirstAdvance = taskCallback.mock.calls.length;

        // Advance by another 30 minutes to 01:00:00
        timeControl.advanceTime(30 * 60 * 1000);
        await schedulerControl.waitForNextCycleEnd();
        expect(taskCallback.mock.calls.length).toBeGreaterThan(afterFirstAdvance);

        await capabilities.scheduler.stop();
    });

    test("should verify time consistency across scheduler operations", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = fromMilliseconds(5000);

        const taskCallback = jest.fn().mockImplementation(() => {
            // Verify that during task execution, the scheduler sees consistent time
            const executionTime = capabilities.datetime.toNativeDate(capabilities.datetime.now());
            taskCallback.executionTimes = taskCallback.executionTimes || [];
            taskCallback.executionTimes.push(executionTime.getTime());
        });

        // Set specific start time 
        const startTime = new Date("2021-01-01T00:15:00.000Z").getTime();
        timeControl.setTime(startTime);
        schedulerControl.setPollingInterval(1);

        const registrations = [
            ["time-check-task", "0 * * * *", taskCallback, retryDelay] // Every hour at 0 minutes
        ];

        await capabilities.scheduler.initialize(registrations);

        // Wait for scheduler to start
        await schedulerControl.waitForNextCycleEnd();

        // Check that task has executed and recorded times
        expect(taskCallback.executionTimes).toBeDefined();
        expect(taskCallback.executionTimes.length).toBeGreaterThan(0);
        
        const initialExecutions = taskCallback.executionTimes.length;

        // Advance to next execution (01:00:00)
        timeControl.advanceTime(45 * 60 * 1000); // 45 minutes to reach 01:00:00
        await schedulerControl.waitForNextCycleEnd();

        // Should have more executions
        expect(taskCallback.executionTimes.length).toBeGreaterThan(initialExecutions);

        await capabilities.scheduler.stop();
    });

    test("should demonstrate catching up on missed executions with gradual polling", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = fromMilliseconds(5000);
        const taskCallback = jest.fn();

        // Set initial time 
        const startTime = new Date("2021-01-01T00:10:00.000Z").getTime();
        timeControl.setTime(startTime);
        schedulerControl.setPollingInterval(1);

        const registrations = [
            ["hourly-task", "0 * * * *", taskCallback, retryDelay] // Every hour at 0 minutes
        ];

        await capabilities.scheduler.initialize(registrations);

        // Wait for scheduler to start
        await schedulerControl.waitForNextCycleEnd();

        // Check initial executions
        const initialCalls = taskCallback.mock.calls.length;

        // Jump ahead 5 hours at once - scheduler behavior may vary
        timeControl.advanceTime(5 * 60 * 60 * 1000 - 10 * 60 * 1000); // to 05:00:00
        await schedulerControl.waitForNextCycleEnd();

        // Should have executed at least once more
        expect(taskCallback.mock.calls.length).toBeGreaterThan(initialCalls);
        const afterBigJump = taskCallback.mock.calls.length;

        // Poll gradually hour by hour from here to see individual executions
        timeControl.advanceTime(60 * 60 * 1000); // to 06:00:00
        await schedulerControl.waitForNextCycleEnd();
        expect(taskCallback.mock.calls.length).toBeGreaterThan(afterBigJump);

        await capabilities.scheduler.stop();
    });
});