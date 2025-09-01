/**
 * Test to demonstrate the race condition bug in scheduler state updates.
 * This test should fail when NOT using stubRuntimeStateStorage due to 
 * concurrent task executions corrupting the runtime state.
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
    // NOTE: NOT stubbing runtime state storage - this should reveal the race condition bug
    // stubRuntimeStateStorage(capabilities);
    stubScheduler(capabilities);
    return capabilities;
}

describe("scheduler state race condition bug", () => {
    test("should demonstrate race condition in concurrent task state updates", async () => {
        const capabilities = getTestCapabilities();
        const schedulerControl = getSchedulerControl(capabilities);
        // Use slower polling to allow multiple tasks to execute concurrently
        schedulerControl.setPollingInterval(100); // 100ms polling  
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = Duration.fromMillis(1000);

        let task1Executions = 0;
        let task2Executions = 0;
        let task3Executions = 0;

        // Create tasks that execute quickly and concurrently
        const task1 = jest.fn(async () => {
            task1Executions++;
            // Very short execution time to increase likelihood of concurrent execution
            await new Promise(resolve => setTimeout(resolve, 1));
        });

        const task2 = jest.fn(async () => {
            task2Executions++;
            await new Promise(resolve => setTimeout(resolve, 1));
        });

        const task3 = jest.fn(async () => {
            task3Executions++;
            await new Promise(resolve => setTimeout(resolve, 1));
        });

        // Use schedules that are compatible with the real polling frequency (10 minutes)
        const registrations = [
            ["race-task-1", "0,30 */3 * * *", task1, retryDelay], // Every 3 hours at minute 0 and 30
            ["race-task-2", "0,30 */3 * * *", task2, retryDelay], // Every 3 hours at minute 0 and 30  
            ["race-task-3", "0,30 */3 * * *", task3, retryDelay], // Every 3 hours at minute 0 and 30
        ];

        // Set time to exactly when all tasks should trigger (hour divisible by 3, minute 0)
        const startTime = new Date("2021-01-01T03:00:00.000Z").getTime();
        timeControl.setTime(startTime);

        await capabilities.scheduler.initialize(registrations);
        
        // Wait for the first polling cycle to execute all tasks
        await schedulerControl.waitForNextCycleEnd();

        // All tasks should execute at least once
        expect(task1Executions).toBeGreaterThan(0);
        expect(task2Executions).toBeGreaterThan(0);
        expect(task3Executions).toBeGreaterThan(0);

        console.log(`After first cycle: task1=${task1Executions}, task2=${task2Executions}, task3=${task3Executions}`);

        // Now advance to the next execution time (next 3-hour interval at minute 0)
        timeControl.advanceTime(3 * 60 * 60 * 1000); // 3 hours to next execution
        await schedulerControl.waitForNextCycleEnd();

        // All tasks should execute again
        expect(task1Executions).toBe(2);
        expect(task2Executions).toBe(2);
        expect(task3Executions).toBe(2);

        console.log(`After second cycle: task1=${task1Executions}, task2=${task2Executions}, task3=${task3Executions}`);

        await capabilities.scheduler.stop();

        // If we reach here without errors, then either:
        // 1. The race condition didn't occur (unlikely with concurrent tasks)
        // 2. The race condition occurred but didn't cause visible test failures
        // 3. There is proper synchronization preventing the race condition
    });

    test("should trigger state corruption with rapid task execution and state queries", async () => {
        const capabilities = getTestCapabilities();
        const schedulerControl = getSchedulerControl(capabilities);
        schedulerControl.setPollingInterval(50); // Very fast polling
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = Duration.fromMillis(100); // Very short retry delay

        let successCount = 0;
        let failCount = 0;

        // Create a task that sometimes fails to force state updates for both success and failure paths
        const flakyTask = jest.fn(async () => {
            if (Math.random() < 0.5) {
                successCount++;
                // Task succeeds - should update lastSuccessTime and clear retry info
            } else {
                failCount++;
                // Task fails - should update lastFailureTime and set retry time
                throw new Error("Simulated task failure");
            }
        });

        const registrations = [
            ["flaky-task", "*/10 * * * *", flakyTask, retryDelay], // Every 10 minutes
        ];

        // Set time to trigger the task
        const startTime = new Date("2021-01-01T01:00:00.000Z").getTime();
        timeControl.setTime(startTime);

        await capabilities.scheduler.initialize(registrations);
        await schedulerControl.waitForNextCycleEnd();

        // Force multiple rapid executions by advancing time rapidly
        for (let i = 0; i < 5; i++) {
            timeControl.advanceTime(10 * 60 * 1000); // 10 minutes each time
            await schedulerControl.waitForNextCycleEnd();
            
            // Add small delay to let tasks complete
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        await capabilities.scheduler.stop();

        console.log(`Total: ${flakyTask.mock.calls.length} executions, ${successCount} successes, ${failCount} failures`);
        
        // The test passes if we don't get any errors, but the race condition
        // might still be occurring silently
        expect(flakyTask.mock.calls.length).toBeGreaterThan(0);
    });
});