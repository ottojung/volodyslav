/**
 * Integration test demonstrating the fixed DateTime deserialization issue.
 * This test shows the real-world scenario where tasks get serialized,
 * JSON-stringified, parsed, and then deserialized.
 */

const { Duration } = require("luxon");
const { parseCronExpression } = require("../src/scheduler/expression");
const { serialize, tryDeserialize } = require("../src/scheduler/task/serialization");
const { makeTask } = require("../src/scheduler/task/structure");
const { isTaskTryDeserializeError } = require("../src/scheduler/task/serialization_errors");
const { fromISOString, isDateTime } = require("../src/datetime");

describe("scheduler task serialization roundtrip (real-world scenario)", () => {
    
    function createTestRegistrations() {
        const registrations = new Map();
        registrations.set("test-task", {
            parsedCron: parseCronExpression("0 * * * *"),
            callback: () => Promise.resolve(),
            retryDelay: Duration.fromMillis(5000),
        });
        return registrations;
    }

    test("should handle complete serialize -> JSON stringify -> parse -> deserialize cycle", () => {
        const registrations = createTestRegistrations();
        
        // Step 1: Create a task with DateTime fields
        const originalTask = makeTask(
            "test-task",
            parseCronExpression("0 * * * *"),
            () => Promise.resolve(),
            Duration.fromMillis(5000),
            fromISOString("2022-01-01T10:00:00.000Z"), // lastSuccessTime
            fromISOString("2022-01-01T09:00:00.000Z"), // lastFailureTime
            fromISOString("2022-01-01T11:00:00.000Z"), // lastAttemptTime
            fromISOString("2022-01-01T12:00:00.000Z"), // pendingRetryUntil
            "scheduler-instance-123"
        );

        // Step 2: Serialize the task (what the scheduler does internally)
        const serializedTask = serialize(originalTask);

        // Verify that serialized task has DateTime objects
        expect(isDateTime(serializedTask.lastSuccessTime)).toBe(true);
        expect(isDateTime(serializedTask.lastFailureTime)).toBe(true);
        expect(isDateTime(serializedTask.lastAttemptTime)).toBe(true);
        expect(isDateTime(serializedTask.pendingRetryUntil)).toBe(true);

        // Step 3: Convert to JSON (what happens when saving to disk/database)
        const jsonString = JSON.stringify(serializedTask);
        
        // Step 4: Parse from JSON (what happens when loading from disk/database)
        const parsedFromJson = JSON.parse(jsonString);

        // Verify that parsed object no longer has DateTime objects (they become plain objects)
        expect(isDateTime(parsedFromJson.lastSuccessTime)).toBe(false);
        expect(isDateTime(parsedFromJson.lastFailureTime)).toBe(false);
        expect(isDateTime(parsedFromJson.lastAttemptTime)).toBe(false);
        expect(isDateTime(parsedFromJson.pendingRetryUntil)).toBe(false);

        // Step 5: Deserialize back to a Task (what the scheduler does when loading)
        const deserializedTask = tryDeserialize(parsedFromJson, registrations);

        // Verify that deserialization succeeded
        expect(isTaskTryDeserializeError(deserializedTask)).toBe(false);

        // Verify that all DateTime fields are properly restored
        expect(isDateTime(deserializedTask.lastSuccessTime)).toBe(true);
        expect(deserializedTask.lastSuccessTime.toISOString()).toBe("2022-01-01T10:00:00.000Z");
        
        expect(isDateTime(deserializedTask.lastFailureTime)).toBe(true);
        expect(deserializedTask.lastFailureTime.toISOString()).toBe("2022-01-01T09:00:00.000Z");
        
        expect(isDateTime(deserializedTask.lastAttemptTime)).toBe(true);
        expect(deserializedTask.lastAttemptTime.toISOString()).toBe("2022-01-01T11:00:00.000Z");
        
        expect(isDateTime(deserializedTask.pendingRetryUntil)).toBe(true);
        expect(deserializedTask.pendingRetryUntil.toISOString()).toBe("2022-01-01T12:00:00.000Z");

        // Verify other fields are preserved
        expect(deserializedTask.name).toBe("test-task");
        expect(deserializedTask.schedulerIdentifier).toBe("scheduler-instance-123");
    });

    test("should handle partial DateTime fields in roundtrip", () => {
        const registrations = createTestRegistrations();
        
        // Create a task with only some DateTime fields
        const originalTask = makeTask(
            "test-task",
            parseCronExpression("0 * * * *"),
            () => Promise.resolve(),
            Duration.fromMillis(5000),
            fromISOString("2022-01-01T10:00:00.000Z"), // lastSuccessTime
            undefined, // lastFailureTime
            fromISOString("2022-01-01T11:00:00.000Z"), // lastAttemptTime
            undefined, // pendingRetryUntil
            undefined  // schedulerIdentifier
        );

        // Complete roundtrip
        const serializedTask = serialize(originalTask);
        const jsonString = JSON.stringify(serializedTask);
        const parsedFromJson = JSON.parse(jsonString);
        const deserializedTask = tryDeserialize(parsedFromJson, registrations);

        // Verify deserialization
        expect(isTaskTryDeserializeError(deserializedTask)).toBe(false);
        
        expect(isDateTime(deserializedTask.lastSuccessTime)).toBe(true);
        expect(deserializedTask.lastSuccessTime.toISOString()).toBe("2022-01-01T10:00:00.000Z");
        
        expect(deserializedTask.lastFailureTime).toBe(undefined);
        
        expect(isDateTime(deserializedTask.lastAttemptTime)).toBe(true);
        expect(deserializedTask.lastAttemptTime.toISOString()).toBe("2022-01-01T11:00:00.000Z");
        
        expect(deserializedTask.pendingRetryUntil).toBe(undefined);
        expect(deserializedTask.schedulerIdentifier).toBe(undefined);
    });

    test("should demonstrate the problem was fixed (before this fix, the test would fail)", () => {
        // This test demonstrates what would have failed before the fix
        const registrations = createTestRegistrations();
        
        // Simulate a JSON-parsed task (as would come from storage)
        const jsonParsedTask = {
            name: "test-task",
            cronExpression: "0 * * * *",
            retryDelayMs: 5000,
            lastSuccessTime: {
                "_luxonDateTime": "2022-01-01T10:00:00.000+00:00"
            },
            lastFailureTime: {
                "_luxonDateTime": "2022-01-01T09:00:00.000+00:00"  
            }
        };

        // Before the fix: This would have failed because the old code
        // expected DateTime objects but got plain objects
        // After the fix: This should work because tryDeserialize now
        // properly handles JSON-parsed DateTime objects
        const result = tryDeserialize(jsonParsedTask, registrations);

        expect(isTaskTryDeserializeError(result)).toBe(false);
        expect(isDateTime(result.lastSuccessTime)).toBe(true);
        expect(result.lastSuccessTime.toISOString()).toBe("2022-01-01T10:00:00.000Z");
        expect(isDateTime(result.lastFailureTime)).toBe(true);
        expect(result.lastFailureTime.toISOString()).toBe("2022-01-01T09:00:00.000Z");
    });
});