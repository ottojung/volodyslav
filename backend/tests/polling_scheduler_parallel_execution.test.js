/**
 * Tests for polling scheduler parallel execution capabilities.
 * Ensures tasks can run concurrently without blocking each other.
 */

const { makePollingScheduler } = require("../src/cron/polling_scheduler");
const { fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime } = require("./stubs");

function caps() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    return capabilities;
}

describe("polling scheduler parallel execution", () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date("2020-01-01T00:00:00Z"));
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test("should execute multiple due tasks in parallel", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);
        
        let task1StartTime = null;
        let task2StartTime = null;
        
        const task1 = jest.fn(async () => {
            task1StartTime = Date.now();
            await new Promise(resolve => setTimeout(resolve, 1000));
        });
        
        const task2 = jest.fn(async () => {
            task2StartTime = Date.now();
            await new Promise(resolve => setTimeout(resolve, 1000));
        });
        
        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 5000 });
        await scheduler.schedule("parallel-task-1", "* * * * *", task1, retryDelay);
        await scheduler.schedule("parallel-task-2", "* * * * *", task2, retryDelay);
        
        // Trigger poll when both tasks are due
        jest.advanceTimersByTime(5000);
        await Promise.resolve();
        
        // Complete the tasks
        jest.advanceTimersByTime(1500);
        await Promise.resolve();
        
        expect(task1).toHaveBeenCalled();
        expect(task2).toHaveBeenCalled();
        
        // Tasks should have started around the same time (parallel execution)
        const startTimeDiff = Math.abs(task1StartTime - task2StartTime);
        expect(startTimeDiff).toBeLessThan(100); // Should start within 100ms of each other
        
        await scheduler.cancelAll();
    });

    test("should respect concurrency limits", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);
        
        let concurrentExecutions = 0;
        let maxConcurrentExecutions = 0;
        
        const concurrencyTask = jest.fn(async () => {
            concurrentExecutions++;
            maxConcurrentExecutions = Math.max(maxConcurrentExecutions, concurrentExecutions);
            await new Promise(resolve => setTimeout(resolve, 500));
            concurrentExecutions--;
        });
        
        // Create scheduler with concurrency limit of 2
        const scheduler = makePollingScheduler(capabilities, { 
            pollIntervalMs: 5000,
            maxConcurrentTasks: 2 
        });
        
        // Schedule 4 tasks all due at the same time
        await scheduler.schedule("concurrent-1", "* * * * *", concurrencyTask, retryDelay);
        await scheduler.schedule("concurrent-2", "* * * * *", concurrencyTask, retryDelay);
        await scheduler.schedule("concurrent-3", "* * * * *", concurrencyTask, retryDelay);
        await scheduler.schedule("concurrent-4", "* * * * *", concurrencyTask, retryDelay);
        
        // Trigger poll
        jest.advanceTimersByTime(5000);
        await Promise.resolve();
        
        // Complete all tasks
        jest.advanceTimersByTime(1000);
        await Promise.resolve();
        
        // Should not exceed concurrency limit
        expect(maxConcurrentExecutions).toBeLessThanOrEqual(2);
        expect(concurrencyTask).toHaveBeenCalledTimes(4);
        
        await scheduler.cancelAll();
    });

    test("should queue tasks when concurrency limit is reached", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);
        
        let executionOrder = [];
        
        const queuedTask = jest.fn(async (taskName) => {
            executionOrder.push(`${taskName}-start`);
            await new Promise(resolve => setTimeout(resolve, 300));
            executionOrder.push(`${taskName}-end`);
        });
        
        const scheduler = makePollingScheduler(capabilities, { 
            pollIntervalMs: 5000,
            maxConcurrentTasks: 1 // Only 1 task at a time
        });
        
        await scheduler.schedule("queued-1", "* * * * *", () => queuedTask("task1"), retryDelay);
        await scheduler.schedule("queued-2", "* * * * *", () => queuedTask("task2"), retryDelay);
        await scheduler.schedule("queued-3", "* * * * *", () => queuedTask("task3"), retryDelay);
        
        // Trigger poll
        jest.advanceTimersByTime(5000);
        await Promise.resolve();
        
        // Complete all tasks
        jest.advanceTimersByTime(1500);
        await Promise.resolve();
        
        // Tasks should execute sequentially due to concurrency limit
        expect(executionOrder).toEqual([
            "task1-start", "task1-end",
            "task2-start", "task2-end", 
            "task3-start", "task3-end"
        ]);
        
        await scheduler.cancelAll();
    });

    test("should not block fast tasks when slow task is running", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);
        
        let fastTaskCompleted = false;
        let slowTaskStarted = false;
        
        const slowTask = jest.fn(async () => {
            slowTaskStarted = true;
            await new Promise(resolve => setTimeout(resolve, 2000));
        });
        
        const fastTask = jest.fn(async () => {
            await new Promise(resolve => setTimeout(resolve, 100));
            fastTaskCompleted = true;
        });
        
        const scheduler = makePollingScheduler(capabilities, { 
            pollIntervalMs: 5000,
            maxConcurrentTasks: 10 // High limit to allow parallel execution
        });
        
        await scheduler.schedule("slow-task", "* * * * *", slowTask, retryDelay);
        await scheduler.schedule("fast-task", "* * * * *", fastTask, retryDelay);
        
        // Trigger poll
        jest.advanceTimersByTime(5000);
        await Promise.resolve();
        
        // Fast task should complete quickly
        jest.advanceTimersByTime(200);
        await Promise.resolve();
        
        expect(slowTaskStarted).toBe(true);
        expect(fastTaskCompleted).toBe(true);
        
        await scheduler.cancelAll();
    });
});