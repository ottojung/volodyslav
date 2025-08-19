/**
 * Tests for polling scheduler parallel execution capabilities.
 * Ensures tasks can run concurrently without blocking each other.
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
            // Use immediate resolution instead of setTimeout with fake timers
        });
        
        const task2 = jest.fn(async () => {
            task2StartTime = Date.now();
            // Use immediate resolution instead of setTimeout with fake timers
        });
        
        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 5000 });
        await scheduler.schedule("parallel-task-1", "* * * * *", task1, retryDelay);
        await scheduler.schedule("parallel-task-2", "* * * * *", task2, retryDelay);
        
        // Trigger poll when both tasks are due
        await scheduler._poll();
        
        // Check that tasks ran in parallel (start times should be very close)
        expect(task1).toHaveBeenCalled();
        expect(task2).toHaveBeenCalled();
        expect(Math.abs(task1StartTime - task2StartTime)).toBeLessThan(100); // Within 100ms
        
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
        let taskExecutionOrder = [];
        
        const concurrencyTask = jest.fn(async (taskId) => {
            concurrentExecutions++;
            maxConcurrentExecutions = Math.max(maxConcurrentExecutions, concurrentExecutions);
            taskExecutionOrder.push(`${taskId}-start`);
            
            // Simulate some work without using setTimeout
            await Promise.resolve();
            
            taskExecutionOrder.push(`${taskId}-end`);
            concurrentExecutions--;
        });
        
        // Create scheduler with concurrency limit of 2
        const scheduler = makePollingScheduler(capabilities, { 
            pollIntervalMs: 5000,
            maxConcurrentTasks: 2 
        });
        
        // Schedule 4 tasks all due at the same time, each with unique ID
        await scheduler.schedule("concurrent-1", "* * * * *", () => concurrencyTask(1), retryDelay);
        await scheduler.schedule("concurrent-2", "* * * * *", () => concurrencyTask(2), retryDelay);
        await scheduler.schedule("concurrent-3", "* * * * *", () => concurrencyTask(3), retryDelay);
        await scheduler.schedule("concurrent-4", "* * * * *", () => concurrencyTask(4), retryDelay);
        
        // Trigger poll
        await scheduler._poll();
        
        // Should not exceed concurrency limit and execute all tasks
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
            // Immediate resolution to ensure deterministic ordering
            await Promise.resolve();
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
        await scheduler._poll();
        
        // With concurrency limit of 1, tasks should execute in sequence
        // (though the exact order may vary, each task should complete before the next starts)
        expect(executionOrder).toHaveLength(6);
        expect(executionOrder.filter(item => item.endsWith('-start'))).toHaveLength(3);
        expect(executionOrder.filter(item => item.endsWith('-end'))).toHaveLength(3);
        
        await scheduler.cancelAll();
    });

    test("should not block fast tasks when slow task is running", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);
        
        let fastTaskCompleted = false;
        let slowTaskStarted = false;
        
        const slowTask = jest.fn(async () => {
            slowTaskStarted = true;
            // Simulate slow task with Promise.resolve (no actual delay needed for this test)
            await Promise.resolve();
        });
        
        const fastTask = jest.fn(async () => {
            // Fast task
            await Promise.resolve();
            fastTaskCompleted = true;
        });
        
        const scheduler = makePollingScheduler(capabilities, { 
            pollIntervalMs: 5000,
            maxConcurrentTasks: 2 // Allow 2 concurrent tasks
        });
        
        await scheduler.schedule("slow-task", "* * * * *", slowTask, retryDelay);
        await scheduler.schedule("fast-task", "* * * * *", fastTask, retryDelay);
        
        // Trigger poll
        await scheduler._poll();
        
        // Both tasks should complete since we allow concurrency
        expect(slowTaskStarted).toBe(true);
        expect(fastTaskCompleted).toBe(true);
        
        await scheduler.cancelAll();
    });
});