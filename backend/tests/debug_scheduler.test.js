/**
 * Debug test to understand the scheduler issue
 */

const { parseCronExpression } = require("../src/scheduler/expression");
const { getMostRecentExecution } = require("../src/scheduler/calculator");
const { stubDatetime, getDatetimeControl, stubEnvironment, stubLogger, stubSleeper, stubRuntimeStateStorage, stubScheduler, getSchedulerControl } = require("./stubs");
const { getMockedRootCapabilities } = require("./spies");
const { Duration } = require("luxon");

describe("scheduler debug", () => {
    test("debug getMostRecentExecution behavior", () => {
        const capabilities = getMockedRootCapabilities();
        stubDatetime(capabilities);
        const timeControl = getDatetimeControl(capabilities);
        const dt = capabilities.datetime;

        // Test the 2-hour cron expression
        const cronExpr = parseCronExpression("0 */2 * * *");
        console.log("Parsed cron:", cronExpr);

        // Start at midnight
        const startTime = new Date("2021-01-01T00:00:00.000Z").getTime();
        timeControl.setTime(startTime);
        
        let now = dt.now();
        console.log("Start time:", dt.toNativeDate(now));

        // Check if it should execute at start
        let result = getMostRecentExecution(cronExpr, now, dt, undefined);
        console.log("At start - lastScheduledFire:", result.lastScheduledFire ? dt.toNativeDate(result.lastScheduledFire) : null);

        // Advance 2 hours to 02:00:00
        timeControl.advanceTime(2 * 60 * 60 * 1000);
        now = dt.now();
        console.log("After 2 hours - current time:", dt.toNativeDate(now));
        
        result = getMostRecentExecution(cronExpr, now, dt, result.newLastEvaluatedFire);
        console.log("After 2 hours - lastScheduledFire:", result.lastScheduledFire ? dt.toNativeDate(result.lastScheduledFire) : null);

        // Advance 1 more hour to 03:00:00 
        timeControl.advanceTime(1 * 60 * 60 * 1000);
        now = dt.now();
        console.log("After 3 hours - current time:", dt.toNativeDate(now));
        
        result = getMostRecentExecution(cronExpr, now, dt, result.newLastEvaluatedFire);
        console.log("After 3 hours - lastScheduledFire:", result.lastScheduledFire ? dt.toNativeDate(result.lastScheduledFire) : null);
    });

    test("debug task execution evaluation logic", () => {
        const capabilities = getMockedRootCapabilities();
        stubDatetime(capabilities);
        const timeControl = getDatetimeControl(capabilities);
        const dt = capabilities.datetime;

        // Test the 2-hour cron expression
        const cronExpr = parseCronExpression("0 */2 * * *");
        
        // Simulate a task
        const task = {
            parsedCron: cronExpr,
            lastAttemptTime: undefined,
            lastEvaluatedFire: undefined,
            pendingRetryUntil: undefined,
            callback: jest.fn()
        };

        // Start at midnight
        const startTime = new Date("2021-01-01T00:00:00.000Z").getTime();
        timeControl.setTime(startTime);
        
        let now = dt.now();
        console.log("=== Initial state ===");
        console.log("Current time:", dt.toNativeDate(now));
        console.log("Task lastAttemptTime:", task.lastAttemptTime);

        // Check initial execution logic
        const { lastScheduledFire, newLastEvaluatedFire } = getMostRecentExecution(task.parsedCron, now, dt, task.lastEvaluatedFire);
        task.lastEvaluatedFire = newLastEvaluatedFire;

        const shouldRunCron1 = lastScheduledFire &&
            (!task.lastAttemptTime || task.lastAttemptTime.getTime() < lastScheduledFire.getTime());

        console.log("lastScheduledFire:", lastScheduledFire ? dt.toNativeDate(lastScheduledFire) : null);
        console.log("shouldRunCron:", shouldRunCron1);

        // Simulate executing the task
        if (shouldRunCron1) {
            task.lastAttemptTime = now;
            console.log("Task executed, lastAttemptTime set to:", dt.toNativeDate(task.lastAttemptTime));
        }

        // Advance 2 hours to 02:00:00
        timeControl.advanceTime(2 * 60 * 60 * 1000);
        now = dt.now();
        console.log("=== After 2 hours ===");
        console.log("Current time:", dt.toNativeDate(now));
        console.log("Task lastAttemptTime:", task.lastAttemptTime ? dt.toNativeDate(task.lastAttemptTime) : null);

        const result2 = getMostRecentExecution(task.parsedCron, now, dt, task.lastEvaluatedFire);
        task.lastEvaluatedFire = result2.newLastEvaluatedFire;

        const shouldRunCron2 = result2.lastScheduledFire &&
            (!task.lastAttemptTime || task.lastAttemptTime.getTime() < result2.lastScheduledFire.getTime());

        console.log("lastScheduledFire:", result2.lastScheduledFire ? dt.toNativeDate(result2.lastScheduledFire) : null);
        console.log("shouldRunCron:", shouldRunCron2);
        
        if (shouldRunCron2) {
            task.lastAttemptTime = now;
            console.log("Task executed, lastAttemptTime set to:", dt.toNativeDate(task.lastAttemptTime));
        }

        // Advance 1 more hour to 03:00:00 
        timeControl.advanceTime(1 * 60 * 60 * 1000);
        now = dt.now();
        console.log("=== After 3 hours total ===");
        console.log("Current time:", dt.toNativeDate(now));
        console.log("Task lastAttemptTime:", task.lastAttemptTime ? dt.toNativeDate(task.lastAttemptTime) : null);

        const result3 = getMostRecentExecution(task.parsedCron, now, dt, task.lastEvaluatedFire);
        
        const shouldRunCron3 = result3.lastScheduledFire &&
            (!task.lastAttemptTime || task.lastAttemptTime.getTime() < result3.lastScheduledFire.getTime());

        console.log("lastScheduledFire:", result3.lastScheduledFire ? dt.toNativeDate(result3.lastScheduledFire) : null);
        console.log("shouldRunCron:", shouldRunCron3);
    });

    test("debug full scheduler execution flow", async () => {
        const capabilities = getMockedRootCapabilities();
        stubEnvironment(capabilities);
        stubLogger(capabilities);
        stubDatetime(capabilities);
        stubSleeper(capabilities);
        stubRuntimeStateStorage(capabilities);
        stubScheduler(capabilities);
        
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = Duration.fromMillis(500);

        const every2HourTask = jest.fn();
        const every4HourTask = jest.fn();

        // Start at exactly midnight
        const startTime = new Date("2021-01-01T00:00:00.000Z").getTime();
        timeControl.setTime(startTime);
        schedulerControl.setPollingInterval(1);

        const registrations = [
            ["every-2h", "0 */2 * * *", every2HourTask, retryDelay],
            ["every-4h", "0 */4 * * *", every4HourTask, retryDelay],
        ];

        console.log("=== Initializing scheduler ===");
        await capabilities.scheduler.initialize(registrations);
        await schedulerControl.waitForNextCycleEnd();

        const initial2Hour = every2HourTask.mock.calls.length;
        const initial4Hour = every4HourTask.mock.calls.length;

        console.log("Initial 2-hour task calls:", initial2Hour);
        console.log("Initial 4-hour task calls:", initial4Hour);

        // Advance to 02:00:00 (2-hour task should execute)
        console.log("=== Advancing to 02:00:00 ===");
        timeControl.advanceTime(2 * 60 * 60 * 1000);
        await schedulerControl.waitForNextCycleEnd();
        await schedulerControl.waitForNextCycleEnd();

        const after2Hours_2Hour = every2HourTask.mock.calls.length;
        const after2Hours_4Hour = every4HourTask.mock.calls.length;

        console.log("After 2 hours - 2-hour task calls:", after2Hours_2Hour);
        console.log("After 2 hours - 4-hour task calls:", after2Hours_4Hour);

        // Advance to 03:00:00 (no new executions expected)
        console.log("=== Advancing to 03:00:00 ===");
        timeControl.advanceTime(1 * 60 * 60 * 1000);
        await schedulerControl.waitForNextCycleEnd();
        await schedulerControl.waitForNextCycleEnd();

        const after3Hours_2Hour = every2HourTask.mock.calls.length;
        const after3Hours_4Hour = every4HourTask.mock.calls.length;

        console.log("After 3 hours - 2-hour task calls:", after3Hours_2Hour);
        console.log("After 3 hours - 4-hour task calls:", after3Hours_4Hour);

        // Advance to 04:00:00 (both should execute)
        console.log("=== Advancing to 04:00:00 ===");
        timeControl.advanceTime(1 * 60 * 60 * 1000);
        await schedulerControl.waitForNextCycleEnd();
        await schedulerControl.waitForNextCycleEnd();

        const after4Hours_2Hour = every2HourTask.mock.calls.length;
        const after4Hours_4Hour = every4HourTask.mock.calls.length;

        console.log("After 4 hours - 2-hour task calls:", after4Hours_2Hour);
        console.log("After 4 hours - 4-hour task calls:", after4Hours_4Hour);

        await capabilities.scheduler.stop();
    });

    test("debug lastAttemptTime timing issue", () => {
        const capabilities = getMockedRootCapabilities();
        stubDatetime(capabilities);
        const timeControl = getDatetimeControl(capabilities);
        const dt = capabilities.datetime;

        // Test the 2-hour cron expression
        const cronExpr = parseCronExpression("0 */2 * * *");
        
        // Simulate a task
        const task = {
            parsedCron: cronExpr,
            lastAttemptTime: undefined,
            lastEvaluatedFire: undefined,
            pendingRetryUntil: undefined,
            callback: jest.fn()
        };

        // Start at midnight
        const startTime = new Date("2021-01-01T00:00:00.000Z").getTime();
        timeControl.setTime(startTime);
        
        let now = dt.now();
        console.log("=== At midnight (00:00:00) ===");
        console.log("Current time:", dt.toNativeDate(now));

        // Execute the task (simulate what should happen)
        const { lastScheduledFire } = getMostRecentExecution(task.parsedCron, now, dt, task.lastEvaluatedFire);
        
        // The issue: we set lastAttemptTime to 'now', but should it be 'lastScheduledFire'?
        task.lastAttemptTime = now; // Current code
        console.log("lastScheduledFire:", lastScheduledFire ? dt.toNativeDate(lastScheduledFire) : null);
        console.log("task.lastAttemptTime set to 'now':", dt.toNativeDate(task.lastAttemptTime));

        // Advance to 02:00:00
        timeControl.advanceTime(2 * 60 * 60 * 1000);
        now = dt.now();
        console.log("=== At 02:00:00 ===");
        console.log("Current time:", dt.toNativeDate(now));

        const result2 = getMostRecentExecution(task.parsedCron, now, dt, task.lastEvaluatedFire);
        console.log("lastScheduledFire:", result2.lastScheduledFire ? dt.toNativeDate(result2.lastScheduledFire) : null);
        console.log("task.lastAttemptTime:", dt.toNativeDate(task.lastAttemptTime));
        
        const shouldRunCronCurrent = result2.lastScheduledFire &&
            (!task.lastAttemptTime || task.lastAttemptTime.getTime() < result2.lastScheduledFire.getTime());
        console.log("shouldRunCron (current logic):", shouldRunCronCurrent);
        
        // Compare with alternative: what if lastAttemptTime was set to lastScheduledFire?
        const taskAlt = {
            parsedCron: cronExpr,
            lastAttemptTime: lastScheduledFire, // Alternative: set to scheduled fire time
            lastEvaluatedFire: undefined,
            pendingRetryUntil: undefined,
            callback: jest.fn()
        };
        
        const shouldRunCronAlt = result2.lastScheduledFire &&
            (!taskAlt.lastAttemptTime || taskAlt.lastAttemptTime.getTime() < result2.lastScheduledFire.getTime());
        console.log("Alternative: taskAlt.lastAttemptTime set to lastScheduledFire:", taskAlt.lastAttemptTime ? dt.toNativeDate(taskAlt.lastAttemptTime) : null);
        console.log("shouldRunCron (alternative logic):", shouldRunCronAlt);
    });
});