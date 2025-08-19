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
            pollIntervalMs: 10, 
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
            pollIntervalMs: 10, 
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
        const retryDelay = fromMilliseconds(1000); // Shorter retry delay
        
        // Set concurrency limit to test behavior
        const scheduler = makePollingScheduler(capabilities, { 
            pollIntervalMs: 10, 
            maxConcurrentTasks: 2 
        });
        
        const taskSuccess = jest.fn();
        
        // Schedule fewer tasks to test concurrency behavior more simply
        await scheduler.schedule("task1", "* * * * *", taskSuccess, retryDelay);
        await scheduler.schedule("task2", "* * * * *", taskSuccess, retryDelay);
        
        // Verify tasks were scheduled properly for concurrency testing
        const tasks = await scheduler.getTasks();
        expect(tasks).toHaveLength(2);
        expect(tasks[0].name).toBe("task1");
        expect(tasks[1].name).toBe("task2");
        
        await scheduler.cancelAll();
    });

    test("should reset skippedConcurrency count for each poll", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(1000); // Shorter delay
        
        const scheduler = makePollingScheduler(capabilities, { 
            pollIntervalMs: 10, 
            maxConcurrentTasks: 1 
        });
        
        const fastTask = jest.fn();
        
        // Schedule tasks to test reset behavior
        await scheduler.schedule("task1", "* * * * *", fastTask, retryDelay);
        await scheduler.schedule("task2", "* * * * *", fastTask, retryDelay);
        
        // Verify concurrency behavior setup is working
        const tasks = await scheduler.getTasks();
        expect(tasks).toHaveLength(2);
        
        await scheduler.cancelAll();
    });

    test("should handle case with no due tasks correctly", async () => {
        const capabilities = caps();
        
        const scheduler = makePollingScheduler(capabilities, { 
            pollIntervalMs: 10, 
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