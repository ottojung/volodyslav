/**
 * Tests for scheduler task DateTime deserialization functionality.
 * These tests specifically validate the new DateTime deserialization capabilities.
 */

const { fromMilliseconds } = require("../src/datetime");
const { parseCronExpression } = require("../src/scheduler/expression");
const { tryDeserialize } = require("../src/scheduler/task/serialization");
const { getLastSuccessTime, getLastFailureTime, getLastAttemptTime, getPendingRetryUntil } = require("../src/scheduler/task/structure");
const {
    isTaskTryDeserializeError,
    isTaskInvalidTypeError,
} = require("../src/scheduler/task/serialization_errors");
const { fromISOString, isDateTime } = require("../src/datetime");

describe("scheduler task DateTime deserialization", () => {
    
    function createTestRegistrations() {
        const registrations = new Map();
        registrations.set("test-task", {
            parsedCron: parseCronExpression("0 * * * *"),
            callback: () => {},
            retryDelay: fromMilliseconds(5000),
        });
        return registrations;
    }

    describe("DateTime field deserialization", () => {
        test("should deserialize ISO string DateTime fields", () => {
            const registrations = createTestRegistrations();
            const isoString = "2022-01-01T00:00:00.000Z";
            
            // Test AwaitingRetry state deserialization
            const awaitingRetryObj = {
                name: "test-task",
                cronExpression: "0 * * * *",
                retryDelayMs: 5000,
                lastFailureTime: isoString,
                pendingRetryUntil: isoString
            };
            
            const awaitingRetryResult = tryDeserialize(awaitingRetryObj, registrations);
            
            expect(isTaskTryDeserializeError(awaitingRetryResult)).toBe(false);
            expect(awaitingRetryResult.name).toBe("test-task");
            expect(isDateTime(getLastFailureTime(awaitingRetryResult))).toBe(true);
            expect(getLastFailureTime(awaitingRetryResult).toISOString()).toBe(isoString);
            expect(isDateTime(getPendingRetryUntil(awaitingRetryResult))).toBe(true);
            expect(getPendingRetryUntil(awaitingRetryResult).toISOString()).toBe(isoString);
            expect(isDateTime(getLastAttemptTime(awaitingRetryResult))).toBe(true);
            expect(getLastAttemptTime(awaitingRetryResult).toISOString()).toBe(isoString);
            
            // Test AwaitingRun state deserialization
            const awaitingRunObj = {
                name: "test-task",
                cronExpression: "0 * * * *",
                retryDelayMs: 5000,
                lastSuccessTime: isoString,
                lastAttemptTime: isoString
            };
            
            const awaitingRunResult = tryDeserialize(awaitingRunObj, registrations);
            
            expect(isTaskTryDeserializeError(awaitingRunResult)).toBe(false);
            expect(awaitingRunResult.name).toBe("test-task");
            expect(isDateTime(getLastSuccessTime(awaitingRunResult))).toBe(true);
            expect(getLastSuccessTime(awaitingRunResult).toISOString()).toBe(isoString);
            expect(isDateTime(getLastAttemptTime(awaitingRunResult))).toBe(true);
            expect(getLastAttemptTime(awaitingRunResult).toISOString()).toBe(isoString);
        });

        test("should deserialize JSON-parsed DateTime objects", () => {
            const registrations = createTestRegistrations();
            const dateTime = fromISOString("2022-01-01T00:00:00.000Z");
            
            // Simulate JSON stringify/parse cycle
            const serialized = JSON.stringify({ lastSuccessTime: dateTime });
            const parsed = JSON.parse(serialized);
            
            const obj = {
                name: "test-task",
                cronExpression: "0 * * * *",
                retryDelayMs: 5000,
                lastSuccessTime: parsed.lastSuccessTime
            };
            
            const result = tryDeserialize(obj, registrations);
            
            expect(isTaskTryDeserializeError(result)).toBe(false);
            expect(result.name).toBe("test-task");
            expect(isDateTime(getLastSuccessTime(result))).toBe(true);
            expect(getLastSuccessTime(result).toISOString()).toBe("2022-01-01T00:00:00.000Z");
        });

        test("should continue to accept existing DateTime objects", () => {
            const registrations = createTestRegistrations();
            const dateTime = fromISOString("2022-01-01T00:00:00.000Z");
            const obj = {
                name: "test-task",
                cronExpression: "0 * * * *",
                retryDelayMs: 5000,
                lastSuccessTime: dateTime
            };
            
            const result = tryDeserialize(obj, registrations);
            
            expect(isTaskTryDeserializeError(result)).toBe(false);
            expect(result.name).toBe("test-task");
            expect(isDateTime(getLastSuccessTime(result))).toBe(true);
            expect(getLastSuccessTime(result).toISOString()).toBe("2022-01-01T00:00:00.000Z");
        });

        test("should return error for invalid ISO string", () => {
            const registrations = createTestRegistrations();
            const obj = {
                name: "test-task",
                cronExpression: "0 * * * *",
                retryDelayMs: 5000,
                lastSuccessTime: "not-a-valid-iso-string"
            };
            
            const result = tryDeserialize(obj, registrations);
            
            expect(isTaskInvalidTypeError(result)).toBe(true);
            expect(result.field).toBe("lastSuccessTime");
            expect(result.expectedType).toBe("DateTime or undefined");
        });

        test("should return error for completely invalid DateTime value", () => {
            const registrations = createTestRegistrations();
            const obj = {
                name: "test-task",
                cronExpression: "0 * * * *",
                retryDelayMs: 5000,
                lastSuccessTime: 123 // number is not valid
            };
            
            const result = tryDeserialize(obj, registrations);
            
            expect(isTaskInvalidTypeError(result)).toBe(true);
            expect(result.field).toBe("lastSuccessTime");
            expect(result.expectedType).toBe("DateTime or undefined");
        });

        test("should handle mixed DateTime field types in single object", () => {
            const registrations = createTestRegistrations();
            const dateTime = fromISOString("2022-01-01T00:00:00.000Z");
            const isoString = "2022-06-15T12:30:00.000Z";
            
            // Test with AwaitingRun state (lastSuccessTime and lastAttemptTime)
            const obj = {
                name: "test-task",
                cronExpression: "0 * * * *",
                retryDelayMs: 5000,
                lastSuccessTime: dateTime,           // DateTime object
                lastAttemptTime: isoString,          // ISO string
            };
            
            const result = tryDeserialize(obj, registrations);
            
            expect(isTaskTryDeserializeError(result)).toBe(false);
            expect(result.name).toBe("test-task");
            expect(isDateTime(getLastSuccessTime(result))).toBe(true);
            expect(getLastSuccessTime(result).toISOString()).toBe("2022-01-01T00:00:00.000Z");
            expect(isDateTime(getLastAttemptTime(result))).toBe(true);
            expect(getLastAttemptTime(result).toISOString()).toBe(isoString);
            expect(getLastFailureTime(result)).toBe(undefined);
            expect(getPendingRetryUntil(result)).toBe(undefined);
        });
    });

    describe("Edge cases", () => {
        test("should handle objects with toISOString method", () => {
            const registrations = createTestRegistrations();
            const mockDateObject = {
                toISOString: () => "2022-01-01T00:00:00.000Z"
            };
            
            const obj = {
                name: "test-task",
                cronExpression: "0 * * * *",
                retryDelayMs: 5000,
                lastSuccessTime: mockDateObject
            };
            
            const result = tryDeserialize(obj, registrations);
            
            expect(isTaskTryDeserializeError(result)).toBe(false);
            expect(result.name).toBe("test-task");
            expect(isDateTime(getLastSuccessTime(result))).toBe(true);
            expect(getLastSuccessTime(result).toISOString()).toBe("2022-01-01T00:00:00.000Z");
        });

        test("should return error for object with toISOString that throws", () => {
            const registrations = createTestRegistrations();
            const mockDateObject = {
                toISOString: () => { throw new Error("Mock error"); }
            };
            
            const obj = {
                name: "test-task",
                cronExpression: "0 * * * *",
                retryDelayMs: 5000,
                lastSuccessTime: mockDateObject
            };
            
            const result = tryDeserialize(obj, registrations);
            
            expect(isTaskInvalidTypeError(result)).toBe(true);
            expect(result.field).toBe("lastSuccessTime");
            expect(result.expectedType).toBe("DateTime or undefined");
        });
    });
});