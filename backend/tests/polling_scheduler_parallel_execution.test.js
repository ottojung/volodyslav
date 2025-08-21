/**
 * Tests for declarative scheduler parallel execution capabilities.
 * Ensures tasks can run concurrently without blocking each other.
 */

const { fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubSleeper(capabilities);
    return capabilities;
}

describe("declarative scheduler parallel execution", () => {
    // Use real timers for testing actual scheduler behavior
    
    test("should execute multiple due tasks in parallel", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(5000);
        
        let task1StartTime = null;
        let task2StartTime = null;
        
        const task1 = jest.fn(async () => {
            task1StartTime = Date.now();
            // Add a small delay to make parallelism more observable
            await new Promise(resolve => setTimeout(resolve, 50));
        });
        
        const task2 = jest.fn(async () => {
            task2StartTime = Date.now();
            // Add a small delay to make parallelism more observable
            await new Promise(resolve => setTimeout(resolve, 50));
        });
        
        const registrations = [
            ["parallel-task-1", "* * * * *", task1, retryDelay],
            ["parallel-task-2", "* * * * *", task2, retryDelay]
        ];
        
        await capabilities.scheduler.initialize(registrations, { pollIntervalMs: 100 });
        
        // Wait for execution
        await new Promise(resolve => setTimeout(resolve, 200));
        
        // Check that both tasks ran
        expect(task1).toHaveBeenCalled();
        expect(task2).toHaveBeenCalled();
        
        // Tasks should have started around the same time (parallel execution)
        expect(task1StartTime).toBeDefined();
        expect(task2StartTime).toBeDefined();
        const startTimeDiff = Math.abs(task1StartTime - task2StartTime);
        expect(startTimeDiff).toBeLessThan(100); // Should start within 100ms of each other
        
        await capabilities.scheduler.stop();
    });

    test("should execute many tasks in parallel without limits", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(5000);
        
        let concurrentExecutions = 0;
        let maxConcurrentExecutions = 0;
        let taskExecutionOrder = [];
        
        const concurrencyTask = jest.fn(async (taskId) => {
            concurrentExecutions++;
            maxConcurrentExecutions = Math.max(maxConcurrentExecutions, concurrentExecutions);
            taskExecutionOrder.push(`${taskId}-start`);
            
            // Add a small delay to make concurrency more observable
            await new Promise(resolve => setTimeout(resolve, 50));
            
            taskExecutionOrder.push(`${taskId}-end`);
            concurrentExecutions--;
        });
        
        const registrations = [
            ["concurrent-1", "* * * * *", () => concurrencyTask(1), retryDelay],
            ["concurrent-2", "* * * * *", () => concurrencyTask(2), retryDelay],
            ["concurrent-3", "* * * * *", () => concurrencyTask(3), retryDelay],
            ["concurrent-4", "* * * * *", () => concurrencyTask(4), retryDelay]
        ];
        
        await capabilities.scheduler.initialize(registrations, { pollIntervalMs: 100 });
        
        // Wait for execution
        await new Promise(resolve => setTimeout(resolve, 200));
        
        // Should execute all tasks and allow multiple to run concurrently
        expect(concurrencyTask).toHaveBeenCalledTimes(4);
        expect(maxConcurrentExecutions).toBeGreaterThan(1); // Should have some concurrency
        
        await capabilities.scheduler.stop();
    });

    test("should not block fast tasks when slow task is running", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(5000);
        
        let fastTaskCompleted = false;
        let slowTaskStarted = false;
        
        const slowTask = jest.fn(async () => {
            slowTaskStarted = true;
            // Simulate slow task with a longer delay
            await new Promise(resolve => setTimeout(resolve, 100));
        });
        
        const fastTask = jest.fn(async () => {
            // Fast task
            await new Promise(resolve => setTimeout(resolve, 10));
            fastTaskCompleted = true;
        });
        
        const registrations = [
            ["slow-task", "* * * * *", slowTask, retryDelay],
            ["fast-task", "* * * * *", fastTask, retryDelay]
        ];
        
        await capabilities.scheduler.initialize(registrations, { pollIntervalMs: 100 });
        
        // Wait for executions
        await new Promise(resolve => setTimeout(resolve, 200));
        
        // Both tasks should have started and the fast one should complete
        expect(slowTaskStarted).toBe(true);
        expect(fastTaskCompleted).toBe(true);
        
        await capabilities.scheduler.stop();
    });

    test("should handle parallel task failures independently", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(1000);
        
        let goodTaskExecuted = false;
        let badTaskExecuted = false;
        
        const goodTask = jest.fn(async () => {
            await new Promise(resolve => setTimeout(resolve, 10));
            goodTaskExecuted = true;
        });
        
        const badTask = jest.fn(async () => {
            badTaskExecuted = true;
            throw new Error("Task failed");
        });
        
        const registrations = [
            ["good-task", "* * * * *", goodTask, retryDelay],
            ["bad-task", "* * * * *", badTask, retryDelay]
        ];
        
        await capabilities.scheduler.initialize(registrations, { pollIntervalMs: 100 });
        
        // Wait for executions
        await new Promise(resolve => setTimeout(resolve, 200));
        
        // Both tasks should have been attempted
        expect(goodTaskExecuted).toBe(true);
        expect(badTaskExecuted).toBe(true);
        expect(goodTask).toHaveBeenCalled();
        expect(badTask).toHaveBeenCalled();
        
        await capabilities.scheduler.stop();
    });

    test("should handle many parallel tasks with retries", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(500); // Short retry for faster testing
        
        let taskExecutions = {};
        
        const createTask = (id) => jest.fn(async () => {
            if (!taskExecutions[id]) {
                taskExecutions[id] = 0;
            }
            taskExecutions[id]++;
            
            // First execution fails, second succeeds
            if (taskExecutions[id] === 1) {
                throw new Error(`Task ${id} first execution fails`);
            }
        });
        
        const task1 = createTask('1');
        const task2 = createTask('2');
        const task3 = createTask('3');
        
        const registrations = [
            ["retry-task-1", "* * * * *", task1, retryDelay],
            ["retry-task-2", "* * * * *", task2, retryDelay],
            ["retry-task-3", "* * * * *", task3, retryDelay]
        ];
        
        await capabilities.scheduler.initialize(registrations, { pollIntervalMs: 100 });
        
        // Wait for initial executions and retries
        await new Promise(resolve => setTimeout(resolve, 800));
        
        // All tasks should have been called at least twice (initial + retry)
        expect(task1).toHaveBeenCalledTimes(2);
        expect(task2).toHaveBeenCalledTimes(2);
        expect(task3).toHaveBeenCalledTimes(2);
        
        await capabilities.scheduler.stop();
    });
});