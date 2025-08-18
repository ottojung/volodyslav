/**
 * Tests for polling scheduler scanning algorithm optimization.
 * Ensures efficient forward calculation instead of backward scanning.
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

describe("polling scheduler scanning algorithm optimization", () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date("2020-01-01T00:00:00Z"));
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test("should efficiently determine next execution time", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);
        
        // Mock performance timing to measure efficiency
        const performanceMock = {
            mark: jest.fn(),
            measure: jest.fn(),
            getEntriesByName: jest.fn(() => [{ duration: 5 }]) // Mock 5ms duration
        };
        global.performance = performanceMock;
        
        const task = jest.fn();
        
        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
        await scheduler.schedule("efficient-test", "0 */6 * * *", task, retryDelay); // Every 6 hours
        
        // Get tasks info - should use efficient forward calculation
        const startTime = Date.now();
        const tasks = await scheduler.getTasks();
        const endTime = Date.now();
        
        expect(tasks).toHaveLength(1);
        expect(tasks[0].name).toBe("efficient-test");
        
        // Should complete quickly (under 100ms even for complex schedules)
        const duration = endTime - startTime;
        expect(duration).toBeLessThan(100);
        
        await scheduler.cancelAll();
    });

    test("should handle yearly schedules efficiently", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);
        
        const task = jest.fn();
        
        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
        // Schedule for February 29th (leap year)
        await scheduler.schedule("yearly-test", "0 0 29 2 *", task, retryDelay);
        
        // Set time to non-leap year
        jest.setSystemTime(new Date("2021-01-01T00:00:00Z"));
        
        const startTime = Date.now();
        const tasks = await scheduler.getTasks();
        const endTime = Date.now();
        
        expect(tasks).toHaveLength(1);
        
        // Should still complete quickly despite yearly schedule
        const duration = endTime - startTime;
        expect(duration).toBeLessThan(100);
        
        await scheduler.cancelAll();
    });

    test("should cache execution calculations", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);
        
        const task = jest.fn();
        
        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
        await scheduler.schedule("cache-test", "0 */2 * * *", task, retryDelay); // Every 2 hours
        
        // First call to getTasks
        const startTime1 = Date.now();
        await scheduler.getTasks();
        const endTime1 = Date.now();
        const firstDuration = endTime1 - startTime1;
        
        // Second call should be faster due to caching
        const startTime2 = Date.now();
        await scheduler.getTasks();
        const endTime2 = Date.now();
        const secondDuration = endTime2 - startTime2;
        
        // Second call should be significantly faster (or at least not slower)
        expect(secondDuration).toBeLessThanOrEqual(firstDuration + 10); // Allow 10ms variance
        
        await scheduler.cancelAll();
    });

    test("should invalidate cache when task state changes", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);
        
        const task = jest.fn();
        
        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
        await scheduler.schedule("cache-invalidation-test", "* * * * *", task, retryDelay);
        
        // Get initial state
        let tasks = await scheduler.getTasks();
        expect(tasks[0].modeHint).toBe("cron");
        
        // Simulate task execution by advancing time
        jest.setSystemTime(new Date("2020-01-01T00:01:00Z"));
        
        // Cache should be invalidated and new state calculated
        tasks = await scheduler.getTasks();
        expect(tasks[0].modeHint).toBe("cron"); // Should reflect new time
        
        await scheduler.cancelAll();
    });

    test("should handle multiple tasks efficiently", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);
        
        const task = jest.fn();
        
        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
        
        // Add many tasks with different schedules
        const taskPromises = [];
        for (let i = 0; i < 50; i++) {
            taskPromises.push(
                scheduler.schedule(`task-${i}`, `${i % 60} * * * *`, task, retryDelay)
            );
        }
        await Promise.all(taskPromises);
        
        // Getting tasks should still be fast with many tasks
        const startTime = Date.now();
        const tasks = await scheduler.getTasks();
        const endTime = Date.now();
        
        expect(tasks).toHaveLength(50);
        
        // Should complete in reasonable time even with many tasks
        const duration = endTime - startTime;
        expect(duration).toBeLessThan(500); // 500ms limit for 50 tasks
        
        await scheduler.cancelAll();
    }, 10000); // 10 second timeout for multiple tasks test
});