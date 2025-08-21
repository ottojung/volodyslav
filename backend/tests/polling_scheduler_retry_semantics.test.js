/**
 * Tests for polling scheduler retry semantics.
 * Ensures cron schedule is not superseded by retry logic.
 */

const { makePollingScheduler } = require("../src/cron/polling_scheduler");
const { fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubGit } = require("./stubs");

function caps() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubGit(capabilities);
    return capabilities;
}

describe("polling scheduler retry semantics", () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date("2020-01-01T00:00:00Z"));
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test("should respect cron schedule even during retry period", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5 * 60 * 1000); // 5 minutes
        let executionCount = 0;
        let executionModes = [];
        
        const task = jest.fn(() => {
            executionCount++;
            executionModes.push(`execution-${executionCount}`);
            if (executionCount === 1) {
                throw new Error("First execution fails");
            }
        });
        
        // Task runs every minute
        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 30000 }); // 30s poll
        await scheduler.schedule("retry-test", "* * * * *", task, retryDelay);
        
        // First execution at 00:00 - fails
        await scheduler._poll();
        expect(executionCount).toBe(1);
        
        // Advance to the next minute and trigger another poll
        jest.setSystemTime(new Date("2020-01-01T00:01:00Z"));
        
        // Second poll at 00:01 - should execute again due to cron schedule
        await scheduler._poll();
        
        expect(executionCount).toBe(2); // Should execute again due to cron schedule
        
        const tasks = await scheduler.getTasks();
        expect(tasks[0].lastSuccessTime).toBeDefined(); // Second execution should succeed
        
        await scheduler.cancelAll();
    });

    test("should choose earlier time between cron and retry", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(3 * 60 * 1000); // 3 minutes
        let executionTimes = [];
        
        const task = jest.fn(() => {
            executionTimes.push(new Date().toISOString());
            throw new Error("Always fails for this test");
        });
        
        // Task runs every 2 minutes
        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 30000 });
        await scheduler.schedule("timing-test", "*/2 * * * *", task, retryDelay);
        
        // First execution at 00:00 - fails, retry scheduled for 00:03
        await scheduler._poll();
        expect(executionTimes).toHaveLength(1);
        
        // At 00:02, cron schedule should trigger before retry at 00:03
        jest.setSystemTime(new Date("2020-01-01T00:02:00Z"));
        await scheduler._poll();
        
        expect(executionTimes).toHaveLength(2);
        expect(executionTimes[1]).toBe("2020-01-01T00:02:00.000Z");
        
        await scheduler.cancelAll();
    });

    test("should use retry time when it comes before next cron tick", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(30 * 1000); // 30 seconds
        let executionTimes = [];
        
        const task = jest.fn(() => {
            executionTimes.push(new Date().toISOString());
            throw new Error("Always fails for this test");
        });
        
        // Task runs every 5 minutes
        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 15000 }); // 15s poll
        await scheduler.schedule("retry-priority-test", "*/5 * * * *", task, retryDelay);
        
        // First execution at 00:00 - fails, retry scheduled for 00:00:30
        await scheduler._poll();
        expect(executionTimes).toHaveLength(1);
        
        // At 00:00:30, retry should trigger before next cron at 00:05
        jest.setSystemTime(new Date("2020-01-01T00:00:30Z"));
        await scheduler._poll();
        
        expect(executionTimes).toHaveLength(2);
        expect(executionTimes[1]).toBe("2020-01-01T00:00:30.000Z");
        
        await scheduler.cancelAll();
    });

    test("should provide correct modeHint when both cron and retry are applicable", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(10 * 60 * 1000); // 10 minutes
        
        const task = jest.fn(() => {
            throw new Error("Task always fails");
        });
        
        // Task runs every minute
        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 30000 });
        await scheduler.schedule("mode-test", "* * * * *", task, retryDelay);
        
        // First execution fails
        await scheduler._poll();
        
        // At 00:01, both cron and retry could be applicable
        jest.setSystemTime(new Date("2020-01-01T00:01:00Z"));
        
        const tasks = await scheduler.getTasks();
        // Should indicate cron mode since cron comes first
        expect(tasks[0].modeHint).toBe("cron");
        
        await scheduler.cancelAll();
    });

    test("should clear retry state after successful cron execution", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5 * 60 * 1000); // 5 minutes
        let executionCount = 0;
        
        const task = jest.fn(() => {
            executionCount++;
            if (executionCount === 1) {
                throw new Error("First execution fails");
            }
            // Second execution succeeds
        });
        
        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 30000 });
        await scheduler.schedule("clear-retry-test", "* * * * *", task, retryDelay);
        
        // First execution at 00:00 - fails
        await scheduler._poll();
        
        // Second execution at 00:01 - succeeds due to cron
        jest.setSystemTime(new Date("2020-01-01T00:01:00Z"));
        await scheduler._poll();
        
        // Check that retry state is cleared
        const tasks = await scheduler.getTasks();
        expect(tasks[0].pendingRetryUntil).toBeUndefined();
        expect(tasks[0].lastSuccessTime).toBeDefined();
        
        await scheduler.cancelAll();
    });
});