/**
 * Tests for polling scheduler algorithm edge cases.
 * Focuses on findPreviousFire algorithm, caching behavior, and mathematical edge cases.
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

describe("polling scheduler algorithm edge cases", () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date("2024-01-15T12:00:00Z"));
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe("findPreviousFire algorithm edge cases", () => {
        test("should handle expressions that never execute", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const taskCallback = jest.fn();
            
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            // Invalid day of month for February (Feb 30th doesn't exist)
            await scheduler.schedule("never-executes", "0 12 30 2 *", taskCallback, retryDelay);
            
            // Poll multiple times across different years
            for (let year = 2024; year <= 2030; year++) {
                jest.setSystemTime(new Date(`${year}-02-28T12:00:00Z`));
                await scheduler._poll();
                jest.setSystemTime(new Date(`${year}-03-01T12:00:00Z`));
                await scheduler._poll();
            }
            
            // Task should never execute
            expect(taskCallback).toHaveBeenCalledTimes(0);
            
            // Task should show as idle
            const tasks = await scheduler.getTasks();
            expect(tasks[0].modeHint).toBe("idle");
            
            await scheduler.cancelAll();
        });

        test("should handle very large time gaps without timeout", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const taskCallback = jest.fn();
            
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            // Schedule task for every 4 years (leap year Feb 29)
            await scheduler.schedule("leap-day-task", "0 12 29 2 *", taskCallback, retryDelay);
            
            // Start in 2000 and jump to 2100 (100 years)
            jest.setSystemTime(new Date("2000-02-29T12:00:00Z"));
            await scheduler._poll();
            expect(taskCallback).toHaveBeenCalledTimes(1);
            
            // Jump 100 years forward (should handle efficiently)
            const startTime = Date.now();
            jest.setSystemTime(new Date("2100-02-29T12:00:00Z")); // Note: 2100 is not a leap year
            await scheduler._poll();
            const endTime = Date.now();
            
            // Should complete quickly despite large gap
            expect(endTime - startTime).toBeLessThan(1000);
            
            // Task should not execute since 2100 is not a leap year
            expect(taskCallback).toHaveBeenCalledTimes(1);
            
            // Jump to next leap year
            jest.setSystemTime(new Date("2104-02-29T12:00:00Z"));
            await scheduler._poll();
            expect(taskCallback).toHaveBeenCalledTimes(2);
            
            await scheduler.cancelAll();
        });

        test("should handle iteration limit boundary conditions", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const taskCallback = jest.fn();
            
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            // Schedule very frequent task (every minute)
            await scheduler.schedule("frequent-task", "* * * * *", taskCallback, retryDelay);
            
            // Start at a time with no cache
            jest.setSystemTime(new Date("2024-01-15T12:00:00Z"));
            await scheduler._poll();
            expect(taskCallback).toHaveBeenCalledTimes(1);
            
            // Jump back to test backward iteration (should use fallback)
            jest.setSystemTime(new Date("2023-01-15T12:00:00Z"));
            await scheduler._poll();
            expect(taskCallback).toHaveBeenCalledTimes(2);
            
            await scheduler.cancelAll();
        });

        test("should handle cache hits and misses correctly", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const taskCallback = jest.fn();
            
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            await scheduler.schedule("cache-test", "0 * * * *", taskCallback, retryDelay); // Hourly
            
            // First execution - no cache
            jest.setSystemTime(new Date("2024-01-15T13:00:00Z"));
            await scheduler._poll();
            expect(taskCallback).toHaveBeenCalledTimes(1);
            
            // Second execution - should use cache from first
            jest.setSystemTime(new Date("2024-01-15T14:00:00Z"));
            await scheduler._poll();
            expect(taskCallback).toHaveBeenCalledTimes(2);
            
            // Large gap - cache should still be helpful
            jest.setSystemTime(new Date("2024-01-20T15:00:00Z"));
            await scheduler._poll();
            expect(taskCallback).toHaveBeenCalledTimes(3);
            
            await scheduler.cancelAll();
        });

        test("should handle forward stepping failure scenarios", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const taskCallback = jest.fn();
            
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            // Use a complex expression that might cause forward stepping issues
            await scheduler.schedule("complex-expr", "0 0 31 2,4,6,9,11 *", taskCallback, retryDelay);
            
            // This expression tries to run on Feb 31, Apr 31, Jun 31, Sep 31, Nov 31
            // These dates don't exist, so should never execute
            
            jest.setSystemTime(new Date("2024-02-29T12:00:00Z"));
            await scheduler._poll();
            expect(taskCallback).toHaveBeenCalledTimes(0);
            
            jest.setSystemTime(new Date("2024-04-30T12:00:00Z"));
            await scheduler._poll();
            expect(taskCallback).toHaveBeenCalledTimes(0);
            
            jest.setSystemTime(new Date("2024-06-30T12:00:00Z"));
            await scheduler._poll();
            expect(taskCallback).toHaveBeenCalledTimes(0);
            
            await scheduler.cancelAll();
        });
    });

    describe("calculateMinimumCronInterval edge cases", () => {
        test("should detect sub-minute frequencies correctly", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const taskCallback = jest.fn();
            
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 }); // 1 minute
            
            // Try to schedule a task that would run every second if supported
            // Since cron only supports minute precision, this should be treated as every minute
            await expect(
                scheduler.schedule("every-minute", "* * * * *", taskCallback, retryDelay)
            ).resolves.toBe("every-minute");
            
            await scheduler.cancelAll();
        });

        test("should handle edge case cron expressions in frequency calculation", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const taskCallback = jest.fn();
            
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 10 * 60 * 1000 }); // 10 minutes
            
            // Expression that runs at specific times with varying intervals
            await expect(
                scheduler.schedule("varying-interval", "0,15,45 * * * *", taskCallback, retryDelay)
            ).rejects.toThrow(); // Should reject due to 15-minute minimum interval
            
            await scheduler.cancelAll();
        });

        test("should handle expressions with no executions in test period", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const taskCallback = jest.fn();
            
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            // Expression that only runs on non-existent dates
            await scheduler.schedule("rare-expr", "0 0 30 2 *", taskCallback, retryDelay); // Feb 30th
            
            // Should not throw error and should default to safe interval
            const tasks = await scheduler.getTasks();
            expect(tasks).toHaveLength(1);
            
            await scheduler.cancelAll();
        });

        test("should handle very complex multi-field expressions", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const taskCallback = jest.fn();
            
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            // Complex expression: Mondays and Fridays at 9:00 and 17:00 in Q1 and Q4
            await scheduler.schedule(
                "complex-quarterly",
                "0 9,17 * 1,2,3,10,11,12 1,5",
                taskCallback,
                retryDelay
            );
            
            const tasks = await scheduler.getTasks();
            expect(tasks).toHaveLength(1);
            
            await scheduler.cancelAll();
        });
    });

    describe("mathematical precision edge cases", () => {
        test("should handle millisecond precision in time calculations", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(1500); // 1.5 seconds
            let callCount = 0;
            const precisionCallback = jest.fn(() => {
                callCount++;
                if (callCount === 1) {
                    throw new Error("First failure for precision test");
                }
            });
            
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            await scheduler.schedule("precision-test", "* * * * *", precisionCallback, retryDelay);
            
            // Set precise time
            jest.setSystemTime(new Date("2024-01-15T12:00:00.000Z"));
            await scheduler._poll();
            expect(precisionCallback).toHaveBeenCalledTimes(1);
            
            // Advance by exactly 1.5 seconds
            jest.setSystemTime(new Date("2024-01-15T12:00:01.500Z"));
            await scheduler._poll();
            expect(precisionCallback).toHaveBeenCalledTimes(2);
            
            await scheduler.cancelAll();
        });

        test("should handle timezone-independent calculations", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const taskCallback = jest.fn();
            
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            await scheduler.schedule("tz-test", "0 12 * * *", taskCallback, retryDelay); // Noon daily
            
            // Test with different UTC times that represent same local time
            jest.setSystemTime(new Date("2024-01-15T12:00:00.000Z")); // UTC noon
            await scheduler._poll();
            expect(taskCallback).toHaveBeenCalledTimes(1);
            
            jest.setSystemTime(new Date("2024-01-16T12:00:00.000Z")); // Next day UTC noon
            await scheduler._poll();
            expect(taskCallback).toHaveBeenCalledTimes(2);
            
            await scheduler.cancelAll();
        });

        test("should handle date arithmetic edge cases", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const taskCallback = jest.fn();
            
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            await scheduler.schedule("date-arithmetic", "0 0 1 * *", taskCallback, retryDelay); // First of month
            
            // Test month boundaries
            jest.setSystemTime(new Date("2024-01-31T23:59:59.999Z")); // End of January
            await scheduler._poll();
            expect(taskCallback).toHaveBeenCalledTimes(0); // Should not execute yet
            
            jest.setSystemTime(new Date("2024-02-01T00:00:00.000Z")); // Start of February
            await scheduler._poll();
            expect(taskCallback).toHaveBeenCalledTimes(1); // Should execute now
            
            // Test leap year boundary
            jest.setSystemTime(new Date("2024-02-29T23:59:59.999Z")); // End of leap February
            await scheduler._poll();
            expect(taskCallback).toHaveBeenCalledTimes(1); // No additional execution
            
            jest.setSystemTime(new Date("2024-03-01T00:00:00.000Z")); // Start of March
            await scheduler._poll();
            expect(taskCallback).toHaveBeenCalledTimes(2); // Should execute again
            
            await scheduler.cancelAll();
        });
    });

    describe("cache behavior edge cases", () => {
        test("should invalidate cache appropriately", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const taskCallback = jest.fn();
            
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            await scheduler.schedule("cache-invalidation", "0 * * * *", taskCallback, retryDelay); // Hourly
            
            // First execution builds cache
            jest.setSystemTime(new Date("2024-01-15T13:00:00Z"));
            await scheduler._poll();
            expect(taskCallback).toHaveBeenCalledTimes(1);
            
            // Second execution uses cache
            jest.setSystemTime(new Date("2024-01-15T14:00:00Z"));
            await scheduler._poll();
            expect(taskCallback).toHaveBeenCalledTimes(2);
            
            // Large backward jump - cache should still work correctly
            jest.setSystemTime(new Date("2024-01-15T10:00:00Z"));
            await scheduler._poll();
            expect(taskCallback).toHaveBeenCalledTimes(3); // Should execute for 10:00
            
            await scheduler.cancelAll();
        });

        test("should handle cache performance with different gap sizes", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const taskCallback = jest.fn();
            
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            await scheduler.schedule("cache-performance", "*/5 * * * *", taskCallback, retryDelay); // Every 5 minutes
            
            // Small gap (within cache threshold)
            jest.setSystemTime(new Date("2024-01-15T12:00:00Z"));
            await scheduler._poll();
            expect(taskCallback).toHaveBeenCalledTimes(1);
            
            jest.setSystemTime(new Date("2024-01-15T12:05:00Z"));
            const smallGapStart = Date.now();
            await scheduler._poll();
            const smallGapEnd = Date.now();
            expect(taskCallback).toHaveBeenCalledTimes(2);
            
            // Large gap (beyond cache threshold)
            jest.setSystemTime(new Date("2024-02-15T12:00:00Z")); // 1 month later
            const largeGapStart = Date.now();
            await scheduler._poll();
            const largeGapEnd = Date.now();
            expect(taskCallback).toHaveBeenCalledTimes(3);
            
            // Both should complete reasonably quickly
            expect(smallGapEnd - smallGapStart).toBeLessThan(100);
            expect(largeGapEnd - largeGapStart).toBeLessThan(1000);
            
            await scheduler.cancelAll();
        });

        test("should handle cache with very sparse schedules", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const taskCallback = jest.fn();
            
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            // Very sparse: once per year
            await scheduler.schedule("sparse-cache", "0 0 1 1 *", taskCallback, retryDelay);
            
            // First execution
            jest.setSystemTime(new Date("2024-01-01T00:00:00Z"));
            await scheduler._poll();
            expect(taskCallback).toHaveBeenCalledTimes(1);
            
            // Check months later - should use cache efficiently
            jest.setSystemTime(new Date("2024-06-15T12:00:00Z"));
            await scheduler._poll();
            expect(taskCallback).toHaveBeenCalledTimes(1); // No execution
            
            // Next execution
            jest.setSystemTime(new Date("2025-01-01T00:00:00Z"));
            await scheduler._poll();
            expect(taskCallback).toHaveBeenCalledTimes(2);
            
            await scheduler.cancelAll();
        });
    });

    describe("error propagation in algorithm", () => {
        test("should handle cron parser errors gracefully", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const taskCallback = jest.fn();
            
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            // Try to schedule with invalid cron expression
            await expect(
                scheduler.schedule("invalid-cron", "invalid cron expression", taskCallback, retryDelay)
            ).rejects.toThrow();
            
            // Scheduler should still work for valid expressions
            await scheduler.schedule("valid-task", "* * * * *", taskCallback, retryDelay);
            
            const tasks = await scheduler.getTasks();
            expect(tasks).toHaveLength(1);
            expect(tasks[0].name).toBe("valid-task");
            
            await scheduler.cancelAll();
        });

        test("should handle datetime conversion errors", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const taskCallback = jest.fn();
            
            // Mock datetime to occasionally fail
            const originalDatetime = capabilities.datetime;
            let conversionCount = 0;
            capabilities.datetime = {
                ...originalDatetime,
                fromEpochMs: (ms) => {
                    conversionCount++;
                    if (conversionCount === 5) {
                        throw new Error("DateTime conversion failed");
                    }
                    return originalDatetime.fromEpochMs(ms);
                }
            };
            
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            await scheduler.schedule("datetime-error-test", "* * * * *", taskCallback, retryDelay);
            
            // Should handle datetime errors gracefully
            await scheduler._poll();
            
            // Task should still be present even if some datetime operations failed
            const tasks = await scheduler.getTasks();
            expect(tasks).toHaveLength(1);
            
            // Restore original datetime
            capabilities.datetime = originalDatetime;
            
            await scheduler.cancelAll();
        });

        test("should handle extreme time values", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const taskCallback = jest.fn();
            
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            await scheduler.schedule("extreme-time", "* * * * *", taskCallback, retryDelay);
            
            // Test near epoch start
            jest.setSystemTime(new Date("1970-01-01T00:01:00Z"));
            await scheduler._poll();
            expect(taskCallback).toHaveBeenCalledTimes(1);
            
            // Test far future
            jest.setSystemTime(new Date("2099-12-31T23:59:00Z"));
            await scheduler._poll();
            expect(taskCallback).toHaveBeenCalledTimes(2);
            
            await scheduler.cancelAll();
        });
    });
});