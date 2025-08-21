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
    test("should observe multiple task invocations by advancing time gradually", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = fromMilliseconds(5000);
        const taskCallback = jest.fn();
        
        // Set initial time to a known point
        const startTime = new Date("2021-01-01T00:00:00.000Z").getTime();
        timeControl.setTime(startTime);
        
        // Schedule a task that runs every hour (with 10-minute polling, this should work)
        const registrations = [
            ["hourly-task", "0 * * * *", taskCallback, retryDelay]
        ];
        
        await capabilities.scheduler.initialize(registrations);
        
        // Verify initial state - task hasn't run yet
        expect(taskCallback).not.toHaveBeenCalled();
        
        const oneHour = 60 * 60 * 1000;
        
        // Advance time to exactly one hour later and poll
        timeControl.advanceTime(oneHour);
        await capabilities.scheduler.pollNow();
        expect(taskCallback).toHaveBeenCalledTimes(1);
        
        // Advance another hour and poll
        timeControl.advanceTime(oneHour);
        await capabilities.scheduler.pollNow();
        expect(taskCallback).toHaveBeenCalledTimes(2);
        
        // Advance another hour and poll
        timeControl.advanceTime(oneHour);
        await capabilities.scheduler.pollNow();
        expect(taskCallback).toHaveBeenCalledTimes(3);
        
        // Advance another hour and poll
        timeControl.advanceTime(oneHour);
        await capabilities.scheduler.pollNow();
        expect(taskCallback).toHaveBeenCalledTimes(4);
        
        // Advance another hour and poll
        timeControl.advanceTime(oneHour);
        await capabilities.scheduler.pollNow();
        expect(taskCallback).toHaveBeenCalledTimes(5);
        
        await capabilities.scheduler.stop();
    });

    test("should handle multiple tasks with different schedules", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = fromMilliseconds(5000);
        
        const hourlyTask = jest.fn();
        const dailyTask = jest.fn();
        
        // Set start time to 11:30 PM on Dec 31, 2020 (before midnight)
        const startTime = new Date("2020-12-31T23:30:00.000Z").getTime();
        timeControl.setTime(startTime);
        
        const registrations = [
            ["hourly-task", "0 * * * *", hourlyTask, retryDelay],   // Every hour
            ["daily-task", "0 0 * * *", dailyTask, retryDelay],    // Every day at midnight
        ];
        
        await capabilities.scheduler.initialize(registrations);
        
        // Initially no tasks have run
        expect(hourlyTask).not.toHaveBeenCalled();
        expect(dailyTask).not.toHaveBeenCalled();
        
        // Advance 30 minutes to midnight (should trigger daily task)
        timeControl.advanceTime(30 * 60 * 1000);
        await capabilities.scheduler.pollNow();
        
        expect(hourlyTask).toHaveBeenCalledTimes(1); // Hourly at midnight
        expect(dailyTask).toHaveBeenCalledTimes(1);  // Daily at midnight
        
        // Advance to 1 AM
        timeControl.advanceTime(60 * 60 * 1000);
        await capabilities.scheduler.pollNow();
        
        expect(hourlyTask).toHaveBeenCalledTimes(2);
        expect(dailyTask).toHaveBeenCalledTimes(1); // Still just once
        
        // Advance to 2 AM
        timeControl.advanceTime(60 * 60 * 1000);
        await capabilities.scheduler.pollNow();
        
        expect(hourlyTask).toHaveBeenCalledTimes(3);
        expect(dailyTask).toHaveBeenCalledTimes(1); // Still just once
        
        await capabilities.scheduler.stop();
    });

    test("should demonstrate sub-minute polling with time advancement", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = fromMilliseconds(1000);
        const taskCallback = jest.fn();
        
        // Set initial time
        const startTime = new Date("2021-01-01T00:00:00.000Z").getTime();
        timeControl.setTime(startTime);
        
        // Use 30-second polling to allow minute-level tasks
        const registrations = [
            ["every-minute", "* * * * *", taskCallback, retryDelay]
        ];
        
        await capabilities.scheduler.initialize(registrations, { pollIntervalMs: 30 * 1000 });
        
        expect(taskCallback).not.toHaveBeenCalled();
        
        // Advance by 1 minute and poll
        timeControl.advanceTime(60 * 1000);
        await capabilities.scheduler.pollNow();
        expect(taskCallback).toHaveBeenCalledTimes(1);
        
        // Advance by another minute and poll
        timeControl.advanceTime(60 * 1000);
        await capabilities.scheduler.pollNow();
        expect(taskCallback).toHaveBeenCalledTimes(2);
        
        // Advance by another minute and poll
        timeControl.advanceTime(60 * 1000);
        await capabilities.scheduler.pollNow();
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
        
        // Set specific start time
        const startTime = new Date("2021-01-01T00:00:00.000Z").getTime();
        timeControl.setTime(startTime);
        
        const registrations = [
            ["time-check-task", "0 * * * *", taskCallback, retryDelay]
        ];
        
        await capabilities.scheduler.initialize(registrations);
        
        // Advance to first execution
        timeControl.advanceTime(60 * 60 * 1000); // 1 hour
        await capabilities.scheduler.pollNow();
        
        expect(taskCallback.executionTimes).toHaveLength(1);
        expect(taskCallback.executionTimes[0]).toBe(startTime + 60 * 60 * 1000);
        
        // Advance to second execution
        timeControl.advanceTime(60 * 60 * 1000); // Another hour
        await capabilities.scheduler.pollNow();
        
        expect(taskCallback.executionTimes).toHaveLength(2);
        expect(taskCallback.executionTimes[1]).toBe(startTime + 2 * 60 * 60 * 1000);
        
        await capabilities.scheduler.stop();
    });

    test("should demonstrate catching up on missed executions with gradual polling", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = fromMilliseconds(5000);
        const taskCallback = jest.fn();
        
        // Set initial time
        const startTime = new Date("2021-01-01T00:00:00.000Z").getTime();
        timeControl.setTime(startTime);
        
        const registrations = [
            ["hourly-task", "0 * * * *", taskCallback, retryDelay]
        ];
        
        await capabilities.scheduler.initialize(registrations);
        
        expect(taskCallback).not.toHaveBeenCalled();
        
        // Jump ahead 5 hours at once - scheduler will only catch the most recent execution
        timeControl.advanceTime(5 * 60 * 60 * 1000);
        await capabilities.scheduler.pollNow();
        
        // Should only execute once (for the most recent hour), not 5 times
        expect(taskCallback).toHaveBeenCalledTimes(1);
        
        // But if we poll gradually hour by hour from here, we get individual executions
        timeControl.advanceTime(60 * 60 * 1000);
        await capabilities.scheduler.pollNow();
        expect(taskCallback).toHaveBeenCalledTimes(2);
        
        timeControl.advanceTime(60 * 60 * 1000);
        await capabilities.scheduler.pollNow();
        expect(taskCallback).toHaveBeenCalledTimes(3);
        
        await capabilities.scheduler.stop();
    });
});