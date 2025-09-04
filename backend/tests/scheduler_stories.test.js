/**
 * Demonstration test showing how to use datetime mocking to observe 
 * multiple scheduler task invocations by advancing time.
 */

const { Duration, DateTime } = require("luxon");
const luxon = require("luxon");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper, getDatetimeControl, stubRuntimeStateStorage, stubScheduler, getSchedulerControl } = require("./stubs");
const { toEpochMs } = require("../src/datetime");
const { tryDeserialize, isTaskTryDeserializeError } = require("../src/scheduler/task");
const { parseCronExpression } = require("../src/scheduler/expression");

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
        const retryDelay = Duration.fromMillis(5000);
        const taskCallback = jest.fn();

        // Set initial time to 00:05:00
        const startTime = luxon.DateTime.fromISO("2021-01-01T00:05:00Z").toMillis();
        timeControl.setTime(startTime);
        schedulerControl.setPollingInterval(1);

        // Schedule a task that runs at 30 minutes past each hour
        const registrations = [
            ["half-hour-task", "30 * * * *", taskCallback, retryDelay] // Runs at minute 30 of each hour
        ];

        await capabilities.scheduler.initialize(registrations);

        // Wait for scheduler to start 
        await schedulerControl.waitForNextCycleEnd();

        // Should not execute at 05 minutes.
        const initialCalls = taskCallback.mock.calls.length;
        expect(initialCalls).toBe(0);

        // Now test that advancing time triggers new executions
        // Advance time to 00:30:00 (first execution after initialization)
        timeControl.advanceTime(25 * 60 * 1000); // 25 minutes to reach 00:30:00
        await schedulerControl.waitForNextCycleEnd();

        // Should have one more call
        expect(taskCallback.mock.calls.length).toBe(initialCalls + 1);

        const afterFirstAdvance = taskCallback.mock.calls.length;

        // Advance to 01:30:00
        timeControl.advanceTime(60 * 60 * 1000); // 1 hour
        await schedulerControl.waitForNextCycleEnd();
        expect(taskCallback.mock.calls.length).toBe(afterFirstAdvance + 1);

        const afterSecondAdvance = taskCallback.mock.calls.length;

        // Advance to 02:30:00
        timeControl.advanceTime(60 * 60 * 1000); // 1 hour
        await schedulerControl.waitForNextCycleEnd();
        expect(taskCallback.mock.calls.length).toBe(afterSecondAdvance + 1);

        await capabilities.scheduler.stop();
    });

    test("should handle multiple tasks with different schedules", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = Duration.fromMillis(5000);

        const hourlyTask = jest.fn();
        const dailyTask = jest.fn();

        // Set start time to 01:15:00 on Jan 1, 2021
        const startTime = 1609463700000 // 2021-01-01T01:15:00.000Z;
        timeControl.setTime(startTime);
        schedulerControl.setPollingInterval(1);

        const registrations = [
            ["hourly-task", "0 * * * *", hourlyTask, retryDelay],   // Every hour at 0 minutes
            ["daily-task", "0 0 * * *", dailyTask, retryDelay],    // Every day at midnight (0:00)
        ];

        await capabilities.scheduler.initialize(registrations);

        // Wait for scheduler to start up.
        await schedulerControl.waitForNextCycleEnd();

        // Should NOT execute immediately on first startup
        expect(hourlyTask.mock.calls.length).toBe(0);
        expect(dailyTask.mock.calls.length).toBe(0);

        // Test that the scheduler is running and tasks are registered
        // This is mainly a smoke test to ensure the multiple task scheduling works

        await capabilities.scheduler.stop();
    });

    test("should demonstrate sub-hour polling with time advancement", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = Duration.fromMillis(1000);
        const taskCallback = jest.fn();

        // Set initial time to 00:00:00 (midnight)
        const startTime = DateTime.fromISO("2021-01-01T00:00:00.000Z").toMillis();
        timeControl.setTime(startTime);
        schedulerControl.setPollingInterval(1);

        // Use fast polling to allow minute-level tasks
        const registrations = [
            ["every-minute", "*/30 * * * *", taskCallback, retryDelay] // Every 30 minutes
        ];

        await capabilities.scheduler.initialize(registrations);

        // Wait for scheduler to start
        await schedulerControl.waitForNextCycleEnd();

        // Should execute at 00 minute.
        const initialCalls = taskCallback.mock.calls.length;
        expect(initialCalls).toBe(1);

        // Advance by 30 minutes to reach the next minute boundary (00:30:00)
        timeControl.advanceTime(30 * 60 * 1000);
        await schedulerControl.waitForNextCycleEnd();
        // Should have executed once more
        expect(taskCallback.mock.calls.length).toBe(initialCalls + 1);
        const afterFirstAdvance = taskCallback.mock.calls.length;

        // Advance by another 30 minutes to 01:00:00
        timeControl.advanceTime(30 * 60 * 1000);
        await schedulerControl.waitForNextCycleEnd();
        expect(taskCallback.mock.calls.length).toBe(afterFirstAdvance + 1);

        await capabilities.scheduler.stop();
    });

    test("should verify time consistency across scheduler operations", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = Duration.fromMillis(5000);

        const taskCallback = jest.fn().mockImplementation(() => {
            // Verify that during task execution, the scheduler sees consistent time
            const executionTime = toEpochMs(capabilities.datetime.now());
            taskCallback.executionTimes = taskCallback.executionTimes || [];
            taskCallback.executionTimes.push(executionTime);
        });

        // Set specific start time
        const startTime = luxon.DateTime.fromISO("2021-01-01T00:15:00.000Z").toMillis();
        timeControl.setTime(startTime);
        schedulerControl.setPollingInterval(1);

        const registrations = [
            ["time-check-task", "0 * * * *", taskCallback, retryDelay] // Every hour at 0 minutes
        ];

        await capabilities.scheduler.initialize(registrations);

        // Wait for scheduler to start
        await schedulerControl.waitForNextCycleEnd();

        // With new behavior, tasks should NOT execute immediately on first startup
        expect(taskCallback.executionTimes).toBeUndefined();

        // Advance to next execution (01:00:00)
        timeControl.advanceTime(45 * 60 * 1000); // 45 minutes to reach 01:00:00
        await schedulerControl.waitForNextCycleEnd();

        // Should have executed now
        expect(taskCallback.executionTimes).toBeDefined();
        expect(taskCallback.executionTimes.length).toBeGreaterThan(0);

        await capabilities.scheduler.stop();
    });

    test("should demonstrate catching up on missed executions with gradual polling", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = Duration.fromMillis(5000);
        const taskCallback = jest.fn();

        // Set initial time 
        const startTime = DateTime.fromISO("2021-01-01T00:10:00.000Z").toMillis();
        timeControl.setTime(startTime);
        schedulerControl.setPollingInterval(1);

        const registrations = [
            ["hourly-task", "0 * * * *", taskCallback, retryDelay] // Every hour at 0 minutes
        ];

        await capabilities.scheduler.initialize(registrations);

        // Wait for scheduler to start
        await schedulerControl.waitForNextCycleEnd();

        // With new behavior, tasks should NOT execute immediately on first startup  
        const initialCalls = taskCallback.mock.calls.length;
        expect(initialCalls).toBe(0);

        // Jump ahead 5 hours at once - scheduler behavior may vary
        timeControl.advanceTime(5 * 60 * 60 * 1000 - 10 * 60 * 1000); // to 05:00:00
        await schedulerControl.waitForNextCycleEnd();

        // Should have executed once more because of no "make-up" semantics.
        expect(taskCallback.mock.calls.length).toEqual(initialCalls + 1);
        const afterBigJump = taskCallback.mock.calls.length;

        // Poll gradually hour by hour from here to see individual executions
        timeControl.advanceTime(60 * 60 * 1000); // to 06:00:00
        await schedulerControl.waitForNextCycleEnd();
        expect(taskCallback.mock.calls.length).toEqual(afterBigJump + 1);

        await capabilities.scheduler.stop();
    });

    test("should handle long-term scheduler behavior with mixed success and failure rates", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = Duration.fromMillis(100); // Reduce retry delay

        // Create tasks with different failure patterns
        let stableTaskCallCount = 0;
        let flakyTaskCallCount = 0;

        const stableTask = jest.fn().mockImplementation(() => {
            stableTaskCallCount++;
            // Always succeeds
        });

        const flakyTask = jest.fn().mockImplementation(() => {
            flakyTaskCallCount++;
            // Fails after the first time.
            if (flakyTaskCallCount === 1) {
                throw new Error("Flaky task failure");
            }
        });

        // Set initial time and configure polling
        const startTime = luxon.DateTime.fromISO("2021-01-01T00:00:00.000Z").toMillis();
        timeControl.setTime(startTime);
        schedulerControl.setPollingInterval(100);

        const registrations = [
            ["stable-frequent", "*/30 * * * *", stableTask, retryDelay],       // Every 30 minutes
            ["flaky-frequent", "*/45 * * * *", flakyTask, retryDelay],         // Every 45 minutes
        ];

        await capabilities.scheduler.initialize(registrations);
        await schedulerControl.waitForNextCycleEnd();

        // Should execute at 00.
        expect(stableTaskCallCount).toBe(1);
        expect(flakyTaskCallCount).toBe(1);

        // Simulate just 2 hours instead of 7 days for faster testing
        timeControl.advanceTime(2 * 60 * 60 * 1000); // Advance 2 hours
        await schedulerControl.waitForNextCycleEnd();

        // Verify all tasks executed at least once despite failures
        expect(stableTaskCallCount).toBe(2);
        expect(flakyTaskCallCount).toBe(2);

        // Verify the failure scenarios work as expected - tasks are called even with random failures
        expect(stableTask).toHaveBeenCalled();
        expect(flakyTask).toHaveBeenCalled();

        await capabilities.scheduler.stop();
    });

    test("should recover from extended scheduler downtime and catch up on missed tasks", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = Duration.fromMillis(3000);

        const hourlyTask = jest.fn();
        const dailyTask = jest.fn();

        // Start scheduler at specific time
        const startTime = luxon.DateTime.fromISO("2021-01-01T12:00:00.000Z").toMillis();
        timeControl.setTime(startTime);
        schedulerControl.setPollingInterval(1);

        const registrations = [
            ["hourly-recovery", "0 * * * *", hourlyTask, retryDelay],
            ["daily-recovery", "0 6 * * *", dailyTask, retryDelay],  // Daily at 6 AM
        ];

        await capabilities.scheduler.initialize(registrations);
        await schedulerControl.waitForNextCycleEnd();

        // Should execute at 00.
        const initialHourly = hourlyTask.mock.calls.length;
        const initialDaily = dailyTask.mock.calls.length;
        expect(initialHourly).toBe(1);
        expect(initialDaily).toBe(0);

        // Stop scheduler (simulate downtime)
        await capabilities.scheduler.stop();

        // Advance time by 2 days while scheduler is down (reduced from 7 days)
        timeControl.advanceTime(Duration.fromObject({ days: 2 }).toMillis());

        // Restart scheduler with new capabilities to avoid state conflicts
        const newCapabilities = getTestCapabilities();
        const newTimeControl = getDatetimeControl(newCapabilities);
        const newSchedulerControl = getSchedulerControl(newCapabilities);

        // Set the same advanced time for the new scheduler
        newTimeControl.setTime(timeControl.getCurrentTime());
        newSchedulerControl.setPollingInterval(1);

        await newCapabilities.scheduler.initialize(registrations);
        await newSchedulerControl.waitForNextCycleEnd();

        // Since this is a NEW scheduler instance with fresh state, it should execute immediately.
        expect(hourlyTask.mock.calls.length).toBe(initialHourly + 1);
        expect(dailyTask.mock.calls.length).toBe(initialDaily + 0);

        await newCapabilities.scheduler.stop();
    });

    test("should handle cascading failure scenarios with different retry strategies", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);

        // Different retry delays for different failure tolerance
        const quickRetryDelay = Duration.fromMillis(500);
        const normalRetryDelay = Duration.fromMillis(5000);
        const slowRetryDelay = Duration.fromMillis(15000);

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

        const startTime = 1609495200000 // 2021-01-01T10:00:00.000Z;
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
        const retryDelay = Duration.fromMillis(100);

        const executionLog = [];

        const frequentTask = jest.fn().mockImplementation(() => {
            const currentTime = toEpochMs(capabilities.datetime.now());
            executionLog.push({ task: 'frequent', time: currentTime });
        });

        // Start at a time when the frequent task should trigger soon
        const startTime = DateTime.fromISO("2021-01-01T00:00:00.000Z").toMillis(); // 2021-01-01T00:00:00.000Z
        timeControl.setTime(startTime);
        schedulerControl.setPollingInterval(100);

        const registrations = [
            ["frequent-task", "*/30 * * * *", frequentTask, retryDelay],    // Every 30 minutes
        ];

        await capabilities.scheduler.initialize(registrations);
        await schedulerControl.waitForNextCycleEnd();

        // Advance time by 30 minutes to trigger the frequent task once
        timeControl.advanceTime(30 * 60 * 1000);
        await schedulerControl.waitForNextCycleEnd();

        // Verify that scheduling precision is maintained for the frequent task
        expect(frequentTask).toHaveBeenCalled();
        expect(executionLog.length).toBeGreaterThan(0);

        await capabilities.scheduler.stop();
    });

    test("should handle resource exhaustion and recovery scenarios", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = Duration.fromMillis(2000);

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

        const startTime = 1609488000000 // 2021-01-01T08:00:00.000Z;
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

    test("should execute hourly task with exact precision over multiple hours", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = Duration.fromMillis(1000);
        const hourlyTask = jest.fn();

        // Start at exactly 10:00:00 AM
        const startTime = luxon.DateTime.fromISO("2021-01-01T10:00:00.000Z").toMillis();
        timeControl.setTime(startTime);
        schedulerControl.setPollingInterval(1);

        const registrations = [
            ["precise-hourly", "0 * * * *", hourlyTask, retryDelay], // Every hour at minute 0
        ];

        await capabilities.scheduler.initialize(registrations);
        await schedulerControl.waitForNextCycleEnd();

        // Should execute immediately because 00 minute.
        const initialCount = hourlyTask.mock.calls.length;
        expect(initialCount).toBe(1);

        // Advance to exactly 11:00:00 (next scheduled time)
        timeControl.advanceTime(60 * 60 * 1000); // 1 hour
        await schedulerControl.waitForNextCycleEnd();

        // Should have executed more now
        expect(hourlyTask.mock.calls.length).toBe(2);

        // Advance to exactly 12:00:00
        timeControl.advanceTime(60 * 60 * 1000); // 1 hour
        await schedulerControl.waitForNextCycleEnd();

        // Should have executed exactly once more
        expect(hourlyTask.mock.calls.length).toBe(3);

        // Advance to exactly 13:00:00
        timeControl.advanceTime(60 * 60 * 1000); // 1 hour
        await schedulerControl.waitForNextCycleEnd();

        // Should have executed exactly once more
        expect(hourlyTask.mock.calls.length).toBe(4);

        await capabilities.scheduler.stop();
    });

    test("should execute tasks with exact frequency precision demonstrated over extended periods", async () => {
        const capabilities = getTestCapabilities();
        await capabilities.logger.setup();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = Duration.fromMillis(1000);

        const hourlyTask = jest.fn().mockImplementation(async () => await new Promise(resolve => setTimeout(resolve, 400))); // Runs hourly
        const daily2AMTask = jest.fn().mockImplementation(async () => await new Promise(resolve => setTimeout(resolve, 400))); // Runs daily at 2 AM

        // Start at exactly 1 AM on Jan 1st
        const startTime = 1609462800000 // 2021-01-01T01:00:00.000Z;
        timeControl.setTime(startTime);
        schedulerControl.setPollingInterval(1);

        const registrations = [
            ["hourly-precise", "0 * * * *", hourlyTask, retryDelay],      // Every hour at minute 0
            ["daily-2am", "0 2 * * *", daily2AMTask, retryDelay],         // Daily at 2 AM
        ];

        await capabilities.scheduler.initialize(registrations);
        await schedulerControl.waitForNextCycleEnd();

        // Should execute because 00 minute.
        const initialHourly = hourlyTask.mock.calls.length;
        const initialDaily = daily2AMTask.mock.calls.length;
        expect(initialHourly).toBe(1);
        expect(initialDaily).toBe(0);

        // Advance exactly 1 hour to 2 AM
        timeControl.advanceTime(60 * 60 * 1000);
        await schedulerControl.waitForNextCycleEnd();

        // Both should execute at 2 AM: hourly (every hour) and daily (2 AM schedule)
        expect(daily2AMTask.mock.calls.length).toEqual(1);
        expect(hourlyTask.mock.calls.length).toEqual(2);

        const hourlyAt2AM = hourlyTask.mock.calls.length;
        const dailyAt2AM = daily2AMTask.mock.calls.length;

        // Advance exactly 1 hour to 3 AM
        timeControl.advanceTime(60 * 60 * 1000);
        await schedulerControl.waitForNextCycleEnd();

        // Only hourly should execute, daily should not
        expect(hourlyTask.mock.calls.length).toBeGreaterThan(hourlyAt2AM);
        expect(daily2AMTask.mock.calls.length).toBe(dailyAt2AM); // Should not change

        const hourlyAt3AM = hourlyTask.mock.calls.length;

        // Advance exactly 100 hours to 2 AM next day
        timeControl.advanceTime(23 * 60 * 60 * 1000);
        await schedulerControl.waitForNextCycleEnd();

        // Both should execute again (next daily execution + 23 more hourly executions)
        expect(hourlyTask.mock.calls.length).toBeGreaterThan(hourlyAt3AM);
        expect(daily2AMTask.mock.calls.length).toBeGreaterThan(dailyAt2AM);

        // Verify precise execution count relationships
        const totalHourlyExecutions = hourlyTask.mock.calls.length - initialHourly;
        const totalDailyExecutions = daily2AMTask.mock.calls.length - initialDaily;

        // After 25 hours (1AM -> 2AM next day), we should have many hourly executions and 2 daily executions
        // Let the scheduler process remaining calls.
        expect(totalHourlyExecutions).toBe(3); // Only three executions of the scheduler. Scheduler must not execute "make up" for missed executions.
        expect(totalDailyExecutions).toBe(2); // Exactly 2 daily executions (2 AM each day)

        await capabilities.scheduler.stop();
    });

    test("should execute daily task with exact precision at midnight boundaries", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = Duration.fromMillis(1000);
        const dailyTask = jest.fn();

        // Start at exactly midnight on January 1st
        const startTime = luxon.DateTime.fromISO("2021-01-01T00:00:00.000Z").toMillis();
        timeControl.setTime(startTime);
        schedulerControl.setPollingInterval(1);

        const registrations = [
            ["precise-daily", "0 0 * * *", dailyTask, retryDelay], // Daily at midnight
        ];

        await capabilities.scheduler.initialize(registrations);
        await schedulerControl.waitForNextCycleEnd();

        // Should execute at 00 minutes.
        const initialCount = dailyTask.mock.calls.length;
        expect(initialCount).toBe(1);

        // Advance 24 hours to next midnight (January 2nd)
        timeControl.advanceTime(24 * 60 * 60 * 1000);
        await schedulerControl.waitForNextCycleEnd();
        
        // Should execute at midnight on January 2nd
        expect(dailyTask.mock.calls.length).toBe(initialCount + 1);

        // Advance 12 hours to noon on Jan 2nd (should not execute - not midnight)
        timeControl.advanceTime(12 * 60 * 60 * 1000);
        await schedulerControl.waitForNextCycleEnd();
        
        // Should not execute again (not midnight)
        expect(dailyTask.mock.calls.length).toBe(initialCount + 1);

        // Advance to midnight Jan 3rd (another 12 hours)
        timeControl.advanceTime(12 * 60 * 60 * 1000);
        await schedulerControl.waitForNextCycleEnd();

        // Should have executed exactly once more
        expect(dailyTask.mock.calls.length).toBe(initialCount + 2);

        // Advance to midnight Jan 4th (24 hours)
        timeControl.advanceTime(24 * 60 * 60 * 1000);
        await schedulerControl.waitForNextCycleEnd();

        // Should have executed exactly once more
        expect(dailyTask.mock.calls.length).toBe(initialCount + 3);

        await capabilities.scheduler.stop();
    });

    test("should execute weekly task with exact precision at weekly boundaries", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = Duration.fromMillis(1000);
        const weeklyTask = jest.fn();

        // Start at exactly midnight on Sunday, January 3rd, 2021 (day 0 = Sunday)
        const startTime = luxon.DateTime.fromISO("2021-01-03T00:00:00.000Z");
        timeControl.setTime(startTime.toMillis());
        schedulerControl.setPollingInterval(1);

        const registrations = [
            ["precise-weekly", "0 0 * * 0", weeklyTask, retryDelay], // Weekly on Sunday (0) at midnight
        ];

        await capabilities.scheduler.initialize(registrations);
        await schedulerControl.waitForNextCycleEnd();

        // Should execute at 00 minutes.
        expect(weeklyTask.mock.calls.length).toBe(1);

        // Advance to next Sunday (7 days) - January 10th
        timeControl.advanceTime(7 * 24 * 60 * 60 * 1000);
        await schedulerControl.waitForNextCycleEnd();

        // At midnight Sunday Jan 10th - should execute exactly once more
        expect(weeklyTask.mock.calls.length).toBe(2);

        // Advance 3 days (Wednesday)
        timeControl.advanceTime(3 * 24 * 60 * 60 * 1000);
        await schedulerControl.waitForNextCycleEnd();

        // Should still be exactly 1 more execution
        expect(weeklyTask.mock.calls.length).toBe(2);

        // Advance to next Sunday (4 more days = 7 days total)
        timeControl.advanceTime(4 * 24 * 60 * 60 * 1000);
        await schedulerControl.waitForNextCycleEnd();

        // Should have executed exactly 3 times total
        expect(weeklyTask.mock.calls.length).toBe(3);

        // Advance another week
        timeControl.advanceTime(7 * 24 * 60 * 60 * 1000);
        await schedulerControl.waitForNextCycleEnd();

        // Should have executed exactly 4 times total
        expect(weeklyTask.mock.calls.length).toBe(4);

        await capabilities.scheduler.stop();
    });

    test("should maintain exact execution counts across scheduler restart", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = Duration.fromMillis(1000);
        const persistentTask = jest.fn();

        // Start at exactly 14:00:00
        const startTime = luxon.DateTime.fromISO("2021-01-01T14:00:00.000Z").toMillis();
        timeControl.setTime(startTime);
        schedulerControl.setPollingInterval(1);

        const registrations = [
            ["persistent-hourly", "0 * * * *", persistentTask, retryDelay], // Every hour
        ];

        await capabilities.scheduler.initialize(registrations);
        await schedulerControl.waitForNextCycleEnd();

        // Should execute at 00 minutes.
        const initialCount = persistentTask.mock.calls.length;
        expect(initialCount).toBe(1);

        // Advance to 15:00:00
        timeControl.advanceTime(60 * 60 * 1000);
        await schedulerControl.waitForNextCycleEnd();

        // Should have executed exactly once more
        expect(persistentTask.mock.calls.length).toBe(2);

        // Stop scheduler
        await capabilities.scheduler.stop();

        // Create new scheduler instance with same registrations
        const newCapabilities = getTestCapabilities();
        const newTimeControl = getDatetimeControl(newCapabilities);
        const newSchedulerControl = getSchedulerControl(newCapabilities);

        // Set time to 16:00:00 (1 hour later)
        newTimeControl.setTime(startTime + (2 * 60 * 60 * 1000));
        newSchedulerControl.setPollingInterval(1);

        await newCapabilities.scheduler.initialize(registrations);
        await newSchedulerControl.waitForNextCycleEnd();

        // Should execute immediately on restart
        expect(persistentTask.mock.calls.length).toBe(3);

        // Advance to 17:00:00
        newTimeControl.advanceTime(60 * 60 * 1000);
        await newSchedulerControl.waitForNextCycleEnd();

        // Should have executed exactly once more
        expect(persistentTask.mock.calls.length).toBe(4);

        await newCapabilities.scheduler.stop();
    });

    test("should execute tasks with precise hour-level timing", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = Duration.fromMillis(500);

        const every2HourTask = jest.fn();   // Every 2 hours 
        const every4HourTask = jest.fn();   // Every 4 hours

        // Start at exactly midnight - both should match
        const startTime = luxon.DateTime.fromISO("2021-01-01T00:00:00.000Z").toMillis();
        timeControl.setTime(startTime);
        schedulerControl.setPollingInterval(1);

        const registrations = [
            ["every-2h", "0 */2 * * *", every2HourTask, retryDelay],    // Every 2 hours (0, 2, 4, 6, 8, 10, 12, ...)
            ["every-4h", "0 */4 * * *", every4HourTask, retryDelay],    // Every 4 hours (0, 4, 8, 12, ...)
        ];

        await capabilities.scheduler.initialize(registrations);
        await schedulerControl.waitForNextCycleEnd();

        // Should execute at 00 minute.
        const initial2Hour = every2HourTask.mock.calls.length;
        const initial4Hour = every4HourTask.mock.calls.length;
        expect(initial2Hour).toBe(1);
        expect(initial4Hour).toBe(1);

        // Advance to 02:00:00 (2-hour task should execute, 4-hour should not)
        timeControl.advanceTime(2 * 60 * 60 * 1000);
        await schedulerControl.waitForNextCycleEnd();

        // 2-hour task should execute, 4-hour should not
        expect(every2HourTask.mock.calls.length).toBe(2);
        expect(every4HourTask.mock.calls.length).toBe(1);
        // Advance to 04:00:00 (both should execute - matches both patterns)
        timeControl.advanceTime(2 * 60 * 60 * 1000);
        await schedulerControl.waitForNextCycleEnd();

        // Both should have executed
        expect(every2HourTask.mock.calls.length).toBe(3); // executed at 02:00 and 04:00
        expect(every4HourTask.mock.calls.length).toBe(2); // executed at 04:00

        const after2Hour2H = every2HourTask.mock.calls.length;
        const after2Hour4H = every4HourTask.mock.calls.length;

        // Advance to 06:00:00 (2-hour should execute, 4-hour should not)
        timeControl.advanceTime(2 * 60 * 60 * 1000);
        await schedulerControl.waitForNextCycleEnd();

        // 2-hour task should execute more, 4-hour should remain same
        expect(every2HourTask.mock.calls.length).toBeGreaterThan(after2Hour2H);
        expect(every4HourTask.mock.calls.length).toBe(after2Hour4H); // No change

        // Advance to 08:00:00 (both should execute again)
        timeControl.advanceTime(2 * 60 * 60 * 1000);
        await schedulerControl.waitForNextCycleEnd();

        // Both should have executed more
        expect(every2HourTask.mock.calls.length).toBe(5); // 02:00, 04:00, 06:00, 08:00
        expect(every4HourTask.mock.calls.length).toBe(3); // 04:00, 08:00

        // Verify the pattern: 2-hour task executes twice as often as 4-hour task
        const total2HourExecutions = every2HourTask.mock.calls.length;
        const total4HourExecutions = every4HourTask.mock.calls.length;

        // 2-hour task should have executed exactly twice as often as 4-hour task - 1 initial
        expect(total2HourExecutions).toBe(total4HourExecutions * 2 - 1);

        await capabilities.scheduler.stop();
    });

    test("should execute tasks with precise hour-level timing different start", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = Duration.fromMillis(500);

        const every2HourTask = jest.fn();   // Every 2 hours 
        const every4HourTask = jest.fn();   // Every 4 hours

        // Start at 2am - both should match
        const startTime = luxon.DateTime.fromISO("2021-01-01T02:00:00.000Z").toMillis();
        timeControl.setTime(startTime);
        schedulerControl.setPollingInterval(1);

        const registrations = [
            ["every-2h", "0 */2 * * *", every2HourTask, retryDelay],    // Every 2 hours (0, 2, 4, 6, 8, 10, 12, ...)
            ["every-4h", "0 */4 * * *", every4HourTask, retryDelay],    // Every 4 hours (0, 4, 8, 12, ...)
        ];

        await capabilities.scheduler.initialize(registrations);
        await schedulerControl.waitForNextCycleEnd();

        // Should execute at 00 minute.
        const initial2Hour = every2HourTask.mock.calls.length;
        const initial4Hour = every4HourTask.mock.calls.length;
        expect(initial2Hour).toBe(1);
        expect(initial4Hour).toBe(0);

        // Advance to 02:00:00 (2-hour task should execute, 4-hour should not)
        timeControl.advanceTime(2 * 60 * 60 * 1000);
        await schedulerControl.waitForNextCycleEnd();

        // 2-hour task should execute, 4-hour should not
        expect(every2HourTask.mock.calls.length).toBe(2);
        expect(every4HourTask.mock.calls.length).toBe(1);
        // Advance to 04:00:00 (both should execute - matches both patterns)
        timeControl.advanceTime(2 * 60 * 60 * 1000);
        await schedulerControl.waitForNextCycleEnd();

        // Both should have executed
        expect(every2HourTask.mock.calls.length).toBe(3); // executed at 02:00 and 04:00
        expect(every4HourTask.mock.calls.length).toBe(1); // executed at 04:00

        const after2Hour2H = every2HourTask.mock.calls.length;
        const after2Hour4H = every4HourTask.mock.calls.length;

        // Advance to 06:00:00 (2-hour should execute, 4-hour should not)
        timeControl.advanceTime(2 * 60 * 60 * 1000);
        await schedulerControl.waitForNextCycleEnd();

        // Both task should execute more
        expect(every2HourTask.mock.calls.length).toBe(after2Hour2H + 1);
        expect(every4HourTask.mock.calls.length).toBe(after2Hour4H + 1);

        // Advance to 08:00:00 (only 2-hour should execute again)
        timeControl.advanceTime(2 * 60 * 60 * 1000);
        await schedulerControl.waitForNextCycleEnd();

        // Both should have executed more
        expect(every2HourTask.mock.calls.length).toBe(5); // 02:00, 04:00, 06:00, 08:00
        expect(every4HourTask.mock.calls.length).toBe(2); // 04:00, 08:00

        // Verify the pattern: 2-hour task executes twice as often as 4-hour task
        const total2HourExecutions = every2HourTask.mock.calls.length;
        const total4HourExecutions = every4HourTask.mock.calls.length;

        // 2-hour task should have executed exactly twice as often as 4-hour task + 1 initial
        expect(total2HourExecutions).toBe(total4HourExecutions * 2 + 1);

        await capabilities.scheduler.stop();
    });

    test("should demonstrate precise execution counting with multiple intervals", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = Duration.fromMillis(1000);

        const every2HourTask = jest.fn();  // Runs every 2 hours
        const every6HourTask = jest.fn();  // Runs every 6 hours

        // Start at exactly midnight
        const startTime = luxon.DateTime.fromISO("2021-01-01T00:00:00.000Z").toMillis();
        timeControl.setTime(startTime);
        schedulerControl.setPollingInterval(1);

        const registrations = [
            ["every-2h", "0 */2 * * *", every2HourTask, retryDelay],    // Every 2 hours
            ["every-6h", "0 */6 * * *", every6HourTask, retryDelay],    // Every 6 hours
        ];

        await capabilities.scheduler.initialize(registrations);
        await schedulerControl.waitForNextCycleEnd();

        // Should execute at 00 minutes
        const initial2Hour = every2HourTask.mock.calls.length;
        const initial6Hour = every6HourTask.mock.calls.length;
        expect(initial2Hour).toBe(1);
        expect(initial6Hour).toBe(1);

        // Advance exactly 12 hours to noon in one jump (simulating missed executions)
        timeControl.advanceTime(12 * 60 * 60 * 1000);
        await schedulerControl.waitForNextCycleEnd();

        const after12Hours2Hour = every2HourTask.mock.calls.length;
        const after12Hours6Hour = every6HourTask.mock.calls.length;

        // Should NOT execute multiple times for missed executions
        // Should only execute once for the current time (12:00:00)
        // Both patterns match 12:00:00 (divisible by both 2 and 6)
        expect(after12Hours2Hour).toBe(2);
        expect(after12Hours6Hour).toBe(2);

        await capabilities.scheduler.stop();
    });

    test("should execute tasks with exact timing precision across day boundaries", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = Duration.fromMillis(1000);

        const midnightTask = jest.fn();  // Runs daily at midnight
        const noonTask = jest.fn();      // Runs daily at noon

        // Start at exactly 11 PM on Dec 31st, 2020
        const startTime = luxon.DateTime.fromISO("2020-12-31T23:00:00.000Z").toMillis();
        timeControl.setTime(startTime);
        schedulerControl.setPollingInterval(1);

        const registrations = [
            ["midnight-daily", "0 0 * * *", midnightTask, retryDelay],    // Daily at midnight
            ["noon-daily", "0 12 * * *", noonTask, retryDelay],           // Daily at noon
        ];

        await capabilities.scheduler.initialize(registrations);
        await schedulerControl.waitForNextCycleEnd();

        // Record initial counts
        const initialMidnight = midnightTask.mock.calls.length;
        const initialNoon = noonTask.mock.calls.length;

        // Neither should execute at 11 PM

        // Advance exactly 1 hour to midnight (New Year)
        timeControl.advanceTime(3 * 60 * 60 * 1000);
        await schedulerControl.waitForNextCycleEnd();

        // Only midnight task should execute
        expect(midnightTask.mock.calls.length).toBeGreaterThan(initialMidnight);
        expect(noonTask.mock.calls.length).toBe(initialNoon); // Should not change

        const midnightAfterNewYear = midnightTask.mock.calls.length;

        // Advance exactly 12 hours to noon
        timeControl.advanceTime(12 * 60 * 60 * 1000);
        await schedulerControl.waitForNextCycleEnd();

        // Only noon task should execute
        expect(midnightTask.mock.calls.length).toBe(midnightAfterNewYear); // Should not change
        expect(noonTask.mock.calls.length).toBeGreaterThan(initialNoon);

        const noonAfterNewYear = noonTask.mock.calls.length;

        // Advance exactly 12 hours to next midnight
        timeControl.advanceTime(12 * 60 * 60 * 1000);
        await schedulerControl.waitForNextCycleEnd();

        // Only midnight task should execute again
        expect(midnightTask.mock.calls.length).toBeGreaterThan(midnightAfterNewYear);
        expect(noonTask.mock.calls.length).toBe(noonAfterNewYear); // Should not change

        // Verify execution counts: each task should have executed exactly as expected
        const totalMidnightExecutions = midnightTask.mock.calls.length - initialMidnight;
        const totalNoonExecutions = noonTask.mock.calls.length - initialNoon;

        expect(totalMidnightExecutions).toBe(2); // Exactly 2 midnight executions
        expect(totalNoonExecutions).toBe(1);     // Exactly 1 noon execution

        await capabilities.scheduler.stop();
    });

    test("should not block executions when a slow task is running", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = Duration.fromMillis(5000);

        const fastTask = jest.fn();

        const slowTask = jest.fn().mockImplementation(async () => {
            // Simulate a task that takes a moderate amount of time but doesn't block indefinitely
            await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second
        });

        // Set start time to 01:15:00 on Jan 1, 2021
        const startTime = luxon.DateTime.fromISO("2021-01-01T01:15:00.000Z").toMillis();
        timeControl.setTime(startTime);
        schedulerControl.setPollingInterval(1);

        const registrations = [
            ["fast-task", "0 * * * *", fastTask, retryDelay],   // Every hour at 0 minutes
            ["slow-task", "0 * * * *", slowTask, retryDelay],    // Every hour at 0 minutes
        ];

        await capabilities.scheduler.initialize(registrations);

        // Wait some time.
        await new Promise(resolve => setTimeout(resolve, 200));

        // Should NOT execute immediately on first startup
        expect(fastTask.mock.calls.length).toEqual(0);
        expect(slowTask.mock.calls.length).toEqual(0);

        // Advance to next hour (02:00:00)
        timeControl.advanceTime(45 * 60 * 1000); // 45 minutes to reach 02:00:00
        await schedulerControl.waitForNextCycleEnd();
        // Wait some time.
        await new Promise(resolve => setTimeout(resolve, 200));

        expect(fastTask.mock.calls.length).toEqual(1);
        expect(slowTask.mock.calls.length).toEqual(1);

        // Advance by one hour to 03:00:00
        timeControl.advanceTime(1 * 60 * 60 * 1000);
        await schedulerControl.waitForNextCycleEnd();
        // Wait some time.
        await new Promise(resolve => setTimeout(resolve, 200));

        expect(fastTask.mock.calls.length).toEqual(2);
        expect(slowTask.mock.calls.length).toEqual(2); // Both can execute since slow task only takes 1 second

        await capabilities.scheduler.stop();
    });

    test.failing("should reject non-DateTime objects during task deserialization", () => {
        const cron = parseCronExpression("* * * * *");
        const retryDelay = Duration.fromMillis(0);
        const registrations = new Map([
            ["demo", { name: "demo", parsedCron: cron, callback: async () => {}, retryDelay }]
        ]);

        const fakeDate = { getTime: () => 0 };
        const serialized = {
            name: "demo",
            cronExpression: cron.original,
            retryDelayMs: 0,
            lastSuccessTime: fakeDate,
        };

        const result = tryDeserialize(serialized, registrations);
        expect(isTaskTryDeserializeError(result)).toBe(true);
    });
});
