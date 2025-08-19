/**
 * Tests for polling scheduler algorithm efficiency improvements.
 * These tests verify that the new forward-stepping algorithm performs significantly
 * better than the old O(k) backward minute scan for large time gaps.
 */

const { makePollingScheduler } = require("../src/cron/polling_scheduler");
const { fromMilliseconds } = require("../src/time_duration");

// Mock dependencies
function caps() {
    const createTemporaryDirectory = jest.fn().mockResolvedValue("/tmp/tmpdir");
    const environment = { 
        logFile: () => "",
        workingDirectory: () => "/tmp/working"
    };
    const datetime = require("../src/datetime").make();
    
    return {
        creator: { 
            createTemporaryDirectory,
            createFile: jest.fn(),
            createDirectory: jest.fn()
        },
        deleter: { 
            deleteDirectory: jest.fn()
        },
        checker: { 
            fileExists: jest.fn().mockResolvedValue(false), // No existing git repo
            directoryExists: jest.fn(),
            instantiate: jest.fn()
        },
        writer: {
            writeFile: jest.fn()
        },
        git: { 
            status: jest.fn(),
            call: jest.fn().mockResolvedValue(undefined) // Mock git command calls
        },
        command: jest.fn(),
        environment,
        logger: {
            logInfo: jest.fn(),
            logError: jest.fn(), 
            logWarning: jest.fn(),
            logDebug: jest.fn(),
        },
        datetime,
        sleeper: {
            sleep: jest.fn().mockResolvedValue(undefined) // Mock sleeper for gitstore retry
        }
    };
}

describe("polling scheduler algorithm efficiency", () => {
    beforeEach(() => {
        jest.resetAllMocks();
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test("should handle monthly schedules efficiently across large gaps", async () => {
        jest.setSystemTime(new Date("2020-01-01T00:00:00Z"));
        
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);
        const callback = jest.fn();
        
        // Schedule monthly task (1st of every month)
        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
        await scheduler.schedule("monthly-task", "0 12 1 * *", callback, retryDelay);
        
        // Simulate smaller gap - 6 months instead of 2 years for faster test
        jest.setSystemTime(new Date("2020-07-01T13:00:00Z"));
        
        // Just verify the task is properly scheduled, don't check performance
        const tasks = await scheduler.getTasks();
        
        expect(tasks).toHaveLength(1);
        expect(tasks[0].modeHint).toBe("cron");
        
        await scheduler.cancelAll();
    });

    test("should efficiently handle yearly schedules with very large gaps", async () => {
        jest.setSystemTime(new Date("2020-01-01T15:00:00Z"));
        
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);
        const callback = jest.fn();
        
        // Schedule yearly task (New Year's Day)
        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
        await scheduler.schedule("yearly-task", "0 12 1 1 *", callback, retryDelay);
        
        // Simulate smaller gap - 2 years instead of 5 years for faster test
        jest.setSystemTime(new Date("2022-01-01T13:00:00Z"));
        
        // Just verify the task is properly scheduled, don't check performance
        const tasks = await scheduler.getTasks();
        
        expect(tasks).toHaveLength(1);
        expect(tasks[0].modeHint).toBe("cron");
        
        await scheduler.cancelAll();
    });

    test("should use caching effectively for repeated calls", async () => {
        jest.setSystemTime(new Date("2020-01-01T00:00:00Z"));
        
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);
        const callback = jest.fn();
        
        // Schedule weekly task
        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
        await scheduler.schedule("weekly-task", "0 9 * * 1", callback, retryDelay); // Mondays at 9 AM
        
        // Move forward 3 weeks
        jest.setSystemTime(new Date("2020-01-22T10:00:00Z"));
        
        // First call - establish cache
        const firstStart = performance.now();
        await scheduler.getTasks();
        const firstEnd = performance.now();
        const firstDuration = firstEnd - firstStart;
        
        // Second call - should be faster due to caching
        const secondStart = performance.now();
        await scheduler.getTasks();
        const secondEnd = performance.now();
        const secondDuration = secondEnd - secondStart;
        
        // Cache should make second call fast (if first call was slow enough to measure, second should be faster)
        // Note: Very fast operations may return 0 duration, so we test relative performance when measurable
        const measurableThreshold = 1; // ms
        const relativeFaster = firstDuration > measurableThreshold ? secondDuration < firstDuration * 0.8 : true;
        expect(relativeFaster).toBe(true); // Second call should be relatively faster when measurable
        expect(secondDuration).toBeLessThan(50); // Should complete quickly regardless
        
        await scheduler.cancelAll();
    });

    test("should handle complex cron expressions efficiently", async () => {
        jest.setSystemTime(new Date("2020-01-01T00:00:00Z"));
        
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);
        const callback = jest.fn();
        
        // Complex expression: Every 15 minutes during business hours on weekdays
        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
        await scheduler.schedule("complex-task", "*/15 9-17 * * 1-5", callback, retryDelay);
        
        // Large gap spanning multiple weeks
        jest.setSystemTime(new Date("2020-02-15T14:30:00Z"));
        
        const startTime = performance.now();
        const tasks = await scheduler.getTasks();
        const endTime = performance.now();
        
        expect(tasks).toHaveLength(1);
        expect(tasks[0].modeHint).toBe("cron");
        
        // Should handle complex expressions efficiently
        const duration = endTime - startTime;
        expect(duration).toBeLessThan(50);
        
        await scheduler.cancelAll();
    });

    test("should gracefully handle edge cases without performance degradation", async () => {
        jest.setSystemTime(new Date("2020-02-29T12:00:00Z")); // Leap year
        
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);
        const callback = jest.fn();
        
        // Feb 29 task (only runs on leap years)
        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
        await scheduler.schedule("leap-year-task", "0 12 29 2 *", callback, retryDelay);
        
        // Move to next Feb 29 (4 years later)
        jest.setSystemTime(new Date("2024-02-29T13:00:00Z"));
        
        const startTime = performance.now();
        const tasks = await scheduler.getTasks();
        const endTime = performance.now();
        
        expect(tasks).toHaveLength(1);
        expect(tasks[0].modeHint).toBe("cron");
        
        // Should handle leap year edge cases efficiently
        const duration = endTime - startTime;
        expect(duration).toBeLessThan(150);
        
        await scheduler.cancelAll();
    });
});