/**
 * Tests for scheduler task DateTime deserialization functionality.
 * These tests specifically validate the new DateTime deserialization capabilities.
 */

const { Duration } = require("luxon");
const { parseCronExpression } = require("../src/scheduler/expression");
const { tryDeserialize } = require("../src/scheduler/task/serialization");
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
            retryDelay: Duration.fromMillis(5000),
        });
        return registrations;
    }

    describe("DateTime field deserialization", () => {
        test("should deserialize ISO string DateTime fields", () => {
            const registrations = createTestRegistrations();
            const isoString = "2022-01-01T00:00:00.000Z";
            const obj = {
                name: "test-task",
                cronExpression: "0 * * * *",
                retryDelayMs: 5000,
                lastSuccessTime: isoString,
                lastFailureTime: isoString,
                lastAttemptTime: isoString,
                pendingRetryUntil: isoString
            };
            
            const result = tryDeserialize(obj, registrations);
            
            expect(isTaskTryDeserializeError(result)).toBe(false);
            expect(result.name).toBe("test-task");
            expect(isDateTime(result.lastSuccessTime)).toBe(true);
            expect(result.lastSuccessTime.toISOString()).toBe(isoString);
            expect(isDateTime(result.lastFailureTime)).toBe(true);
            expect(result.lastFailureTime.toISOString()).toBe(isoString);
            expect(isDateTime(result.lastAttemptTime)).toBe(true);
            expect(result.lastAttemptTime.toISOString()).toBe(isoString);
            expect(isDateTime(result.pendingRetryUntil)).toBe(true);
            expect(result.pendingRetryUntil.toISOString()).toBe(isoString);
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
            expect(isDateTime(result.lastSuccessTime)).toBe(true);
            expect(result.lastSuccessTime.toISOString()).toBe("2022-01-01T00:00:00.000Z");
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
            expect(isDateTime(result.lastSuccessTime)).toBe(true);
            expect(result.lastSuccessTime.toISOString()).toBe("2022-01-01T00:00:00.000Z");
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
            
            // Mix of DateTime object and ISO string
            const obj = {
                name: "test-task",
                cronExpression: "0 * * * *",
                retryDelayMs: 5000,
                lastSuccessTime: dateTime,           // DateTime object
                lastFailureTime: isoString,          // ISO string
                lastAttemptTime: undefined,          // undefined (should remain undefined)
                // pendingRetryUntil not present (should be undefined)
            };
            
            const result = tryDeserialize(obj, registrations);
            
            expect(isTaskTryDeserializeError(result)).toBe(false);
            expect(result.name).toBe("test-task");
            expect(isDateTime(result.lastSuccessTime)).toBe(true);
            expect(result.lastSuccessTime.toISOString()).toBe("2022-01-01T00:00:00.000Z");
            expect(isDateTime(result.lastFailureTime)).toBe(true);
            expect(result.lastFailureTime.toISOString()).toBe(isoString);
            expect(result.lastAttemptTime).toBe(undefined);
            expect(result.pendingRetryUntil).toBe(undefined);
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
            expect(isDateTime(result.lastSuccessTime)).toBe(true);
            expect(result.lastSuccessTime.toISOString()).toBe("2022-01-01T00:00:00.000Z");
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