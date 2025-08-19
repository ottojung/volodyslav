/**
 * Tests for skippedConcurrency metric accuracy in polling scheduler.
 * Ensures metric correctly reflects tasks deferred due to concurrency limits.
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

describe("polling scheduler skippedConcurrency metric", () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date("2020-01-01T00:00:00Z"));
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test("should increment skippedConcurrency when dueTasks > maxConcurrentTasks", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);
        
        // Set low concurrency limit
        const scheduler = makePollingScheduler(capabilities, { 
            pollIntervalMs: 60000, 
            maxConcurrentTasks: 2 
        });
        
        const fastTask = jest.fn(); // Fast synchronous task
        
        // Schedule 5 tasks to run at the same time
        await scheduler.schedule("task1", "* * * * *", fastTask, retryDelay);
        await scheduler.schedule("task2", "* * * * *", fastTask, retryDelay);
        await scheduler.schedule("task3", "* * * * *", fastTask, retryDelay);
        await scheduler.schedule("task4", "* * * * *", fastTask, retryDelay);
        await scheduler.schedule("task5", "* * * * *", fastTask, retryDelay);
        
        // Capture logger calls to verify skippedConcurrency metric
        const loggerCalls = [];
        capabilities.logger.logDebug = jest.fn((data, message) => {
            loggerCalls.push({ data, message });
        });
        
        // Move to next minute when all tasks should be due
        jest.setSystemTime(new Date("2020-01-01T00:01:00Z"));
        
        // Poll and verify metrics
        await scheduler._poll();
        
        // Find the PollSummary log
        const pollSummaryLog = loggerCalls.find(call => call.message === "PollSummary");
        expect(pollSummaryLog).toBeTruthy();
        
        // Should have skipped 3 tasks due to concurrency (5 due - 2 concurrent = 3 skipped)
        expect(pollSummaryLog.data.skippedConcurrency).toBe(3);
        expect(pollSummaryLog.data.dueCron).toBe(5);
        
        await scheduler.cancelAll();
    }, 10000);

    test("should not increment skippedConcurrency when all tasks fit within limit", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);
        
        // Set higher concurrency limit
        const scheduler = makePollingScheduler(capabilities, { 
            pollIntervalMs: 60000, 
            maxConcurrentTasks: 10 
        });
        
        const fastTask = jest.fn();
        
        // Schedule 3 tasks (within limit of 10)
        await scheduler.schedule("task1", "* * * * *", fastTask, retryDelay);
        await scheduler.schedule("task2", "* * * * *", fastTask, retryDelay);
        await scheduler.schedule("task3", "* * * * *", fastTask, retryDelay);
        
        // Capture logger calls
        const loggerCalls = [];
        capabilities.logger.logDebug = jest.fn((data, message) => {
            loggerCalls.push({ data, message });
        });
        
        // Move to next minute when all tasks should be due
        jest.setSystemTime(new Date("2020-01-01T00:01:00Z"));
        
        // Poll and verify metrics
        await scheduler._poll();
        
        // Find the PollSummary log
        const pollSummaryLog = loggerCalls.find(call => call.message === "PollSummary");
        expect(pollSummaryLog).toBeTruthy();
        
        // Should have skipped 0 tasks due to concurrency
        expect(pollSummaryLog.data.skippedConcurrency).toBe(0);
        expect(pollSummaryLog.data.dueCron).toBe(3);
        
        await scheduler.cancelAll();
    });

    test("should correctly count mixed retry and cron tasks for concurrency", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);
        
        // Set concurrency limit to 3
        const scheduler = makePollingScheduler(capabilities, { 
            pollIntervalMs: 60000, 
            maxConcurrentTasks: 3 
        });
        
        const taskSuccess = jest.fn();
        const taskFailure = jest.fn().mockRejectedValue(new Error("Task failed"));
        
        // Schedule tasks - some will be in retry mode, some in cron mode
        await scheduler.schedule("cron-task1", "* * * * *", taskSuccess, retryDelay);
        await scheduler.schedule("cron-task2", "* * * * *", taskSuccess, retryDelay);
        await scheduler.schedule("retry-task1", "*/2 * * * *", taskFailure, retryDelay); // Every 2 minutes
        await scheduler.schedule("retry-task2", "*/2 * * * *", taskFailure, retryDelay); // Every 2 minutes
        await scheduler.schedule("cron-task3", "* * * * *", taskSuccess, retryDelay);
        
        // Run retry tasks and let them fail to create retry state
        jest.setSystemTime(new Date("2020-01-01T00:02:00Z"));
        await scheduler._poll();
        
        // Capture logger calls for next poll
        const loggerCalls = [];
        capabilities.logger.logDebug = jest.fn((data, message) => {
            loggerCalls.push({ data, message });
        });
        
        // Move to next minute - now we have mix of cron (3) and retry (2) = 5 total due
        // With limit of 3, should skip 2
        jest.setSystemTime(new Date("2020-01-01T00:03:00Z"));
        await scheduler._poll();
        
        // Find the PollSummary log
        const pollSummaryLog = loggerCalls.find(call => call.message === "PollSummary");
        expect(pollSummaryLog).toBeTruthy();
        
        // Should have total of 5 due tasks (3 cron + 2 retry) with 2 skipped
        expect(pollSummaryLog.data.dueCron).toBe(3);
        expect(pollSummaryLog.data.dueRetry).toBe(2);
        expect(pollSummaryLog.data.skippedConcurrency).toBe(2);
        
        await scheduler.cancelAll();
    });

    test("should reset skippedConcurrency count for each poll", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);
        
        const scheduler = makePollingScheduler(capabilities, { 
            pollIntervalMs: 60000, 
            maxConcurrentTasks: 1 
        });
        
        const fastTask = jest.fn();
        
        // Schedule 3 tasks
        await scheduler.schedule("task1", "* * * * *", fastTask, retryDelay);
        await scheduler.schedule("task2", "* * * * *", fastTask, retryDelay);
        await scheduler.schedule("task3", "* * * * *", fastTask, retryDelay);
        
        // Capture logger calls for first poll
        let loggerCalls = [];
        capabilities.logger.logDebug = jest.fn((data, message) => {
            loggerCalls.push({ data, message });
        });
        
        // First poll with all 3 tasks due
        jest.setSystemTime(new Date("2020-01-01T00:01:00Z"));
        await scheduler._poll();
        
        let pollSummaryLog = loggerCalls.find(call => call.message === "PollSummary");
        expect(pollSummaryLog.data.skippedConcurrency).toBe(2); // 3 due - 1 concurrent = 2 skipped
        
        // Second poll with same tasks (should be due again)
        loggerCalls = [];
        capabilities.logger.logDebug = jest.fn((data, message) => {
            loggerCalls.push({ data, message });
        });
        
        jest.setSystemTime(new Date("2020-01-01T00:02:00Z"));
        await scheduler._poll();
        
        pollSummaryLog = loggerCalls.find(call => call.message === "PollSummary");
        expect(pollSummaryLog.data.skippedConcurrency).toBe(2); // Should be reset and recalculated
        
        await scheduler.cancelAll();
    });

    test("should handle case with no due tasks correctly", async () => {
        const capabilities = caps();
        
        const scheduler = makePollingScheduler(capabilities, { 
            pollIntervalMs: 60000, 
            maxConcurrentTasks: 2 
        });
        
        // Don't schedule any tasks - test empty scheduler
        
        // Capture logger calls
        const loggerCalls = [];
        capabilities.logger.logDebug = jest.fn((data, message) => {
            loggerCalls.push({ data, message });
        });
        
        // Poll when no tasks exist
        await scheduler._poll();
        
        // Find the PollSummary log
        const pollSummaryLog = loggerCalls.find(call => call.message === "PollSummary");
        expect(pollSummaryLog).toBeTruthy();
        
        // Should have 0 skipped due to concurrency since no tasks exist
        expect(pollSummaryLog.data.skippedConcurrency).toBe(0);
        expect(pollSummaryLog.data.dueCron).toBe(0);
        expect(pollSummaryLog.data.dueRetry).toBe(0);
        
        await scheduler.cancelAll();
    });
});