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
    stubPollInterval(1); // Fast polling for tests - use real timers
    return capabilities;
}

describe("scheduler time advancement demo", () => {
    test("should observe multiple task invocations by advancing time gradually", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = fromMilliseconds(5000);
        const taskCallback = jest.fn().mockImplementation(() => {
            const currentTime = timeControl.getCurrentTime();
            console.log(`Task executed at: ${new Date(currentTime).toISOString()}`);
        });

        // Set initial time to 00:05:00
        const startTime = new Date("2021-01-01T00:05:00.000Z").getTime();
        timeControl.setTime(startTime);
        console.log(`Start time: ${new Date(startTime).toISOString()}`);

        // Schedule a task that runs at 30 minutes past each hour
        const registrations = [
            ["half-hour-task", "30 * * * *", taskCallback, retryDelay] // Runs at minute 30 of each hour
        ];

        await capabilities.scheduler.initialize(registrations);

        // Wait for scheduler to start and possibly catch up
        // With fast polling (1ms), we should see execution within 100ms
        await new Promise(resolve => setTimeout(resolve, 100));

        // The scheduler may or may not catch up immediately - check current call count
        const initialCalls = taskCallback.mock.calls.length;
        console.log(`Initial calls: ${initialCalls}`);
        
        // Now test that advancing time triggers new executions
        // Advance time to 00:30:00 (first execution after initialization)
        console.log("Advancing time to 00:30:00...");
        timeControl.advanceTime(25 * 60 * 1000); // 25 minutes to reach 00:30:00
        console.log(`After advance: ${new Date(timeControl.getCurrentTime()).toISOString()}`);
        
        // Manually trigger polling since setInterval doesn't work with mocked time
        await capabilities.scheduler.poll();
        
        // Wait for task execution to complete
        await new Promise(resolve => setTimeout(resolve, 50));
        
        console.log(`Calls after first advance: ${taskCallback.mock.calls.length}`);
        
        // Should have at least one more call than initial
        expect(taskCallback.mock.calls.length).toBeGreaterThan(initialCalls);
        
        const afterFirstAdvance = taskCallback.mock.calls.length;

        // Advance to 01:30:00
        timeControl.advanceTime(60 * 60 * 1000); // 1 hour
        await capabilities.scheduler.poll(); // Manually trigger polling
        await new Promise(resolve => setTimeout(resolve, 50)); // Wait for execution
        expect(taskCallback.mock.calls.length).toBeGreaterThan(afterFirstAdvance);

        const afterSecondAdvance = taskCallback.mock.calls.length;

        // Advance to 02:30:00
        timeControl.advanceTime(60 * 60 * 1000); // 1 hour
        await capabilities.scheduler.poll(); // Manually trigger polling
        await new Promise(resolve => setTimeout(resolve, 50)); // Wait for execution
        expect(taskCallback.mock.calls.length).toBeGreaterThan(afterSecondAdvance);

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

        // Wait for scheduler to start up and potentially catch up
        await new Promise(resolve => setTimeout(resolve, 200));

        // Both tasks should catch up for their previous occurrences
        expect(hourlyTask.mock.calls.length).toBeGreaterThan(0);
        expect(dailyTask.mock.calls.length).toBeGreaterThan(0);

        // Test that the scheduler is running and tasks are registered
        // This is mainly a smoke test to ensure the multiple task scheduling works
        
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
        await new Promise(resolve => setTimeout(resolve, 100));

        // Check initial execution count
        const initialCalls = taskCallback.mock.calls.length;

        // Advance by 30 seconds to reach the next minute boundary (00:01:00)
        timeControl.advanceTime(30 * 1000);
        await new Promise(resolve => setTimeout(resolve, 100));
        // Should have executed at least once more
        expect(taskCallback.mock.calls.length).toBeGreaterThan(initialCalls);
        const afterFirstAdvance = taskCallback.mock.calls.length;

        // Advance by another minute to 00:02:00
        timeControl.advanceTime(60 * 1000);
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(taskCallback.mock.calls.length).toBeGreaterThan(afterFirstAdvance);

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
        await new Promise(resolve => setTimeout(resolve, 100));

        // Check that task has executed and recorded times
        expect(taskCallback.executionTimes).toBeDefined();
        expect(taskCallback.executionTimes.length).toBeGreaterThan(0);
        
        const initialExecutions = taskCallback.executionTimes.length;

        // Advance to next execution (01:00:00)
        timeControl.advanceTime(45 * 60 * 1000); // 45 minutes to reach 01:00:00
        await new Promise(resolve => setTimeout(resolve, 100));

        // Should have more executions
        expect(taskCallback.executionTimes.length).toBeGreaterThan(initialExecutions);

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
        await new Promise(resolve => setTimeout(resolve, 100));

        // Check initial executions
        const initialCalls = taskCallback.mock.calls.length;

        // Jump ahead 5 hours at once - scheduler behavior may vary
        timeControl.advanceTime(5 * 60 * 60 * 1000 - 10 * 60 * 1000); // to 05:00:00
        await new Promise(resolve => setTimeout(resolve, 100));

        // Should have executed at least once more
        expect(taskCallback.mock.calls.length).toBeGreaterThan(initialCalls);
        const afterBigJump = taskCallback.mock.calls.length;

        // Poll gradually hour by hour from here to see individual executions
        timeControl.advanceTime(60 * 60 * 1000); // to 06:00:00
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(taskCallback.mock.calls.length).toBeGreaterThan(afterBigJump);

        await capabilities.scheduler.stop();
    });
});