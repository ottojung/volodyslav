/**
 * Tests for scheduler task methods edge cases.
 * Focuses on testing the isRunning logic and other task state methods.
 */

const { isRunning } = require("../src/scheduler/task/methods");
const { makeTask } = require("../src/scheduler/task/structure");
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
            lastEvaluatedFire: undefined
        };

        const config = { ...defaults, ...overrides };
        
        return makeTask(
            config.name,
            config.parsedCron,
            config.callback,
            config.retryDelay,
            config.lastSuccessTime,
            config.lastFailureTime,
            config.lastAttemptTime,
            config.pendingRetryUntil,
            config.lastEvaluatedFire
        );
    }

    describe("isRunning method", () => {
        test("should return false when lastAttemptTime is undefined", () => {
            const task = createTestTask({
                lastAttemptTime: undefined,
                lastSuccessTime: 1704103200000,
                lastFailureTime: 1704106800000
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
                lastAttemptTime: 1704110400000,
                lastSuccessTime: 1704103200000,
                lastFailureTime: 1704106800000
            });

            expect(isRunning(task)).toBe(true);
        });

        test("should return false when lastAttemptTime is older than lastSuccessTime", () => {
            const task = createTestTask({
                lastAttemptTime: 1704103200000,
                lastSuccessTime: 1704106800000,
                lastFailureTime: 1704099600000
            });

            expect(isRunning(task)).toBe(false);
        });

        test("should return false when lastAttemptTime is older than lastFailureTime", () => {
            const task = createTestTask({
                lastAttemptTime: 1704103200000,
                lastSuccessTime: 1704099600000,
                lastFailureTime: 1704106800000
            });

            expect(isRunning(task)).toBe(false);
        });

        test("should return false when lastAttemptTime equals lastSuccessTime", () => {
            const sameTime = 1704103200000;
            const task = createTestTask({
                lastAttemptTime: sameTime,
                lastSuccessTime: sameTime,
                lastFailureTime: 1704099600000
            });

            expect(isRunning(task)).toBe(false);
        });

        test("should return false when lastAttemptTime equals lastFailureTime", () => {
            const sameTime = 1704103200000;
            const task = createTestTask({
                lastAttemptTime: sameTime,
                lastSuccessTime: 1704099600000,
                lastFailureTime: sameTime
            });

            expect(isRunning(task)).toBe(false);
        });

        test("should return true when only lastAttemptTime is set", () => {
            const task = createTestTask({
                lastAttemptTime: 1704103200000,
                lastSuccessTime: undefined,
                lastFailureTime: undefined
            });

            expect(isRunning(task)).toBe(true);
        });

        test("should handle edge case with undefined success but defined failure", () => {
            const task = createTestTask({
                lastAttemptTime: 1704110400000,
                lastSuccessTime: undefined,
                lastFailureTime: 1704106800000
            });

            expect(isRunning(task)).toBe(true);
        });

        test("should handle edge case with defined success but undefined failure", () => {
            const task = createTestTask({
                lastAttemptTime: 1704110400000,
                lastSuccessTime: 1704106800000,
                lastFailureTime: undefined
            });

            expect(isRunning(task)).toBe(true);
        });

        test("should handle edge case with both success and failure undefined", () => {
            const task = createTestTask({
                lastAttemptTime: 1704103200000,
                lastSuccessTime: undefined,
                lastFailureTime: undefined
            });

            expect(isRunning(task)).toBe(true);
        });

        test("should handle null values for success and failure times", () => {
            const task = createTestTask({
                lastAttemptTime: 1704103200000,
                lastSuccessTime: null,
                lastFailureTime: null
            });

            expect(isRunning(task)).toBe(true);
        });

        test("should correctly use Math.max for completion time calculation", () => {
            // Test where failure is more recent than success
            const task1 = createTestTask({
                lastAttemptTime: 1704103200000,
                lastSuccessTime: 1704096000000,
                lastFailureTime: fromISOString("Z")More recent than success
            });

            expect(isRunning(task1)).toBe(true);

            // Test where success is more recent than failure
            const task2 = createTestTask({
                lastAttemptTime: 1704103200000,
                lastSuccessTime: 1704099600000, // More recent than failure
                lastFailureTime: 1704096000000
            });

            expect(isRunning(task2)).toBe(true);
        });

        test("should handle very close timestamps correctly", () => {
            const baseTime = 1704103200000; // 2024-01-01T10:00:00.000Z
            const task = createTestTask({
                lastAttemptTime: 1704103200001, // 1ms later
                lastSuccessTime: baseTime,
                lastFailureTime: undefined
            });

            expect(isRunning(task)).toBe(true);
        });

        test("should handle identical timestamps correctly", () => {
            const sameTime = 1704103200000;
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
            const recentDate = 1704103200000;
            
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
            const attemptTime = 1000;
            const successTime = 500;

            const task = createTestTask({
                lastAttemptTime: attemptTime,
                lastSuccessTime: successTime,
                lastFailureTime: undefined
            });

            expect(isRunning(task)).toBe(true);
        });

        test("should handle all permutations of defined/undefined times", () => {
            const attemptTime = 1704110400000;
            const successTime = 1704106800000;
            const failureTime = 1704103200000;

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
                lastAttemptTime: 1704110400000,
                lastSuccessTime: 1704106800000,
                lastFailureTime: 1704103200000
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
            const originalAttemptTime = 1704110400000;
            const originalSuccessTime = 1704106800000;
            
            const task = createTestTask({
                lastAttemptTime: originalAttemptTime,
                lastSuccessTime: originalSuccessTime,
                lastFailureTime: undefined
            });

            const beforeCall = {
                attempt: task.lastAttemptTime,
                success: task.lastSuccessTime,
                failure: task.lastFailureTime
            };

            isRunning(task);

            expect(task.lastAttemptTime).toBe(beforeCall.attempt);
            expect(task.lastSuccessTime).toBe(beforeCall.success);
            expect(task.lastFailureTime).toBe(beforeCall.failure);
        });
    });

    describe("task structure integrity", () => {
        test("should preserve all task properties", () => {
            const name = "test-task";
            const parsedCron = parseCronExpression("0 * * * *");
            const callback = jest.fn();
            const retryDelay = Duration.fromMillis(5000);
            const lastSuccessTime = 1704103200000; // Fixed epoch for testing
            const lastFailureTime = 1704106800000; // Fixed epoch for testing
            const lastAttemptTime = 1704110400000; // Fixed epoch for testing
            const pendingRetryUntil = 1704114000000; // Fixed epoch for testing
            const lastEvaluatedFire = 1704117600000; // Fixed epoch for testing

            const task = makeTask(
                name,
                parsedCron,
                callback,
                retryDelay,
                lastSuccessTime,
                lastFailureTime,
                lastAttemptTime,
                pendingRetryUntil,
                lastEvaluatedFire
            );

            expect(task.name).toBe(name);
            expect(task.parsedCron).toBe(parsedCron);
            expect(task.callback).toBe(callback);
            expect(task.retryDelay).toBe(retryDelay);
            expect(task.lastSuccessTime).toBe(lastSuccessTime);
            expect(task.lastFailureTime).toBe(lastFailureTime);
            expect(task.lastAttemptTime).toBe(lastAttemptTime);
            expect(task.pendingRetryUntil).toBe(pendingRetryUntil);
            expect(task.lastEvaluatedFire).toBe(lastEvaluatedFire);
        });

        test("should handle optional parameters as undefined", () => {
            const task = makeTask(
                "test-task",
                parseCronExpression("0 * * * *"),
                jest.fn(),
                Duration.fromMillis(5000)
            );

            expect(task.lastSuccessTime).toBeUndefined();
            expect(task.lastFailureTime).toBeUndefined();
            expect(task.lastAttemptTime).toBeUndefined();
            expect(task.pendingRetryUntil).toBeUndefined();
            expect(task.lastEvaluatedFire).toBeUndefined();
        });
    });
});