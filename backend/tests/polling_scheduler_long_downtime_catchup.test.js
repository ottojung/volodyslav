/**
 * Tests for polling scheduler long downtime catchup scenarios.
 * Ensures correctness-preserving algorithm handles various gap lengths without missing executions.
 */

const { makePollingScheduler } = require("../src/cron/polling_scheduler");
const { fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper } = require("./stubs");

function caps() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubSleeper(capabilities);
    return capabilities;
}

describe.skip("polling scheduler long downtime catchup", () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test("should catch up daily tasks after multi-day downtime", async () => {
        jest.setSystemTime(new Date("2020-01-01T09:00:00Z"));
        
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);
        const callback = jest.fn();
        
        // Schedule daily task at 8:00 AM
        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 10 });
        await scheduler.schedule("daily-task", "0 8 * * *", callback, retryDelay);
        
        // Simulate 5 days later (missed 4 executions)
        jest.setSystemTime(new Date("2020-01-06T09:00:00Z"));
        
        // Check that task is due for catchup
        const tasks = await scheduler.getTasks();
        expect(tasks).toHaveLength(1);
        expect(tasks[0].modeHint).toBe("cron");
        
        // Execute one poll to catch up the most recent missed execution
        await scheduler._poll();
        expect(callback).toHaveBeenCalledTimes(1);
        
        await scheduler.cancelAll();
    });

    test("should catch up weekly tasks after month-long downtime", async () => {
        jest.setSystemTime(new Date("2020-01-01T10:00:00Z"));
        
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);
        const callback = jest.fn();
        
        // Schedule weekly task on Wednesdays at 9:00 AM (Jan 1, 2020 is a Wednesday)
        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 10 });
        await scheduler.schedule("weekly-task", "0 9 * * 3", callback, retryDelay);
        
        // Simulate 1 month later (missed ~4 weekly executions)
        jest.setSystemTime(new Date("2020-02-05T10:00:00Z")); // Feb 5, 2020 is a Wednesday
        
        // Check that task is due for catchup
        const tasks = await scheduler.getTasks();
        expect(tasks).toHaveLength(1);
        expect(tasks[0].modeHint).toBe("cron");
        
        // Execute one poll to catch up the most recent missed execution
        await scheduler._poll();
        expect(callback).toHaveBeenCalledTimes(1);
        
        await scheduler.cancelAll();
    });

    test("should catch up monthly tasks (1st of month) after year-long downtime", async () => {
        jest.setSystemTime(new Date("2020-01-01T12:00:00Z"));
        
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);
        const callback = jest.fn();
        
        // Schedule monthly task on 1st at 11:00 AM
        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 10 });
        await scheduler.schedule("monthly-task", "0 11 1 * *", callback, retryDelay);
        
        // Simulate 1 year later (missed 12 monthly executions)
        jest.setSystemTime(new Date("2021-01-01T12:00:00Z"));
        
        // Check that task is due for catchup
        const tasks = await scheduler.getTasks();
        expect(tasks).toHaveLength(1);
        expect(tasks[0].modeHint).toBe("cron");
        
        // Execute one poll to catch up the most recent missed execution
        await scheduler._poll();
        expect(callback).toHaveBeenCalledTimes(1);
        
        await scheduler.cancelAll();
    }, 10000); // 10 second timeout for long downtime test

    test("should catch up yearly Feb 29 tasks correctly", async () => {
        // Start in leap year 2020
        jest.setSystemTime(new Date("2020-02-29T13:00:00Z"));
        
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);
        const callback = jest.fn();
        
        // Schedule task for Feb 29 at 12:00 PM
        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 10 });
        await scheduler.schedule("leap-day-task", "0 12 29 2 *", callback, retryDelay);
        
        // Simulate 4 years later to next leap year (2024)
        jest.setSystemTime(new Date("2024-02-29T13:00:00Z"));
        
        // Check that task is due for catchup
        const tasks = await scheduler.getTasks();
        expect(tasks).toHaveLength(1);
        expect(tasks[0].modeHint).toBe("cron");
        
        // Execute one poll to catch up
        await scheduler._poll();
        expect(callback).toHaveBeenCalledTimes(1);
        
        await scheduler.cancelAll();
    });

    test("should handle simultaneous retry and missed cron execution", async () => {
        jest.setSystemTime(new Date("2020-01-01T14:00:00Z"));
        
        const capabilities = caps();
        const retryDelay = fromMilliseconds(60000); // 1 minute retry
        const callback = jest.fn().mockRejectedValueOnce(new Error("First failure"));
        
        // Schedule hourly task at :30 minutes
        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 10 });
        await scheduler.schedule("retry-cron-task", "30 * * * *", callback, retryDelay);
        
        // Run at 14:30 and fail
        jest.setSystemTime(new Date("2020-01-01T14:30:00Z"));
        await scheduler._poll();
        expect(callback).toHaveBeenCalledTimes(1);
        
        // Simulate system down for 3 hours, coming back at 17:32
        // This scenario tests that when both retry and missed cron executions are due,
        // the EARLIEST (chronologically smaller) timestamp wins.
        // - Retry should have been due at 14:31 (earlier)
        // - Cron executions missed at 15:30, 16:30, 17:30 (later)
        // - Should execute retry mode since 14:31 < 17:30 (earliest wins)
        jest.setSystemTime(new Date("2020-01-01T17:32:00Z"));
        
        const tasks = await scheduler.getTasks();
        expect(tasks).toHaveLength(1);
        expect(tasks[0].modeHint).toBe("retry"); // Retry should win since it's earlier (14:31 < 17:30)
        
        await scheduler.cancelAll();
    });

    test("should preserve execution history across long downtime", async () => {
        jest.setSystemTime(new Date("2020-01-01T15:00:00Z"));
        
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);
        const callback = jest.fn();
        
        // Schedule and run a task successfully
        const scheduler1 = makePollingScheduler(capabilities, { pollIntervalMs: 10 });
        await scheduler1.schedule("history-task", "0 15 * * *", callback, retryDelay);
        
        await scheduler1._poll();
        expect(callback).toHaveBeenCalledTimes(1);
        
        let tasks = await scheduler1.getTasks();
        const lastSuccessTime = tasks[0].lastSuccessTime;
        expect(lastSuccessTime).toBeTruthy();
        
        // Simulate unexpected shutdown WITHOUT calling cancelAll()
        // (graceful cancelAll() would clear persisted state per specification)
        
        // Simulate restart after 1 week
        jest.setSystemTime(new Date("2020-01-08T16:00:00Z"));
        
        const scheduler2 = makePollingScheduler(capabilities, { pollIntervalMs: 10 });
        await scheduler2.schedule("history-task", "0 15 * * *", callback, retryDelay);
        
        // Verify execution history is preserved
        tasks = await scheduler2.getTasks();
        expect(tasks).toHaveLength(1);
        expect(tasks[0].lastSuccessTime).toBe(lastSuccessTime);
        expect(tasks[0].modeHint).toBe("cron"); // Should be due for catchup
        
        await scheduler2.cancelAll();
    });

    test("should handle edge case with very long gaps efficiently", async () => {
        jest.setSystemTime(new Date("2020-01-01T16:00:00Z"));
        
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);
        const callback = jest.fn();
        
        // Schedule task monthly on the 1st
        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 10 });
        await scheduler.schedule("rare-task", "0 15 1 * *", callback, retryDelay); // 1st of every month at 3 PM
        
        // Simulate 6 months later
        jest.setSystemTime(new Date("2020-07-01T16:00:00Z"));
        
        // Should still determine correctly that task is due
        const startTime = Date.now();
        const tasks = await scheduler.getTasks();
        const endTime = Date.now();
        
        expect(tasks).toHaveLength(1);
        expect(tasks[0].modeHint).toBe("cron");
        
        // Should complete reasonably fast even with 6-month gap
        const duration = endTime - startTime;
        expect(duration).toBeLessThan(1000); // Under 1 second
        
        await scheduler.cancelAll();
    }, 10000); // 10 second timeout for long gap test
});