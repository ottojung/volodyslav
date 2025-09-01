/**
 * Tests for scheduler task serialization error handling.
 * Focuses on testing the various error classes and edge cases in task deserialization.
 */

const { Duration } = require("luxon");
const { parseCronExpression } = require("../src/scheduler/expression");
const { tryDeserialize } = require("../src/scheduler/task/serialization");
const {
    isTaskTryDeserializeError,
    isTaskMissingFieldError,
    isTaskInvalidTypeError,
    isTaskInvalidValueError,
    isTaskInvalidStructureError,
} = require("../src/scheduler/task/serialization_errors");

describe("scheduler task serialization error handling", () => {
    
    function createTestRegistrations() {
        const registrations = new Map();
        const parsedCron = parseCronExpression("0 * * * *");
        const callback = jest.fn();
        const retryDelay = Duration.fromMillis(5000);
        
        registrations.set("test-task", {
            name: "test-task",
            parsedCron,
            callback,
            retryDelay
        });
        
        return registrations;
    }

    describe("TaskInvalidStructureError scenarios", () => {
        test("should return TaskInvalidStructureError for null input", () => {
            const registrations = createTestRegistrations();
            const result = tryDeserialize(null, registrations);
            
            expect(isTaskInvalidStructureError(result)).toBe(true);
            expect(result.message).toContain("Object must be a non-null object");
        });

        test("should return TaskInvalidStructureError for array input", () => {
            const registrations = createTestRegistrations();
            const result = tryDeserialize(["not", "an", "object"], registrations);
            
            expect(isTaskInvalidStructureError(result)).toBe(true);
            expect(result.message).toContain("not an array");
        });

        test("should return TaskInvalidStructureError for primitive input", () => {
            const registrations = createTestRegistrations();
            const result = tryDeserialize("string", registrations);
            
            expect(isTaskInvalidStructureError(result)).toBe(true);
            expect(result.message).toContain("Object must be a non-null object");
        });

        test("should return TaskInvalidStructureError for undefined input", () => {
            const registrations = createTestRegistrations();
            const result = tryDeserialize(undefined, registrations);
            
            expect(isTaskInvalidStructureError(result)).toBe(true);
            expect(result.message).toContain("Object must be a non-null object");
        });
    });

    describe("TaskMissingFieldError scenarios", () => {
        test("should return TaskMissingFieldError when name field is missing", () => {
            const registrations = createTestRegistrations();
            const obj = {
                cronExpression: "0 * * * *",
                retryDelayMs: 5000
            };
            
            const result = tryDeserialize(obj, registrations);
            
            expect(isTaskMissingFieldError(result)).toBe(true);
            expect(result.field).toBe("name");
            expect(result.message).toContain("Missing required field: name");
        });

        test("should return TaskMissingFieldError when cronExpression field is missing", () => {
            const registrations = createTestRegistrations();
            const obj = {
                name: "test-task",
                retryDelayMs: 5000
            };
            
            const result = tryDeserialize(obj, registrations);
            
            expect(isTaskMissingFieldError(result)).toBe(true);
            expect(result.field).toBe("cronExpression");
            expect(result.message).toContain("Missing required field: cronExpression");
        });

        test("should return TaskMissingFieldError when retryDelayMs field is missing", () => {
            const registrations = createTestRegistrations();
            const obj = {
                name: "test-task",
                cronExpression: "0 * * * *"
            };
            
            const result = tryDeserialize(obj, registrations);
            
            expect(isTaskMissingFieldError(result)).toBe(true);
            expect(result.field).toBe("retryDelayMs");
            expect(result.message).toContain("Missing required field: retryDelayMs");
        });
    });

    describe("TaskInvalidTypeError scenarios", () => {
        test("should return TaskInvalidTypeError for non-string name", () => {
            const registrations = createTestRegistrations();
            const obj = {
                name: 123,
                cronExpression: "0 * * * *",
                retryDelayMs: 5000
            };
            
            const result = tryDeserialize(obj, registrations);
            
            expect(isTaskInvalidTypeError(result)).toBe(true);
            expect(result.field).toBe("name");
            expect(result.expectedType).toBe("string");
            expect(result.actualType).toBe("number");
        });

        test("should return TaskInvalidTypeError for non-string cronExpression", () => {
            const registrations = createTestRegistrations();
            const obj = {
                name: "test-task",
                cronExpression: 123,
                retryDelayMs: 5000
            };
            
            const result = tryDeserialize(obj, registrations);
            
            expect(isTaskInvalidTypeError(result)).toBe(true);
            expect(result.field).toBe("cronExpression");
            expect(result.expectedType).toBe("string");
        });

        test("should return TaskInvalidTypeError for non-numeric retryDelayMs", () => {
            const registrations = createTestRegistrations();
            const obj = {
                name: "test-task",
                cronExpression: "0 * * * *",
                retryDelayMs: "not-a-number"
            };
            
            const result = tryDeserialize(obj, registrations);
            
            expect(isTaskInvalidTypeError(result)).toBe(true);
            expect(result.field).toBe("retryDelayMs");
            expect(result.expectedType).toBe("non-negative number");
        });

        test("should return TaskInvalidTypeError for negative retryDelayMs", () => {
            const registrations = createTestRegistrations();
            const obj = {
                name: "test-task",
                cronExpression: "0 * * * *",
                retryDelayMs: -100
            };
            
            const result = tryDeserialize(obj, registrations);
            
            expect(isTaskInvalidTypeError(result)).toBe(true);
            expect(result.field).toBe("retryDelayMs");
        });

        test("should return TaskInvalidTypeError for infinite retryDelayMs", () => {
            const registrations = createTestRegistrations();
            const obj = {
                name: "test-task",
                cronExpression: "0 * * * *",
                retryDelayMs: Infinity
            };
            
            const result = tryDeserialize(obj, registrations);
            
            expect(isTaskInvalidTypeError(result)).toBe(true);
            expect(result.field).toBe("retryDelayMs");
        });

        test("should return TaskInvalidTypeError for NaN retryDelayMs", () => {
            const registrations = createTestRegistrations();
            const obj = {
                name: "test-task",
                cronExpression: "0 * * * *",
                retryDelayMs: NaN
            };
            
            const result = tryDeserialize(obj, registrations);
            
            expect(isTaskInvalidTypeError(result)).toBe(true);
            expect(result.field).toBe("retryDelayMs");
        });

        test("should return TaskInvalidTypeError for invalid DateTime field", () => {
            const registrations = createTestRegistrations();
            const obj = {
                name: "test-task",
                cronExpression: "0 * * * *",
                retryDelayMs: 5000,
                lastSuccessTime: "not-a-datetime"
            };
            
            const result = tryDeserialize(obj, registrations);
            
            expect(isTaskInvalidTypeError(result)).toBe(true);
            expect(result.field).toBe("lastSuccessTime");
            expect(result.expectedType).toBe("DateTime or undefined");
        });
    });

    describe("TaskInvalidValueError scenarios", () => {
        test("should return TaskInvalidValueError for task name not in registrations", () => {
            const registrations = createTestRegistrations();
            const obj = {
                name: "non-existent-task",
                cronExpression: "0 * * * *",
                retryDelayMs: 5000
            };
            
            const result = tryDeserialize(obj, registrations);
            
            expect(isTaskInvalidValueError(result)).toBe(true);
            expect(result.field).toBe("name");
            expect(result.reason).toBe("task not found in registrations");
        });

        test("should return TaskInvalidValueError for mismatched cronExpression", () => {
            const registrations = createTestRegistrations();
            const obj = {
                name: "test-task",
                cronExpression: "0 0 * * *", // Different from registration
                retryDelayMs: 5000
            };
            
            const result = tryDeserialize(obj, registrations);
            
            expect(isTaskInvalidValueError(result)).toBe(true);
            expect(result.field).toBe("cronExpression");
            expect(result.reason).toContain("does not match registration cron expression");
        });

        test("should return TaskInvalidValueError for mismatched retryDelayMs", () => {
            const registrations = createTestRegistrations();
            const obj = {
                name: "test-task",
                cronExpression: "0 * * * *",
                retryDelayMs: 10000 // Different from registration
            };
            
            const result = tryDeserialize(obj, registrations);
            
            expect(isTaskInvalidValueError(result)).toBe(true);
            expect(result.field).toBe("retryDelayMs");
            expect(result.reason).toContain("does not match registration retry delay");
        });
    });

    describe("Error object properties", () => {
        test("TaskTryDeserializeError base class has correct properties", () => {
            const registrations = createTestRegistrations();
            const result = tryDeserialize(null, registrations);
            
            expect(isTaskTryDeserializeError(result)).toBe(true);
            expect(result.field).toBeDefined();
            expect(result.value).toBeDefined();
            expect(result.expectedType).toBeDefined();
        });

        test("Error classes have correct names", () => {
            const registrations = createTestRegistrations();
            
            const structureError = tryDeserialize(null, registrations);
            expect(structureError.name).toBe("TaskInvalidStructureError");
            
            const missingFieldError = tryDeserialize({}, registrations);
            expect(missingFieldError.name).toBe("TaskMissingFieldError");
        });
    });

    describe("Edge cases with valid input", () => {
        test("should successfully deserialize valid object with required fields only", () => {
            const registrations = createTestRegistrations();
            const obj = {
                name: "test-task",
                cronExpression: "0 * * * *",
                retryDelayMs: 5000
            };
            
            const result = tryDeserialize(obj, registrations);
            
            expect(isTaskTryDeserializeError(result)).toBe(false);
            expect(result.name).toBe("test-task");
        });

        test("should successfully deserialize valid object with DateTime fields", () => {
            const registrations = createTestRegistrations();
            const now = new Date();
            const obj = {
                name: "test-task",
                cronExpression: "0 * * * *",
                retryDelayMs: 5000,
                lastSuccessTime: now,
                lastFailureTime: now,
                lastAttemptTime: now
            };
            
            const result = tryDeserialize(obj, registrations);
            
            expect(isTaskTryDeserializeError(result)).toBe(false);
            expect(result.name).toBe("test-task");
        });
    });
});