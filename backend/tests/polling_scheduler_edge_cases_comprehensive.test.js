/**
 * Comprehensive edge case tests for polling scheduler.
 * Tests boundary conditions, error scenarios, and complex edge cases.
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

describe("polling scheduler comprehensive edge cases", () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date("2024-02-29T12:00:00Z")); // Leap year
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe("boundary conditions", () => {
        test("should handle task scheduled exactly at polling interval", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const taskCallback = jest.fn();
            
            // 10-minute polling interval
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 10 * 60 * 1000 });
            
            // Schedule task that runs every 10 minutes (exactly at polling frequency)
            await scheduler.schedule("exact-timing", "*/10 * * * *", taskCallback, retryDelay);
            
            // Should not throw frequency validation error
            const tasks = await scheduler.getTasks();
            expect(tasks).toHaveLength(1);
            expect(tasks[0].name).toBe("exact-timing");
            
            await scheduler.cancelAll();
        });

        test("should handle multiple tasks with identical timing", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const callback1 = jest.fn();
            const callback2 = jest.fn();
            const callback3 = jest.fn();
            
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            // Schedule multiple tasks with identical cron expressions
            await scheduler.schedule("task1", "0 * * * *", callback1, retryDelay); // Hourly
            await scheduler.schedule("task2", "0 * * * *", callback2, retryDelay); // Hourly
            await scheduler.schedule("task3", "0 * * * *", callback3, retryDelay); // Hourly
            
            // Move to exactly the hour mark
            jest.setSystemTime(new Date("2024-02-29T13:00:00Z"));
            
            await scheduler._poll();
            
            // All tasks should execute
            expect(callback1).toHaveBeenCalledTimes(1);
            expect(callback2).toHaveBeenCalledTimes(1);
            expect(callback3).toHaveBeenCalledTimes(1);
            
            await scheduler.cancelAll();
        });

        test("should handle tasks scheduled in the past", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const taskCallback = jest.fn();
            
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            // Set time to 12:30
            jest.setSystemTime(new Date("2024-02-29T12:30:00Z"));
            
            // Schedule task that should have run at 12:00 (30 minutes ago)
            await scheduler.schedule("past-task", "0 12 * * *", taskCallback, retryDelay);
            
            // Task should be due for immediate execution
            const tasks = await scheduler.getTasks();
            expect(tasks[0].modeHint).toBe("cron");
            
            await scheduler._poll();
            expect(taskCallback).toHaveBeenCalledTimes(1);
            
            await scheduler.cancelAll();
        });

        test("should handle very short retry delays", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(1); // 1ms retry delay
            let callCount = 0;
            const flakyCallback = jest.fn(() => {
                callCount++;
                if (callCount === 1) {
                    throw new Error("First failure");
                }
            });
            
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            await scheduler.schedule("short-retry", "* * * * *", flakyCallback, retryDelay);
            
            // First execution fails
            await scheduler._poll();
            expect(flakyCallback).toHaveBeenCalledTimes(1);
            
            // Should retry immediately since delay is 1ms
            await scheduler._poll();
            expect(flakyCallback).toHaveBeenCalledTimes(2);
            
            await scheduler.cancelAll();
        });

        test("should handle very long retry delays", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(365 * 24 * 60 * 60 * 1000); // 1 year
            const flakyCallback = jest.fn(() => {
                throw new Error("Always fails");
            });
            
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            await scheduler.schedule("long-retry", "* * * * *", flakyCallback, retryDelay);
            
            // First execution fails
            await scheduler._poll();
            expect(flakyCallback).toHaveBeenCalledTimes(1);
            
            // Move forward 6 months - should not retry yet
            jest.setSystemTime(new Date("2024-08-29T12:00:00Z"));
            await scheduler._poll();
            expect(flakyCallback).toHaveBeenCalledTimes(1); // No retry yet
            
            // Move forward 1 year and 1 day - should retry now
            jest.setSystemTime(new Date("2025-03-01T12:00:00Z"));
            await scheduler._poll();
            expect(flakyCallback).toHaveBeenCalledTimes(2); // Retry happened
            
            await scheduler.cancelAll();
        });
    });

    describe("complex cron expressions", () => {
        test("should handle leap year specific schedules", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const taskCallback = jest.fn();
            
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            // Schedule task for Feb 29th only
            await scheduler.schedule("leap-year-task", "0 12 29 2 *", taskCallback, retryDelay);
            
            // Currently Feb 29, 2024 (leap year) at 12:00
            jest.setSystemTime(new Date("2024-02-29T12:00:00Z"));
            
            await scheduler._poll();
            expect(taskCallback).toHaveBeenCalledTimes(1);
            
            // Move to non-leap year Feb 28
            jest.setSystemTime(new Date("2025-02-28T12:00:00Z"));
            await scheduler._poll();
            expect(taskCallback).toHaveBeenCalledTimes(1); // No additional execution
            
            // Move to next leap year Feb 29
            jest.setSystemTime(new Date("2028-02-29T12:00:00Z"));
            await scheduler._poll();
            expect(taskCallback).toHaveBeenCalledTimes(2); // Should execute again
            
            await scheduler.cancelAll();
        });

        test("should handle last day of month schedules", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const taskCallback = jest.fn();
            
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            // Schedule task for last day of every month at noon
            await scheduler.schedule("month-end-task", "0 12 L * *", taskCallback, retryDelay);
            
            // February 29, 2024 (last day of February in leap year)
            jest.setSystemTime(new Date("2024-02-29T12:00:00Z"));
            await scheduler._poll();
            expect(taskCallback).toHaveBeenCalledTimes(1);
            
            // March 31, 2024 (last day of March)
            jest.setSystemTime(new Date("2024-03-31T12:00:00Z"));
            await scheduler._poll();
            expect(taskCallback).toHaveBeenCalledTimes(2);
            
            // April 30, 2024 (last day of April)
            jest.setSystemTime(new Date("2024-04-30T12:00:00Z"));
            await scheduler._poll();
            expect(taskCallback).toHaveBeenCalledTimes(3);
            
            await scheduler.cancelAll();
        });

        test("should handle very sparse schedules", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const taskCallback = jest.fn();
            
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            // Schedule task for New Year's Day at midnight
            await scheduler.schedule("yearly-task", "0 0 1 1 *", taskCallback, retryDelay);
            
            // Start mid-year
            jest.setSystemTime(new Date("2024-06-15T12:00:00Z"));
            await scheduler._poll();
            expect(taskCallback).toHaveBeenCalledTimes(0); // Not due yet
            
            // Move to New Year's Day
            jest.setSystemTime(new Date("2025-01-01T00:00:00Z"));
            await scheduler._poll();
            expect(taskCallback).toHaveBeenCalledTimes(1); // Should execute
            
            // Move to next New Year's Day
            jest.setSystemTime(new Date("2026-01-01T00:00:00Z"));
            await scheduler._poll();
            expect(taskCallback).toHaveBeenCalledTimes(2); // Should execute again
            
            await scheduler.cancelAll();
        });

        test("should handle complex multi-field constraints", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const taskCallback = jest.fn();
            
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            // Schedule task for every Monday and Wednesday at 9 AM and 5 PM in January and July
            await scheduler.schedule("complex-schedule", "0 9,17 * 1,7 1,3", taskCallback, retryDelay);
            
            // Monday, January 1, 2024 at 9 AM (should match)
            jest.setSystemTime(new Date("2024-01-01T09:00:00Z"));
            await scheduler._poll();
            expect(taskCallback).toHaveBeenCalledTimes(1);
            
            // Tuesday, January 2, 2024 at 9 AM (should not match - wrong day)
            jest.setSystemTime(new Date("2024-01-02T09:00:00Z"));
            await scheduler._poll();
            expect(taskCallback).toHaveBeenCalledTimes(1); // No additional execution
            
            // Wednesday, July 3, 2024 at 5 PM (should match)
            jest.setSystemTime(new Date("2024-07-03T17:00:00Z"));
            await scheduler._poll();
            expect(taskCallback).toHaveBeenCalledTimes(2);
            
            // Monday, February 5, 2024 at 9 AM (should not match - wrong month)
            jest.setSystemTime(new Date("2024-02-05T09:00:00Z"));
            await scheduler._poll();
            expect(taskCallback).toHaveBeenCalledTimes(2); // No additional execution
            
            await scheduler.cancelAll();
        });
    });

    describe("performance and resource edge cases", () => {
        test("should handle large gaps efficiently", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const taskCallback = jest.fn();
            
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            // Schedule yearly task
            await scheduler.schedule("gap-test", "0 0 1 1 *", taskCallback, retryDelay);
            
            // Set initial time
            jest.setSystemTime(new Date("2020-01-01T00:00:00Z"));
            await scheduler._poll();
            expect(taskCallback).toHaveBeenCalledTimes(1);
            
            // Jump forward 10 years - should handle efficiently
            const startTime = Date.now();
            jest.setSystemTime(new Date("2030-01-01T00:00:00Z"));
            await scheduler._poll();
            const endTime = Date.now();
            
            expect(taskCallback).toHaveBeenCalledTimes(2);
            
            // Should complete quickly (under 1 second even with fake timers)
            expect(endTime - startTime).toBeLessThan(1000);
            
            await scheduler.cancelAll();
        });

        test("should handle many concurrent tasks", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const scheduler = makePollingScheduler(capabilities, { 
                pollIntervalMs: 60000,
                maxConcurrentTasks: 5
            });
            
            // Schedule 20 tasks all due at the same time
            const callbacks = [];
            for (let i = 0; i < 20; i++) {
                const callback = jest.fn();
                callbacks.push(callback);
                await scheduler.schedule(`task-${i}`, "* * * * *", callback, retryDelay);
            }
            
            // Execute all tasks
            await scheduler._poll();
            
            // Due to concurrency limit, not all may execute in first poll
            // But some should execute
            const executedCount = callbacks.filter(cb => cb.mock.calls.length > 0).length;
            expect(executedCount).toBeGreaterThan(0);
            expect(executedCount).toBeLessThanOrEqual(20);
            
            await scheduler.cancelAll();
        });

        test("should handle task execution that takes longer than polling interval", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 1000 });
            
            let taskStarted = false;
            let taskFinished = false;
            
            const longRunningTask = jest.fn(async () => {
                taskStarted = true;
                // Simulate task taking 5 seconds (longer than 1 second poll interval)
                return new Promise(resolve => {
                    setTimeout(() => {
                        taskFinished = true;
                        resolve();
                    }, 5000);
                });
            });
            
            await scheduler.schedule("long-task", "* * * * *", longRunningTask, retryDelay);
            
            // Start task execution
            const pollPromise = scheduler._poll();
            
            // Task should start immediately
            expect(taskStarted).toBe(true);
            expect(taskFinished).toBe(false);
            
            // Advance time by poll interval
            jest.advanceTimersByTime(1000);
            
            // Task should still be running, new poll should be blocked by reentrant protection
            expect(taskFinished).toBe(false);
            
            // Complete the long running task
            jest.advanceTimersByTime(4000);
            await pollPromise;
            
            expect(taskFinished).toBe(true);
            expect(longRunningTask).toHaveBeenCalledTimes(1);
            
            await scheduler.cancelAll();
        });
    });

    describe("state corruption and recovery", () => {
        test("should handle corrupted datetime objects gracefully", async () => {
            const capabilities = caps();
            
            // Mock storage to return corrupted state
            jest.doMock("../src/runtime_state_storage", () => ({
                transaction: jest.fn(async (caps, callback) => {
                    const mockStorage = {
                        getExistingState: jest.fn(() => ({
                            version: 2,
                            startTime: capabilities.datetime.now(),
                            tasks: [{
                                name: "corrupted-task",
                                cronExpression: "* * * * *",
                                retryDelayMs: 5000,
                                lastSuccessTime: "invalid-date-string", // Corrupted datetime
                                lastAttemptTime: null,
                                lastEvaluatedFire: undefined
                            }]
                        })),
                        getCurrentState: jest.fn(() => ({
                            version: 2,
                            startTime: capabilities.datetime.now(),
                            tasks: []
                        })),
                        setState: jest.fn()
                    };
                    return callback(mockStorage);
                })
            }));
            
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            // Should handle corrupted state gracefully
            const tasks = await scheduler.getTasks();
            
            // Task should be skipped due to corruption, but scheduler should continue working
            expect(tasks).toHaveLength(0);
            
            // Should be able to schedule new tasks normally
            await scheduler.schedule("new-task", "* * * * *", jest.fn(), fromMilliseconds(5000));
            
            const newTasks = await scheduler.getTasks();
            expect(newTasks).toHaveLength(1);
            expect(newTasks[0].name).toBe("new-task");
            
            await scheduler.cancelAll();
            
            // Restore original implementation
            jest.unmock("../src/runtime_state_storage");
        });

        test("should handle missing required fields in task records", async () => {
            const capabilities = caps();
            
            // Mock storage to return incomplete state
            jest.doMock("../src/runtime_state_storage", () => ({
                transaction: jest.fn(async (caps, callback) => {
                    const mockStorage = {
                        getExistingState: jest.fn(() => ({
                            version: 2,
                            startTime: capabilities.datetime.now(),
                            tasks: [
                                {
                                    name: "incomplete-task-1",
                                    // Missing cronExpression
                                    retryDelayMs: 5000
                                },
                                {
                                    // Missing name
                                    cronExpression: "* * * * *",
                                    retryDelayMs: 5000
                                },
                                {
                                    name: "incomplete-task-3",
                                    cronExpression: "invalid-cron",
                                    retryDelayMs: 5000
                                }
                            ]
                        })),
                        getCurrentState: jest.fn(() => ({
                            version: 2,
                            startTime: capabilities.datetime.now(),
                            tasks: []
                        })),
                        setState: jest.fn()
                    };
                    return callback(mockStorage);
                })
            }));
            
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            // Should handle incomplete records gracefully
            const tasks = await scheduler.getTasks();
            
            // All corrupted tasks should be skipped
            expect(tasks).toHaveLength(0);
            
            // Scheduler should continue to work normally
            await scheduler.schedule("good-task", "* * * * *", jest.fn(), fromMilliseconds(5000));
            
            const newTasks = await scheduler.getTasks();
            expect(newTasks).toHaveLength(1);
            expect(newTasks[0].name).toBe("good-task");
            
            await scheduler.cancelAll();
            
            jest.unmock("../src/runtime_state_storage");
        });
    });

    describe("callback edge cases", () => {
        test("should handle callbacks that throw specific error types", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            const customError = new TypeError("Custom error type");
            const callback = jest.fn(() => {
                throw customError;
            });
            
            await scheduler.schedule("error-task", "* * * * *", callback, retryDelay);
            
            await scheduler._poll();
            
            expect(callback).toHaveBeenCalledTimes(1);
            
            // Task should be in retry state
            const tasks = await scheduler.getTasks();
            expect(tasks[0].modeHint).toBe("retry");
            expect(tasks[0].pendingRetryUntil).toBeTruthy();
            
            await scheduler.cancelAll();
        });

        test("should handle callbacks that return both promises and sync values", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            const syncCallback = jest.fn(() => "sync result");
            const asyncCallback = jest.fn(() => Promise.resolve("async result"));
            
            await scheduler.schedule("sync-task", "* * * * *", syncCallback, retryDelay);
            await scheduler.schedule("async-task", "* * * * *", asyncCallback, retryDelay);
            
            await scheduler._poll();
            
            expect(syncCallback).toHaveBeenCalledTimes(1);
            expect(asyncCallback).toHaveBeenCalledTimes(1);
            
            const tasks = await scheduler.getTasks();
            expect(tasks).toHaveLength(2);
            expect(tasks.every(t => t.modeHint === "idle")).toBe(true);
            
            await scheduler.cancelAll();
        });

        test("should handle null callback gracefully", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            await scheduler.schedule("test-task", "* * * * *", jest.fn(), retryDelay);
            
            // Simulate callback being set to null (like during state loading)
            const tasks = await scheduler.getTasks();
            expect(tasks).toHaveLength(1);
            
            // Manually set callback to null to test edge case
            const taskMap = scheduler._tasks || new Map();
            if (taskMap.size > 0) {
                const task = Array.from(taskMap.values())[0];
                task.callback = null;
            }
            
            // Poll should skip task with null callback
            await scheduler._poll();
            
            // No error should occur
            expect(true).toBe(true); // Test passes if no exception thrown
            
            await scheduler.cancelAll();
        });
    });

    describe("timing precision edge cases", () => {
        test("should handle minute boundary precision", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const taskCallback = jest.fn();
            
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 1000 });
            
            await scheduler.schedule("minute-boundary", "* * * * *", taskCallback, retryDelay);
            
            // Set time to 59.999 seconds (just before minute boundary)
            jest.setSystemTime(new Date("2024-02-29T12:00:59.999Z"));
            await scheduler._poll();
            expect(taskCallback).toHaveBeenCalledTimes(0); // Should not execute yet
            
            // Move to exact minute boundary
            jest.setSystemTime(new Date("2024-02-29T12:01:00.000Z"));
            await scheduler._poll();
            expect(taskCallback).toHaveBeenCalledTimes(1); // Should execute now
            
            await scheduler.cancelAll();
        });

        test("should handle second precision in task timing", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const taskCallback = jest.fn();
            
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 1000 });
            
            await scheduler.schedule("second-precision", "* * * * *", taskCallback, retryDelay);
            
            // Set time with seconds component
            jest.setSystemTime(new Date("2024-02-29T12:00:30.500Z"));
            await scheduler._poll();
            expect(taskCallback).toHaveBeenCalledTimes(1); // Should execute (cron matches minute)
            
            await scheduler.cancelAll();
        });
    });
});