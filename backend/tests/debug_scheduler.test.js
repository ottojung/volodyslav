/**
 * Debug test to understand the scheduler issue
 */

const { parseCronExpression } = require("../src/scheduler/expression");
const { getMostRecentExecution } = require("../src/scheduler/calculator");
const { stubDatetime, getDatetimeControl } = require("./stubs");
const { getMockedRootCapabilities } = require("./spies");

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
});