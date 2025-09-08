/**
 * Tests for scheduler task methods edge cases.
 * Focuses on testing the isRunning logic and other task state methods.
 */

const { isRunning } = require("../src/scheduler/task/methods");
const { makeTask, createStateFromProperties, getLastAttemptTime, getLastSuccessTime, getLastFailureTime, getPendingRetryUntil, getSchedulerIdentifier } = require("../src/scheduler/task/structure");
const { parseCronExpression } = require("../src/scheduler/expression");
const { Duration } = require("luxon");
const { fromISOString } = require("../src/datetime");

describe("scheduler task methods edge cases", () => {

    function createTestTask(overrides = {}) {
        const defaults = {
            name: "test-task",
            parsedCron: parseCronExpression("0 * * * *"),
            callback: jest.fn(),
            retryDelay: Duration.fromMillis(5000),
            lastSuccessTime: undefined,
            lastFailureTime: undefined,
            lastAttemptTime: undefined,
            pendingRetryUntil: undefined,
            schedulerIdentifier: undefined,
        };

        const config = { ...defaults, ...overrides };
        
        // Create state object from individual properties
        const state = createStateFromProperties(
            config.lastSuccessTime,
            config.lastFailureTime,
            config.lastAttemptTime,
            config.pendingRetryUntil,
            config.schedulerIdentifier
        );
        
        return makeTask(
            config.name,
            config.parsedCron,
            config.callback,
            config.retryDelay,
            state
        );
    }

    describe("isRunning method", () => {
        test("should return false when lastAttemptTime is undefined", () => {
            const task = createTestTask({
                lastAttemptTime: undefined,
                lastSuccessTime: fromISOString("2024-01-01T10:00:00.000Z"),
                lastFailureTime: fromISOString("2024-01-01T11:00:00.000Z")
            });

            expect(isRunning(task)).toBe(false);
        });

        test("should return false when lastAttemptTime is null", () => {
            const task = createTestTask({
                lastAttemptTime: null
            });

            // Updated implementation now handles null gracefully
            expect(isRunning(task)).toBe(false);
        });

        test("should return true when lastAttemptTime is more recent than both success and failure", () => {
            const task = createTestTask({
                lastAttemptTime: fromISOString("2024-01-01T12:00:00.000Z"),
                lastSuccessTime: fromISOString("2024-01-01T10:00:00.000Z"),
                lastFailureTime: fromISOString("2024-01-01T11:00:00.000Z")
            });

            expect(isRunning(task)).toBe(true);
        });

        test("should return false when lastAttemptTime is older than lastSuccessTime", () => {
            const task = createTestTask({
                lastAttemptTime: fromISOString("2024-01-01T10:00:00.000Z"),
                lastSuccessTime: fromISOString("2024-01-01T11:00:00.000Z"),
                lastFailureTime: fromISOString("2024-01-01T09:00:00.000Z")
            });

            expect(isRunning(task)).toBe(false);
        });

        test("should return false when lastAttemptTime equals lastSuccessTime", () => {
            const sameTime = fromISOString("2024-01-01T10:00:00.000Z");
            const task = createTestTask({
                lastAttemptTime: sameTime,
                lastSuccessTime: sameTime,
                lastFailureTime: fromISOString("2024-01-01T09:00:00.000Z")
            });

            expect(isRunning(task)).toBe(false);
        });

        test("should return true when only lastAttemptTime is set", () => {
            const task = createTestTask({
                lastAttemptTime: fromISOString("2024-01-01T10:00:00.000Z"),
                lastSuccessTime: undefined,
                lastFailureTime: undefined
            });

            expect(isRunning(task)).toBe(true);
        });

        test("should handle edge case with undefined success but defined failure", () => {
            const task = createTestTask({
                lastAttemptTime: fromISOString("2024-01-01T12:00:00.000Z"),
                lastSuccessTime: undefined,
                lastFailureTime: fromISOString("2024-01-01T11:00:00.000Z")
            });

            expect(isRunning(task)).toBe(true);
        });

        test("should handle edge case with defined success but undefined failure", () => {
            const task = createTestTask({
                lastAttemptTime: fromISOString("2024-01-01T12:00:00.000Z"),
                lastSuccessTime: fromISOString("2024-01-01T11:00:00.000Z"),
                lastFailureTime: undefined
            });

            expect(isRunning(task)).toBe(true);
        });

        test("should handle edge case with both success and failure undefined", () => {
            const task = createTestTask({
                lastAttemptTime: fromISOString("2024-01-01T10:00:00.000Z"),
                lastSuccessTime: undefined,
                lastFailureTime: undefined
            });

            expect(isRunning(task)).toBe(true);
        });

        test("should handle null values for success and failure times", () => {
            const task = createTestTask({
                lastAttemptTime: fromISOString("2024-01-01T10:00:00.000Z"),
                lastSuccessTime: null,
                lastFailureTime: null
            });

            expect(isRunning(task)).toBe(true);
        });

        test("should correctly use Math.max for completion time calculation", () => {
            // Test where failure is more recent than success
            const task1 = createTestTask({
                lastAttemptTime: fromISOString("2024-01-01T14:00:00.000Z"),
                lastSuccessTime: fromISOString("2024-01-01T10:00:00.000Z"),
                lastFailureTime: fromISOString("2024-01-01T12:00:00.000Z") // More recent than success
            });

            expect(isRunning(task1)).toBe(true);

            // Test where success is more recent than failure
            const task2 = createTestTask({
                lastAttemptTime: fromISOString("2024-01-01T10:00:00.000Z"),
                lastSuccessTime: fromISOString("2024-01-01T09:00:00.000Z"), // More recent than failure
                lastFailureTime: fromISOString("2024-01-01T08:00:00.000Z")
            });

            expect(isRunning(task2)).toBe(true);
        });

        test("should handle very close timestamps correctly", () => {
            const baseTime = fromISOString("2024-01-01T10:00:00.000Z"); // 2024-01-01T10:00:00.000Z
            const task = createTestTask({
                lastAttemptTime: fromISOString("2024-01-01T10:00:00.001Z"), // 1ms later
                lastSuccessTime: baseTime,
                lastFailureTime: undefined
            });

            expect(isRunning(task)).toBe(true);
        });

        test("should handle identical timestamps correctly", () => {
            const sameTime = fromISOString("2024-01-01T10:00:00.000Z");
            const task = createTestTask({
                lastAttemptTime: sameTime,
                lastSuccessTime: sameTime,
                lastFailureTime: sameTime
            });

            expect(isRunning(task)).toBe(false);
        });

        test("should handle extreme timestamp values", () => {
            // Test with very old dates
            const veryOldDate = 0;
            const recentDate = fromISOString("2024-01-01T10:00:00.000Z");
            
            const task1 = createTestTask({
                lastAttemptTime: recentDate,
                lastSuccessTime: veryOldDate,
                lastFailureTime: veryOldDate
            });

            expect(isRunning(task1)).toBe(true);

            // Test with future dates
            const futureDate = 1893456000000;
            const task2 = createTestTask({
                lastAttemptTime: recentDate,
                lastSuccessTime: futureDate,
                lastFailureTime: undefined
            });

            expect(isRunning(task2)).toBe(false);
        });

        test("should work with proper DateTime objects", () => {
            // Use proper DateTime objects instead of mock objects
            const attemptTime = fromISOString("2024-01-01T12:00:00.000Z");
            const successTime = fromISOString("2024-01-01T11:00:00.000Z");

            const task = createTestTask({
                lastAttemptTime: attemptTime,
                lastSuccessTime: successTime,
                lastFailureTime: undefined
            });

            expect(isRunning(task)).toBe(true);
        });

        test("should handle all permutations of defined/undefined times", () => {
            const attemptTime = fromISOString("2024-01-01T12:00:00.000Z");
            const successTime = fromISOString("2024-01-01T11:00:00.000Z");
            const failureTime = fromISOString("2024-01-01T10:00:00.000Z");

            // All combinations of undefined/defined success and failure times
            const testCases = [
                { success: undefined, failure: undefined, expected: true },
                { success: undefined, failure: failureTime, expected: true },
                { success: successTime, failure: undefined, expected: true },
                { success: successTime, failure: failureTime, expected: true }
            ];

            testCases.forEach(({ success, failure, expected }, _index) => {
                const task = createTestTask({
                    lastAttemptTime: attemptTime,
                    lastSuccessTime: success,
                    lastFailureTime: failure
                });

                expect(isRunning(task)).toBe(expected);
            });
        });

        test("should return consistent results for same input", () => {
            const task = createTestTask({
                lastAttemptTime: fromISOString("2024-01-01T12:00:00.000Z"),
                lastSuccessTime: fromISOString("2024-01-01T11:00:00.000Z"),
                lastFailureTime: fromISOString("2024-01-01T10:00:00.000Z")
            });

            // Should return same result multiple times
            const result1 = isRunning(task);
            const result2 = isRunning(task);
            const result3 = isRunning(task);

            expect(result1).toBe(result2);
            expect(result2).toBe(result3);
            expect(result1).toBe(true);
        });

        test("should not modify the task object", () => {
            const originalAttemptTime = fromISOString("2024-01-01T12:00:00.000Z");
            const originalSuccessTime = fromISOString("2024-01-01T11:00:00.000Z");
            
            const task = createTestTask({
                lastAttemptTime: originalAttemptTime,
                lastSuccessTime: originalSuccessTime,
                lastFailureTime: undefined
            });

            const beforeCall = {
                attempt: getLastAttemptTime(task),
                success: getLastSuccessTime(task),
                failure: getLastFailureTime(task)
            };

            isRunning(task);

            expect(getLastAttemptTime(task)).toBe(beforeCall.attempt);
            expect(getLastSuccessTime(task)).toBe(beforeCall.success);
            expect(getLastFailureTime(task)).toBe(beforeCall.failure);
        });
    });

    describe("task structure integrity", () => {
        test("should preserve task properties in appropriate state", () => {
            const name = "test-task";
            const parsedCron = parseCronExpression("0 * * * *");
            const callback = jest.fn();
            const retryDelay = Duration.fromMillis(5000);
            
            // Test AwaitingRetry state (pendingRetryUntil + lastFailureTime)
            const lastFailureTime = fromISOString("2024-01-01T11:00:00.000Z");
            const pendingRetryUntil = fromISOString("2024-01-01T13:00:00.000Z");

            const awaitingRetryState = createStateFromProperties(
                undefined,
                lastFailureTime,
                undefined,
                pendingRetryUntil,
                undefined
            );

            const awaitingRetryTask = makeTask(
                name,
                parsedCron,
                callback,
                retryDelay,
                awaitingRetryState
            );

            expect(awaitingRetryTask.name).toBe(name);
            expect(awaitingRetryTask.parsedCron).toBe(parsedCron);
            expect(awaitingRetryTask.callback).toBe(callback);
            expect(awaitingRetryTask.retryDelay).toBe(retryDelay);
            expect(getLastFailureTime(awaitingRetryTask)).toBe(lastFailureTime);
            expect(getPendingRetryUntil(awaitingRetryTask)).toBe(pendingRetryUntil);
            expect(getLastSuccessTime(awaitingRetryTask)).toBeUndefined();
            expect(getLastAttemptTime(awaitingRetryTask)).toBeUndefined();
            
            // Test Running state (lastAttemptTime + schedulerIdentifier)
            const lastAttemptTime = fromISOString("2024-01-01T12:00:00.000Z");
            const schedulerIdentifier = "test-scheduler";

            const runningState = createStateFromProperties(
                undefined,
                undefined,
                lastAttemptTime,
                undefined,
                schedulerIdentifier
            );

            const runningTask = makeTask(
                name,
                parsedCron,
                callback,
                retryDelay,
                runningState
            );

            expect(getLastAttemptTime(runningTask)).toBe(lastAttemptTime);
            expect(getSchedulerIdentifier(runningTask)).toBe(schedulerIdentifier);
            expect(getLastSuccessTime(runningTask)).toBeUndefined();
            expect(getLastFailureTime(runningTask)).toBeUndefined();
            
            // Test AwaitingRun state (lastSuccessTime + lastAttemptTime)
            const lastSuccessTime = fromISOString("2024-01-01T10:00:00.000Z");

            const awaitingRunState = createStateFromProperties(
                lastSuccessTime,
                undefined,
                undefined,
                undefined,
                undefined
            );

            const awaitingRunTask = makeTask(
                name,
                parsedCron,
                callback,
                retryDelay,
                awaitingRunState
            );

            expect(getLastSuccessTime(awaitingRunTask)).toBe(lastSuccessTime);
            expect(getLastAttemptTime(awaitingRunTask)).toBeUndefined();
            expect(getLastFailureTime(awaitingRunTask)).toBeUndefined();
            expect(getPendingRetryUntil(awaitingRunTask)).toBeUndefined();
        });

        test("should handle optional parameters as undefined", () => {
            const state = createStateFromProperties(
                undefined,
                undefined,
                undefined,
                undefined,
                undefined
            );

            const task = makeTask(
                "test-task",
                parseCronExpression("0 * * * *"),
                jest.fn(),
                Duration.fromMillis(5000),
                state
            );

            expect(getLastSuccessTime(task)).toBeUndefined();
            expect(getLastFailureTime(task)).toBeUndefined();
            expect(getLastAttemptTime(task)).toBeUndefined();
            // Note: pendingRetryUntil will be undefined for AwaitingRun state
        });
    });
});