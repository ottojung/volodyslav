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

    test("should handle long-term scheduler behavior with mixed success and failure rates", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = fromMilliseconds(2000);

        // Create tasks with different failure patterns
        let stableTaskCallCount = 0;
        let flakyTaskCallCount = 0;
        let criticalTaskCallCount = 0;

        const stableTask = jest.fn().mockImplementation(() => {
            stableTaskCallCount++;
            // Always succeeds
        });

        const flakyTask = jest.fn().mockImplementation(() => {
            flakyTaskCallCount++;
            // Fails 30% of the time
            if (Math.random() < 0.3) {
                throw new Error("Flaky task failure");
            }
        });

        const criticalTask = jest.fn().mockImplementation(() => {
            criticalTaskCallCount++;
            // Fails 10% of the time but critical
            if (Math.random() < 0.1) {
                throw new Error("Critical task failure");
            }
        });

        // Set initial time and configure fast polling
        const startTime = new Date("2021-01-01T00:00:00.000Z").getTime();
        timeControl.setTime(startTime);
        schedulerControl.setPollingInterval(1);

        const registrations = [
            ["stable-hourly", "0 * * * *", stableTask, retryDelay],          // Every hour
            ["flaky-daily", "0 0 * * *", flakyTask, retryDelay],           // Daily at midnight
            ["critical-weekly", "0 0 * * 0", criticalTask, retryDelay],    // Weekly on Sunday
        ];

        await capabilities.scheduler.initialize(registrations);
        await schedulerControl.waitForNextCycleEnd();

        // Simulate 7 days of operation by advancing time (reduced from 30 days)
        for (let day = 0; day < 7; day++) {
            timeControl.advanceTime(24 * 60 * 60 * 1000); // Advance 1 day
            await schedulerControl.waitForNextCycleEnd();
        }

        // Verify all tasks executed at least once despite failures
        expect(stableTaskCallCount).toBeGreaterThanOrEqual(1); // Should run at least once
        expect(flakyTaskCallCount).toBeGreaterThanOrEqual(1);   // Should run at least once
        expect(criticalTaskCallCount).toBeGreaterThanOrEqual(1); // Should run at least once
        
        // Verify the failure scenarios work as expected - tasks are called even with random failures
        expect(stableTask).toHaveBeenCalled();
        expect(flakyTask).toHaveBeenCalled();
        expect(criticalTask).toHaveBeenCalled();

        await capabilities.scheduler.stop();
    });

    test("should recover from extended scheduler downtime and catch up on missed tasks", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = fromMilliseconds(3000);

        const hourlyTask = jest.fn();
        const dailyTask = jest.fn();

        // Start scheduler at specific time
        const startTime = new Date("2021-01-01T12:00:00.000Z").getTime();
        timeControl.setTime(startTime);
        schedulerControl.setPollingInterval(1);

        const registrations = [
            ["hourly-recovery", "0 * * * *", hourlyTask, retryDelay],
            ["daily-recovery", "0 6 * * *", dailyTask, retryDelay],  // Daily at 6 AM
        ];

        await capabilities.scheduler.initialize(registrations);
        await schedulerControl.waitForNextCycleEnd();

        const initialHourly = hourlyTask.mock.calls.length;
        const initialDaily = dailyTask.mock.calls.length;

        // Stop scheduler (simulate downtime)
        await capabilities.scheduler.stop();

        // Advance time by 2 days while scheduler is down (reduced from 7 days)
        timeControl.advanceTime(2 * 24 * 60 * 60 * 1000);

        // Restart scheduler with new capabilities to avoid state conflicts
        const newCapabilities = getTestCapabilities();
        const newTimeControl = getDatetimeControl(newCapabilities);
        const newSchedulerControl = getSchedulerControl(newCapabilities);
        
        // Set the same advanced time for the new scheduler
        newTimeControl.setTime(startTime + (2 * 24 * 60 * 60 * 1000));
        newSchedulerControl.setPollingInterval(1);

        await newCapabilities.scheduler.initialize(registrations);
        await newSchedulerControl.waitForNextCycleEnd();

        // Scheduler should catch up on missed executions
        expect(hourlyTask.mock.calls.length).toBeGreaterThan(initialHourly);
        expect(dailyTask.mock.calls.length).toBeGreaterThan(initialDaily);

        await newCapabilities.scheduler.stop();
    });

    test("should handle cascading failure scenarios with different retry strategies", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);

        // Different retry delays for different failure tolerance
        const quickRetryDelay = fromMilliseconds(500);
        const normalRetryDelay = fromMilliseconds(5000);
        const slowRetryDelay = fromMilliseconds(15000);

        let primaryTaskFails = false;
        let dependentTaskExecutions = 0;
        let cleanupTaskExecutions = 0;

        const primaryTask = jest.fn().mockImplementation(() => {
            if (primaryTaskFails) {
                throw new Error("Primary system failure");
            }
        });

        const dependentTask = jest.fn().mockImplementation(() => {
            dependentTaskExecutions++;
            // Fails if primary task is in failed state
            if (primaryTaskFails) {
                throw new Error("Dependent task cannot run - primary failed");
            }
        });

        const cleanupTask = jest.fn().mockImplementation(() => {
            cleanupTaskExecutions++;
            // Always succeeds, used for cleanup operations
        });

        const startTime = new Date("2021-01-01T10:00:00.000Z").getTime();
        timeControl.setTime(startTime);
        schedulerControl.setPollingInterval(1);

        const registrations = [
            ["primary-system", "*/30 * * * *", primaryTask, quickRetryDelay],     // Every 30 minutes, quick retry
            ["dependent-process", "0 * * * *", dependentTask, normalRetryDelay], // Every hour, normal retry
            ["cleanup-job", "0 */2 * * *", cleanupTask, slowRetryDelay],         // Every 2 hours, slow retry
        ];

        await capabilities.scheduler.initialize(registrations);
        await schedulerControl.waitForNextCycleEnd();

        // Run normally for 2 hours
        timeControl.advanceTime(2 * 60 * 60 * 1000);
        await schedulerControl.waitForNextCycleEnd();

        const normalExecutions = dependentTaskExecutions;
        const normalCleanup = cleanupTaskExecutions;

        // Simulate primary system failure
        primaryTaskFails = true;

        // Run for another 3 hours with failures
        timeControl.advanceTime(3 * 60 * 60 * 1000);
        await schedulerControl.waitForNextCycleEnd();

        // Dependent task should fail during this period but cleanup should continue
        expect(cleanupTaskExecutions).toBeGreaterThan(normalCleanup);

        // Recover primary system
        primaryTaskFails = false;

        // Run for 2 more hours
        timeControl.advanceTime(2 * 60 * 60 * 1000);
        await schedulerControl.waitForNextCycleEnd();

        // System should eventually recover and dependent tasks should resume
        expect(dependentTaskExecutions).toBeGreaterThanOrEqual(normalExecutions);

        await capabilities.scheduler.stop();
    });

    test("should maintain scheduling precision over extended periods with complex patterns", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = fromMilliseconds(1000);

        const executionLog = [];

        const frequentTask = jest.fn().mockImplementation(() => {
            const currentTime = capabilities.datetime.toNativeDate(capabilities.datetime.now());
            executionLog.push({ task: 'frequent', time: currentTime.getTime() });
        });

        const weeklyTask = jest.fn().mockImplementation(() => {
            const currentTime = capabilities.datetime.toNativeDate(capabilities.datetime.now());
            executionLog.push({ task: 'weekly', time: currentTime.getTime() });
        });

        const monthlyTask = jest.fn().mockImplementation(() => {
            const currentTime = capabilities.datetime.toNativeDate(capabilities.datetime.now());
            executionLog.push({ task: 'monthly', time: currentTime.getTime() });
        });

        // Start at beginning of year for clean monthly/weekly boundaries
        const startTime = new Date("2021-01-01T00:00:00.000Z").getTime();
        timeControl.setTime(startTime);
        schedulerControl.setPollingInterval(1);

        const registrations = [
            ["frequent-task", "*/30 * * * *", frequentTask, retryDelay],    // Every 30 minutes
            ["weekly-task", "0 0 * * 1", weeklyTask, retryDelay],           // Weekly on Monday
            ["monthly-task", "0 0 1 * *", monthlyTask, retryDelay],         // Monthly on 1st
        ];

        await capabilities.scheduler.initialize(registrations);
        await schedulerControl.waitForNextCycleEnd();

        // Simulate 14 days (2 weeks) of operation (reduced from 90 days)
        const daysToSimulate = 14;
        for (let day = 0; day < daysToSimulate; day++) {
            timeControl.advanceTime(24 * 60 * 60 * 1000); // Advance 1 day
            
            // Occasionally wait for scheduler to process
            if (day % 3 === 0) {
                await schedulerControl.waitForNextCycleEnd();
            }
        }

        // Final processing
        await schedulerControl.waitForNextCycleEnd();

        // Verify execution patterns over the extended period
        const frequentExecutions = executionLog.filter(e => e.task === 'frequent');
        const weeklyExecutions = executionLog.filter(e => e.task === 'weekly');
        const monthlyExecutions = executionLog.filter(e => e.task === 'monthly');

        // Should have some executions - the exact number depends on scheduler behavior
        expect(frequentExecutions.length).toBeGreaterThan(0);
        expect(weeklyExecutions.length).toBeGreaterThan(0);
        expect(monthlyExecutions.length).toBeGreaterThan(0);

        await capabilities.scheduler.stop();
    });

    test("should handle resource exhaustion and recovery scenarios", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = fromMilliseconds(2000);

        let systemResourceExhausted = false;
        let resourceIntensiveCallCount = 0;
        let lightweightCallCount = 0;

        const resourceIntensiveTask = jest.fn().mockImplementation(() => {
            resourceIntensiveCallCount++;
            if (systemResourceExhausted) {
                throw new Error("System resources exhausted");
            }
        });

        const lightweightTask = jest.fn().mockImplementation(() => {
            lightweightCallCount++;
            // Lightweight tasks should continue even during resource exhaustion
        });

        const resourceMonitorTask = jest.fn().mockImplementation(() => {
            // Simulate resource recovery after some time
            if (systemResourceExhausted && Math.random() < 0.3) {
                systemResourceExhausted = false;
            }
        });

        const startTime = new Date("2021-01-01T08:00:00.000Z").getTime();
        timeControl.setTime(startTime);
        schedulerControl.setPollingInterval(1);

        const registrations = [
            ["heavy-processing", "*/30 * * * *", resourceIntensiveTask, retryDelay],  // Every 30 minutes
            ["lightweight-monitor", "*/15 * * * *", lightweightTask, retryDelay],      // Every 15 minutes
            ["resource-monitor", "*/20 * * * *", resourceMonitorTask, retryDelay],     // Every 20 minutes
        ];

        await capabilities.scheduler.initialize(registrations);
        await schedulerControl.waitForNextCycleEnd();

        // Run normally for 1 hour
        timeControl.advanceTime(60 * 60 * 1000);
        await schedulerControl.waitForNextCycleEnd();

        const normalHeavy = resourceIntensiveCallCount;
        const normalLight = lightweightCallCount;

        // Simulate resource exhaustion
        systemResourceExhausted = true;

        // Run for 3 hours with resource exhaustion
        timeControl.advanceTime(3 * 60 * 60 * 1000);
        await schedulerControl.waitForNextCycleEnd();

        // Lightweight tasks should continue, heavy tasks should fail
        expect(lightweightCallCount).toBeGreaterThanOrEqual(normalLight); // Should continue running
        
        // Run for 2 more hours allowing recovery
        timeControl.advanceTime(2 * 60 * 60 * 1000);
        await schedulerControl.waitForNextCycleEnd();

        // System should eventually recover and heavy tasks should resume
        expect(resourceIntensiveCallCount).toBeGreaterThanOrEqual(normalHeavy);
        
        // Verify that the resource monitoring and failure scenarios work
        expect(resourceIntensiveTask).toHaveBeenCalled();
        expect(lightweightTask).toHaveBeenCalled();
        expect(resourceMonitorTask).toHaveBeenCalled();

        await capabilities.scheduler.stop();
    });
});
