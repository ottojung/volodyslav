/**
 * Demonstration test showing how to use datetime mocking to observe 
 * multiple scheduler task invocations by advancing time.
 */

const { fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper, getDatetimeControl } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubSleeper(capabilities);
    return capabilities;
}

describe("scheduler time advancement demo", () => {
    // Helper function to wait for scheduler polling to occur
    const waitForPolling = () => new Promise(resolve => setTimeout(resolve, 200));

    test("should observe multiple task invocations by advancing time gradually", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = fromMilliseconds(5000);
        const taskCallback = jest.fn();
        
        // Set initial time to just before the first hour boundary (23:59:30 on Dec 31)
        const startTime = new Date("2020-12-31T23:59:30.000Z").getTime();
        timeControl.setTime(startTime);
        
        // Schedule a task that runs every hour with reasonable polling for tests
        const registrations = [
            ["hourly-task", "0 * * * *", taskCallback, retryDelay] // Runs at minute 0 of each hour
        ];
        
        await capabilities.scheduler.initialize(registrations, { pollIntervalMs: 100 });
        
        // Wait a bit to ensure scheduler has started
        await waitForPolling();
        
        // Verify initial state - task hasn't run yet (we're before midnight)
        expect(taskCallback).not.toHaveBeenCalled();
        
        const oneHour = 60 * 60 * 1000;
        
        // Advance time to midnight (first execution at 00:00:00)
        timeControl.advanceTime(30 * 1000); // 30 seconds to midnight
        await waitForPolling();
        expect(taskCallback).toHaveBeenCalledTimes(1);
        
        // Advance to 1:00:00 AM
        timeControl.advanceTime(oneHour);
        await waitForPolling();
        expect(taskCallback).toHaveBeenCalledTimes(2);
        
        // Advance to 2:00:00 AM
        timeControl.advanceTime(oneHour);
        await waitForPolling();
        expect(taskCallback).toHaveBeenCalledTimes(3);
        
        // Advance to 3:00:00 AM
        timeControl.advanceTime(oneHour);
        await waitForPolling();
        expect(taskCallback).toHaveBeenCalledTimes(4);
        
        // Advance to 4:00:00 AM
        timeControl.advanceTime(oneHour);
        await waitForPolling();
        expect(taskCallback).toHaveBeenCalledTimes(5);
        
        await capabilities.scheduler.stop();
    });

    test("should handle multiple tasks with different schedules", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = fromMilliseconds(5000);
        
        const hourlyTask = jest.fn();
        const dailyTask = jest.fn();
        
        // Set start time to just before midnight (23:59:30 on Dec 31, 2020)
        const startTime = new Date("2020-12-31T23:59:30.000Z").getTime();
        timeControl.setTime(startTime);
        
        const registrations = [
            ["hourly-task", "0 * * * *", hourlyTask, retryDelay],   // Every hour at 0 minutes
            ["daily-task", "0 0 * * *", dailyTask, retryDelay],    // Every day at midnight (0:00)
        ];
        
        await capabilities.scheduler.initialize(registrations, { pollIntervalMs: 20 });
        
        // Wait for scheduler to start up
        await waitForPolling();
        
        // Initially no tasks have run (we're before midnight)
        expect(hourlyTask).not.toHaveBeenCalled();
        expect(dailyTask).not.toHaveBeenCalled();
        
        // Advance 30 seconds to midnight exactly (should trigger both daily and hourly task)
        timeControl.advanceTime(30 * 1000);
        await waitForPolling();
        
        expect(hourlyTask).toHaveBeenCalledTimes(1); // Hourly at midnight
        expect(dailyTask).toHaveBeenCalledTimes(1);  // Daily at midnight
        
        // Advance to 1:00 AM exactly
        timeControl.advanceTime(60 * 60 * 1000);
        await waitForPolling();
        
        expect(hourlyTask).toHaveBeenCalledTimes(2);
        expect(dailyTask).toHaveBeenCalledTimes(1); // Still just once
        
        // Advance to 2:00 AM exactly
        timeControl.advanceTime(60 * 60 * 1000);
        await waitForPolling();
        
        expect(hourlyTask).toHaveBeenCalledTimes(3);
        expect(dailyTask).toHaveBeenCalledTimes(1); // Still just once
        
        await capabilities.scheduler.stop();
    });

    test("should demonstrate sub-minute polling with time advancement", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = fromMilliseconds(1000);
        const taskCallback = jest.fn();
        
        // Set initial time to 30 seconds BEFORE the minute to avoid immediate triggering
        const startTime = new Date("2020-12-31T23:59:30.000Z").getTime();
        timeControl.setTime(startTime);
        
        // Use fast polling to allow minute-level tasks
        const registrations = [
            ["every-minute", "* * * * *", taskCallback, retryDelay] // Every minute
        ];
        
        await capabilities.scheduler.initialize(registrations, { pollIntervalMs: 20 });
        
        // Wait for scheduler to start
        await waitForPolling();
        
        expect(taskCallback).not.toHaveBeenCalled();
        
        // Advance by 30 seconds to reach the next minute boundary (midnight 00:00:00)
        timeControl.advanceTime(30 * 1000);
        await waitForPolling();
        expect(taskCallback).toHaveBeenCalledTimes(1);
        
        // Advance by another minute to 00:01:00
        timeControl.advanceTime(60 * 1000);
        await waitForPolling();
        expect(taskCallback).toHaveBeenCalledTimes(2);
        
        // Advance by another minute to 00:02:00
        timeControl.advanceTime(60 * 1000);
        await waitForPolling();
        expect(taskCallback).toHaveBeenCalledTimes(3);
        
        await capabilities.scheduler.stop();
    });

    test("should verify time consistency across scheduler operations", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = fromMilliseconds(5000);
        
        const taskCallback = jest.fn().mockImplementation(() => {
            // Verify that during task execution, the scheduler sees consistent time
            const executionTime = capabilities.datetime.toNativeDate(capabilities.datetime.now());
            taskCallback.executionTimes = taskCallback.executionTimes || [];
            taskCallback.executionTimes.push(executionTime.getTime());
        });
        
        // Set specific start time that's before any cron boundary
        const startTime = new Date("2020-12-31T23:59:30.000Z").getTime();
        timeControl.setTime(startTime);
        
        const registrations = [
            ["time-check-task", "0 * * * *", taskCallback, retryDelay] // Every hour at 0 minutes
        ];
        
        await capabilities.scheduler.initialize(registrations, { pollIntervalMs: 20 });
        
        // Wait for scheduler to start
        await waitForPolling();
        
        // Advance to first execution (midnight 00:00:00)
        timeControl.advanceTime(30 * 1000); // 30 seconds to reach midnight
        await waitForPolling();
        
        expect(taskCallback.executionTimes).toHaveLength(1);
        expect(taskCallback.executionTimes[0]).toBe(startTime + 30 * 1000);
        
        // Advance to second execution (01:00:00)
        timeControl.advanceTime(60 * 60 * 1000); // Another hour
        await waitForPolling();
        
        expect(taskCallback.executionTimes).toHaveLength(2);
        expect(taskCallback.executionTimes[1]).toBe(startTime + 30 * 1000 + 60 * 60 * 1000);
        
        await capabilities.scheduler.stop();
    });

    test("should demonstrate catching up on missed executions with gradual polling", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = fromMilliseconds(5000);
        const taskCallback = jest.fn();
        
        // Set initial time that's before any cron boundary
        const startTime = new Date("2020-12-31T23:59:30.000Z").getTime();
        timeControl.setTime(startTime);
        
        const registrations = [
            ["hourly-task", "0 * * * *", taskCallback, retryDelay] // Every hour at 0 minutes
        ];
        
        await capabilities.scheduler.initialize(registrations, { pollIntervalMs: 20 });
        
        // Wait for scheduler to start
        await waitForPolling();
        
        expect(taskCallback).not.toHaveBeenCalled();
        
        // Jump ahead 5 hours at once - scheduler will only catch the most recent execution
        timeControl.advanceTime(5 * 60 * 60 * 1000 + 30 * 1000); // 5 hours + 30 seconds to 05:00:00
        await waitForPolling();
        
        // Should only execute once (for the most recent hour), not 5 times
        expect(taskCallback).toHaveBeenCalledTimes(1);
        
        // But if we poll gradually hour by hour from here, we get individual executions
        timeControl.advanceTime(60 * 60 * 1000); // to 06:00:00
        await waitForPolling();
        expect(taskCallback).toHaveBeenCalledTimes(2);
        
        timeControl.advanceTime(60 * 60 * 1000); // to 07:00:00
        await waitForPolling();
        expect(taskCallback).toHaveBeenCalledTimes(3);
        
        await capabilities.scheduler.stop();
    });
});