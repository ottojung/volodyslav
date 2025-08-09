/**
 * Tests for the cron scheduler module.
 */

const { makeCronScheduler } = require("../src/cron/scheduler");
const { isSchedulerError } = require("../src/cron/scheduler_errors");
const { isTaskId } = require("../src/cron/task_id");
const datetime = require("../src/datetime");
const { fromMinutes } = require("../src/time_duration");

describe("Cron Scheduler", () => {
    let scheduler;
    let dt;
    let mockCapabilities;
    let retryDelay;

    beforeEach(() => {
        mockCapabilities = {
            logger: {
                logError: jest.fn(),
                logWarning: jest.fn(),
                logInfo: jest.fn(),
                logDebug: jest.fn(),
            }
        };
        scheduler = makeCronScheduler(mockCapabilities);
        dt = datetime.make();
        retryDelay = fromMinutes(5); // 5 minute retry delay for tests
        jest.useFakeTimers();
    });

    afterEach(() => {
        scheduler.cancelAll();
        jest.useRealTimers();
    });

    describe("schedule", () => {
        test("schedules a task with valid cron expression", () => {
            const callback = jest.fn();
            const taskId = scheduler.schedule("* * * * *", callback, retryDelay);
            
            expect(isTaskId(taskId)).toBe(true);
            expect(taskId.toString()).toMatch(/^task_\d+$/);
        });

        test("throws error with invalid cron expression", () => {
            const callback = jest.fn();
            
            let thrownError;
            try {
                scheduler.schedule("invalid", callback, retryDelay);
            } catch (error) {
                thrownError = error;
            }
            
            expect(thrownError).toBeDefined();
            expect(isSchedulerError(thrownError)).toBe(true);
            expect(thrownError.cronExpression).toBe("invalid");
        });

        test("executes task at scheduled time", () => {
            const callback = jest.fn();
            const now = dt.fromEpochMs(new Date(2024, 0, 1, 14, 59, 30).getTime()); // 2:59:30 PM
            jest.spyOn(scheduler.datetime, 'now').mockReturnValue(now);
            
            scheduler.schedule("0 15 * * *", callback, retryDelay); // 3:00 PM
            
            // Advance time to 3:00 PM
            jest.advanceTimersByTime(30 * 1000); // 30 seconds
            
            expect(callback).toHaveBeenCalledTimes(1);
        });

        test("reschedules task after execution", () => {
            const callback = jest.fn();
            const now = dt.fromEpochMs(new Date(2024, 0, 1, 14, 59, 30).getTime()); // 2:59:30 PM
            jest.spyOn(scheduler.datetime, 'now')
                .mockReturnValueOnce(now)
                .mockReturnValue(dt.fromEpochMs(new Date(2024, 0, 1, 15, 0, 0).getTime()));
            
            scheduler.schedule("0 * * * *", callback, retryDelay); // Every hour
            
            // First execution at 3:00 PM
            jest.advanceTimersByTime(30 * 1000);
            expect(callback).toHaveBeenCalledTimes(1);
            
            // Second execution at 4:00 PM
            jest.advanceTimersByTime(60 * 60 * 1000); // 1 hour
            expect(callback).toHaveBeenCalledTimes(2);
        });

        test("handles async callbacks", async () => {
            const callback = jest.fn().mockResolvedValue(undefined);
            const now = dt.fromEpochMs(new Date(2024, 0, 1, 14, 59, 30).getTime());
            jest.spyOn(scheduler.datetime, 'now').mockReturnValue(now);
            
            scheduler.schedule("0 15 * * *", callback, retryDelay);
            
            jest.advanceTimersByTime(30 * 1000);
            
            expect(callback).toHaveBeenCalledTimes(1);
        });

        test("continues scheduling even if callback throws error", () => {
            const callback = jest.fn().mockImplementation(() => {
                throw new Error("Task error");
            });
            
            const now = dt.fromEpochMs(new Date(2024, 0, 1, 14, 59, 30).getTime());
            jest.spyOn(scheduler.datetime, 'now')
                .mockReturnValueOnce(now)
                .mockReturnValue(dt.fromEpochMs(new Date(2024, 0, 1, 15, 0, 0).getTime()));
            
            scheduler.schedule("0 * * * *", callback, retryDelay);
            
            // First execution should trigger error and retry
            jest.advanceTimersByTime(30 * 1000);
            expect(callback).toHaveBeenCalledTimes(1);
            expect(mockCapabilities.logger.logError).toHaveBeenCalledWith(
                expect.objectContaining({
                    error: "Task error",
                    retryDelay: expect.any(String)
                }),
                expect.stringContaining("failed, retrying")
            );
            
            // After retry delay, should retry the same execution
            jest.advanceTimersByTime(retryDelay.toMilliseconds());
            expect(callback).toHaveBeenCalledTimes(2);
        });
    });

    describe("cancel", () => {
        test("cancels a scheduled task", () => {
            const callback = jest.fn();
            const taskId = scheduler.schedule("* * * * *", callback, retryDelay);
            
            const result = scheduler.cancel(taskId);
            expect(result).toBe(true);
            
            // Task should not execute
            jest.advanceTimersByTime(60 * 1000);
            expect(callback).not.toHaveBeenCalled();
        });

        test("returns false for non-existent task", () => {
            const { generateTaskId } = require("../src/cron/task_id");
            const fakeTaskId = generateTaskId(999);
            const result = scheduler.cancel(fakeTaskId);
            expect(result).toBe(false);
        });

        test("does not cancel other tasks", () => {
            const callback1 = jest.fn();
            const callback2 = jest.fn();
            
            const taskId1 = scheduler.schedule("* * * * *", callback1, retryDelay);
            scheduler.schedule("* * * * *", callback2, retryDelay);
            
            scheduler.cancel(taskId1);
            
            jest.advanceTimersByTime(60 * 1000);
            
            expect(callback1).not.toHaveBeenCalled();
            expect(callback2).toHaveBeenCalled();
        });
    });

    describe("cancelAll", () => {
        test("cancels all scheduled tasks", () => {
            const callback1 = jest.fn();
            const callback2 = jest.fn();
            
            scheduler.schedule("* * * * *", callback1, retryDelay);
            scheduler.schedule("* * * * *", callback2, retryDelay);
            
            const result = scheduler.cancelAll();
            expect(result).toBe(2);
            
            jest.advanceTimersByTime(60 * 1000);
            
            expect(callback1).not.toHaveBeenCalled();
            expect(callback2).not.toHaveBeenCalled();
        });

        test("returns 0 when no tasks are scheduled", () => {
            const result = scheduler.cancelAll();
            expect(result).toBe(0);
        });
    });

    describe("getTasks", () => {
        test("returns empty array when no tasks are scheduled", () => {
            const tasks = scheduler.getTasks();
            expect(tasks).toEqual([]);
        });

        test("returns information about scheduled tasks", () => {
            const callback1 = jest.fn();
            const callback2 = jest.fn();
            
            const now = dt.fromEpochMs(new Date(2024, 0, 1, 14, 30, 0).getTime());
            jest.spyOn(scheduler.datetime, 'now').mockReturnValue(now);
            
            scheduler.schedule("0 15 * * *", callback1, retryDelay);
            scheduler.schedule("30 16 * * *", callback2, retryDelay);
            
            const tasks = scheduler.getTasks();
            
            expect(tasks).toHaveLength(2);
            expect(isTaskId(tasks[0].id)).toBe(true);
            expect(tasks[0].cronExpression).toBe("0 15 * * *");
            expect(tasks[0].nextExecution).toBeDefined();
            expect(isTaskId(tasks[1].id)).toBe(true);
            expect(tasks[1].cronExpression).toBe("30 16 * * *");
            expect(tasks[1].nextExecution).toBeDefined();
        });

        test("does not expose internal callback functions", () => {
            const callback = jest.fn();
            scheduler.schedule("* * * * *", callback, retryDelay);
            
            const tasks = scheduler.getTasks();
            expect(tasks[0]).not.toHaveProperty("callback");
        });
    });

    describe("task execution timing", () => {
        test("schedules next execution correctly for every minute", () => {
            const callback = jest.fn();
            const now = dt.fromEpochMs(new Date(2024, 0, 1, 14, 30, 30).getTime()); // 2:30:30 PM
            jest.spyOn(scheduler.datetime, 'now')
                .mockReturnValueOnce(now)
                .mockReturnValue(dt.fromEpochMs(new Date(2024, 0, 1, 14, 31, 0).getTime()));
            
            scheduler.schedule("* * * * *", callback, retryDelay);
            
            // Should execute at 2:31:00 PM (next minute)
            jest.advanceTimersByTime(30 * 1000); // 30 seconds to get to 2:31:00
            expect(callback).toHaveBeenCalledTimes(1);
            
            // Next execution should be at 2:32:00 PM
            jest.advanceTimersByTime(60 * 1000); // 1 minute
            expect(callback).toHaveBeenCalledTimes(2);
        });

        test("schedules daily task correctly", () => {
            const callback = jest.fn();
            const now = dt.fromEpochMs(new Date(2024, 0, 1, 1, 30, 0).getTime()); // 1:30 AM
            jest.spyOn(scheduler.datetime, 'now')
                .mockReturnValueOnce(now)
                .mockReturnValue(dt.fromEpochMs(new Date(2024, 0, 1, 2, 0, 0).getTime()));
            
            scheduler.schedule("0 2 * * *", callback, retryDelay); // 2:00 AM daily
            
            // Should execute at 2:00 AM
            jest.advanceTimersByTime(30 * 60 * 1000); // 30 minutes
            expect(callback).toHaveBeenCalledTimes(1);
            
            // Next execution should be next day at 2:00 AM
            jest.advanceTimersByTime(24 * 60 * 60 * 1000); // 24 hours
            expect(callback).toHaveBeenCalledTimes(2);
        });
    });
});
