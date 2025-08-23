/**
 * Demonstration test showing how to use datetime mocking to observe 
 * multiple scheduler task invocations by advancing time.
 */

const { fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper, getDatetimeControl, stubRuntimeStateStorage, stubPollInterval } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubSleeper(capabilities);
    stubRuntimeStateStorage(capabilities);
    stubPollInterval(1); // Fast polling for tests
    return capabilities;
}

describe("scheduler time advancement demo", () => {
    test("should observe multiple task invocations by advancing time gradually", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = fromMilliseconds(5000);
        const taskCallback = jest.fn();

        // Set initial time to 00:05:00 
        const startTime = new Date("2021-01-01T00:05:00.000Z").getTime();
        timeControl.setTime(startTime);

        // Schedule a task that runs at 30 minutes past each hour
        const registrations = [
            ["half-hour-task", "30 * * * *", taskCallback, retryDelay] // Runs at minute 30 of each hour
        ];

        await capabilities.scheduler.initialize(registrations);

        // Wait to ensure scheduler has started and performed catch-up
        await new Promise(resolve => setTimeout(resolve, 10));

        // The scheduler will catch up and execute the previous 23:30:00 occurrence from yesterday
        // This is expected behavior - we start with 1 execution
        expect(taskCallback).toHaveBeenCalledTimes(1);

        // Now test that advancing time triggers new executions
        // Advance time to 00:30:00 (first execution after initialization)
        timeControl.advanceTime(25 * 60 * 1000); // 25 minutes to reach 00:30:00
        await new Promise(resolve => setTimeout(resolve, 10)); // Wait for polling
        expect(taskCallback).toHaveBeenCalledTimes(2);

        // Advance to 01:30:00
        timeControl.advanceTime(60 * 60 * 1000); // 1 hour
        await new Promise(resolve => setTimeout(resolve, 10)); // Wait for polling
        expect(taskCallback).toHaveBeenCalledTimes(3);

        // Advance to 02:30:00
        timeControl.advanceTime(60 * 60 * 1000); // 1 hour
        await new Promise(resolve => setTimeout(resolve, 10)); // Wait for polling
        expect(taskCallback).toHaveBeenCalledTimes(4);

        // Advance to 03:30:00
        timeControl.advanceTime(60 * 60 * 1000); // 1 hour
        await new Promise(resolve => setTimeout(resolve, 10)); // Wait for polling
        expect(taskCallback).toHaveBeenCalledTimes(5);

        await capabilities.scheduler.stop();
    });

    test("should handle multiple tasks with different schedules", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = fromMilliseconds(5000);

        const hourlyTask = jest.fn();
        const dailyTask = jest.fn();

        // Set start time to 01:15:00 on Jan 1, 2021
        const startTime = new Date("2021-01-01T01:15:00.000Z").getTime();
        timeControl.setTime(startTime);

        const registrations = [
            ["hourly-task", "0 * * * *", hourlyTask, retryDelay],   // Every hour at 0 minutes
            ["daily-task", "0 0 * * *", dailyTask, retryDelay],    // Every day at midnight (0:00)
        ];

        await capabilities.scheduler.initialize(registrations);

        // Wait for scheduler to start up
        await new Promise(resolve => setTimeout(resolve, 10));

        // Both tasks will catch up: hourly for 01:00:00 and daily for 00:00:00 today
        expect(hourlyTask).toHaveBeenCalledTimes(1); // Caught up 01:00:00
        expect(dailyTask).toHaveBeenCalledTimes(1);  // Caught up 00:00:00

        // Advance to 2:00:00 AM (next hourly execution)
        timeControl.advanceTime(45 * 60 * 1000); // 45 minutes to reach 02:00:00
        await new Promise(resolve => setTimeout(resolve, 10));

        expect(hourlyTask).toHaveBeenCalledTimes(2);
        expect(dailyTask).toHaveBeenCalledTimes(1); // Still just once

        // Advance to 3:00:00 AM
        timeControl.advanceTime(60 * 60 * 1000);
        await new Promise(resolve => setTimeout(resolve, 10));

        expect(hourlyTask).toHaveBeenCalledTimes(3);
        expect(dailyTask).toHaveBeenCalledTimes(1); // Still just once

        // Advance to next day at midnight (24:00:00 = 00:00:00 next day)
        timeControl.advanceTime(21 * 60 * 60 * 1000); // 21 hours to next midnight
        await new Promise(resolve => setTimeout(resolve, 10));

        expect(hourlyTask).toHaveBeenCalledTimes(4); // Also executes at midnight
        expect(dailyTask).toHaveBeenCalledTimes(2);  // Daily task executes again

        await capabilities.scheduler.stop();
    });

    test("should demonstrate sub-minute polling with time advancement", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = fromMilliseconds(1000);
        const taskCallback = jest.fn();

        // Set initial time to 00:00:30 (30 seconds past midnight)
        const startTime = new Date("2021-01-01T00:00:30.000Z").getTime();
        timeControl.setTime(startTime);

        // Use fast polling to allow minute-level tasks
        const registrations = [
            ["every-minute", "* * * * *", taskCallback, retryDelay] // Every minute
        ];

        await capabilities.scheduler.initialize(registrations);

        // Wait for scheduler to start
        await new Promise(resolve => setTimeout(resolve, 10));

        // The scheduler will catch up and execute the 00:00:00 occurrence from 30 seconds ago
        expect(taskCallback).toHaveBeenCalledTimes(1);

        // Advance by 30 seconds to reach the next minute boundary (00:01:00)
        timeControl.advanceTime(30 * 1000);
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(taskCallback).toHaveBeenCalledTimes(2);

        // Advance by another minute to 00:02:00
        timeControl.advanceTime(60 * 1000);
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(taskCallback).toHaveBeenCalledTimes(3);

        // Advance by another minute to 00:03:00
        timeControl.advanceTime(60 * 1000);
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(taskCallback).toHaveBeenCalledTimes(4);

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
        const startTime = new Date("2021-01-01T00:15:00.000Z").getTime();
        timeControl.setTime(startTime);

        const registrations = [
            ["time-check-task", "0 * * * *", taskCallback, retryDelay] // Every hour at 0 minutes
        ];

        await capabilities.scheduler.initialize(registrations);

        // Wait for scheduler to start
        await new Promise(resolve => setTimeout(resolve, 10));

        // The scheduler will catch up and execute the 00:00:00 occurrence from 15 minutes ago
        expect(taskCallback.executionTimes).toHaveLength(1);
        expect(taskCallback.executionTimes[0]).toBe(startTime);

        // Advance to next execution (01:00:00)
        timeControl.advanceTime(45 * 60 * 1000); // 45 minutes to reach 01:00:00
        await new Promise(resolve => setTimeout(resolve, 10));

        expect(taskCallback.executionTimes).toHaveLength(2);
        expect(taskCallback.executionTimes[1]).toBe(startTime + 45 * 60 * 1000);

        await capabilities.scheduler.stop();
    });

    test("should demonstrate catching up on missed executions with gradual polling", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = fromMilliseconds(5000);
        const taskCallback = jest.fn();

        // Set initial time 
        const startTime = new Date("2021-01-01T00:10:00.000Z").getTime();
        timeControl.setTime(startTime);

        const registrations = [
            ["hourly-task", "0 * * * *", taskCallback, retryDelay] // Every hour at 0 minutes
        ];

        await capabilities.scheduler.initialize(registrations);

        // Wait for scheduler to start
        await new Promise(resolve => setTimeout(resolve, 10));

        // The scheduler will catch up and execute the 00:00:00 occurrence from 10 minutes ago
        expect(taskCallback).toHaveBeenCalledTimes(1);

        // Jump ahead 5 hours at once - scheduler will only catch the most recent execution
        timeControl.advanceTime(5 * 60 * 60 * 1000 - 10 * 60 * 1000); // to 05:00:00
        await new Promise(resolve => setTimeout(resolve, 10));

        // Should only execute once more (for the most recent hour), not 5 times
        expect(taskCallback).toHaveBeenCalledTimes(2);

        // But if we poll gradually hour by hour from here, we get individual executions
        timeControl.advanceTime(60 * 60 * 1000); // to 06:00:00
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(taskCallback).toHaveBeenCalledTimes(3);

        timeControl.advanceTime(60 * 60 * 1000); // to 07:00:00
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(taskCallback).toHaveBeenCalledTimes(4);

        await capabilities.scheduler.stop();
    });
});