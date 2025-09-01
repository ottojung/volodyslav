/**
 * Test to investigate race conditions when not stubbing runtime state.
 * This should expose bugs related to concurrent state mutations.
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
    // NOTE: NOT stubbing runtime state storage - this should reveal the bug
    // stubRuntimeStateStorage(capabilities);
    stubScheduler(capabilities);
    return capabilities;
}

describe("scheduler race condition investigation", () => {
    test("attempt to trigger concurrent state mutations", async () => {
        const capabilities = getTestCapabilities();
        const schedulerControl = getSchedulerControl(capabilities);
        schedulerControl.setPollingInterval(1); // Very fast polling
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = Duration.fromMillis(1000); // Short retry delay

        let task1Count = 0;
        let task2Count = 0;
        let task3Count = 0;

        // Create tasks that run simultaneously
        const task1 = jest.fn(async () => {
            task1Count++;
            // Simulate some work
            await new Promise(resolve => setTimeout(resolve, 10));
        });

        const task2 = jest.fn(async () => {
            task2Count++;
            // Simulate some work
            await new Promise(resolve => setTimeout(resolve, 10));
        });

        const task3 = jest.fn(async () => {
            task3Count++;
            // Simulate some work
            await new Promise(resolve => setTimeout(resolve, 10));
        });

        const registrations = [
            ["concurrent-task-1", "* * * * *", task1, retryDelay], // Every minute
            ["concurrent-task-2", "* * * * *", task2, retryDelay], // Every minute  
            ["concurrent-task-3", "* * * * *", task3, retryDelay], // Every minute
        ];

        // Set time to trigger immediate execution for all tasks
        const startTime = new Date("2021-01-01T00:00:00.000Z").getTime();
        timeControl.setTime(startTime);

        await capabilities.scheduler.initialize(registrations);
        await schedulerControl.waitForNextCycleEnd();

        // All tasks should execute at least once
        expect(task1Count).toBeGreaterThan(0);
        expect(task2Count).toBeGreaterThan(0); 
        expect(task3Count).toBeGreaterThan(0);

        // Advance time and let tasks run multiple times to try to trigger races
        timeControl.advanceTime(2 * 60 * 1000); // 2 minutes
        await schedulerControl.waitForNextCycleEnd();
        
        timeControl.advanceTime(3 * 60 * 1000); // 3 more minutes
        await schedulerControl.waitForNextCycleEnd();

        // Stop scheduler
        await capabilities.scheduler.stop();
        
        console.log(`Task counts: task1=${task1Count}, task2=${task2Count}, task3=${task3Count}`);
    });

    test("test multiple scheduler restarts without state stubbing", async () => {
        const retryDelay = Duration.fromMillis(1000);
        let totalExecutions = 0;

        const task = jest.fn(async () => {
            totalExecutions++;
        });

        const registrations = [
            ["restart-test-task", "0 * * * *", task, retryDelay], // Every hour
        ];

        // First scheduler instance
        const capabilities1 = getTestCapabilities();
        const timeControl1 = getDatetimeControl(capabilities1);
        const schedulerControl1 = getSchedulerControl(capabilities1);
        
        const startTime = new Date("2021-01-01T00:00:00.000Z").getTime();
        timeControl1.setTime(startTime);
        schedulerControl1.setPollingInterval(1);

        await capabilities1.scheduler.initialize(registrations);
        await schedulerControl1.waitForNextCycleEnd();
        
        const executionsAfterFirst = totalExecutions;
        expect(executionsAfterFirst).toBeGreaterThan(0);
        
        await capabilities1.scheduler.stop();

        // Second scheduler instance (restart)
        const capabilities2 = getTestCapabilities();
        const timeControl2 = getDatetimeControl(capabilities2);
        const schedulerControl2 = getSchedulerControl(capabilities2);
        
        // Advance time by 1 hour for next execution
        timeControl2.setTime(startTime + 60 * 60 * 1000);
        schedulerControl2.setPollingInterval(1);

        await capabilities2.scheduler.initialize(registrations);
        await schedulerControl2.waitForNextCycleEnd();
        
        const executionsAfterSecond = totalExecutions;
        expect(executionsAfterSecond).toBeGreaterThan(executionsAfterFirst);
        
        await capabilities2.scheduler.stop();

        console.log(`Total executions: ${totalExecutions}`);
    });
});