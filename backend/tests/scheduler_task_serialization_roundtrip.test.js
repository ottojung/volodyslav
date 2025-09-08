/**
 * Integration test demonstrating the fixed DateTime deserialization issue.
 * This test shows the real-world scenario where tasks get serialized,
 * JSON-stringified, parsed, and then deserialized.
 */

const { fromMilliseconds } = require("../src/datetime");
const { parseCronExpression } = require("../src/scheduler/expression");
const { serialize, tryDeserialize } = require("../src/scheduler/task/serialization");
const { makeTask, createStateFromProperties, getLastSuccessTime, getLastFailureTime, getLastAttemptTime, getPendingRetryUntil, getSchedulerIdentifier } = require("../src/scheduler/task/structure");
const { isTaskTryDeserializeError } = require("../src/scheduler/task/serialization_errors");
const { fromISOString, isDateTime } = require("../src/datetime");

describe("scheduler task serialization roundtrip (real-world scenario)", () => {
    
    function createTestRegistrations() {
        const registrations = new Map();
        registrations.set("test-task", {
            parsedCron: parseCronExpression("0 * * * *"),
            callback: () => Promise.resolve(),
            retryDelay: fromMilliseconds(5000),
        });
        return registrations;
    }

    test("should handle complete serialize -> JSON stringify -> parse -> deserialize cycle", () => {
        const registrations = createTestRegistrations();
        
        // Test AwaitingRetry state (which has pendingRetryUntil and lastFailureTime)
        const lastFailureTime = fromISOString("2022-01-01T09:00:00.000Z");
        const pendingRetryUntil = fromISOString("2022-01-01T12:00:00.000Z");

        const state = createStateFromProperties(
            undefined, // lastSuccessTime - not compatible with AwaitingRetry
            lastFailureTime,
            undefined, // lastAttemptTime - not compatible with AwaitingRetry
            pendingRetryUntil,
            undefined  // schedulerIdentifier - not compatible with AwaitingRetry
        );

        const originalTask = makeTask(
            "test-task",
            parseCronExpression("0 * * * *"),
            () => Promise.resolve(),
            fromMilliseconds(5000),
            state
        );

        // Step 2: Serialize the task (what the scheduler does internally)
        const serializedTask = serialize(originalTask);

        // Verify that serialized task has DateTime objects (SerializedTask format should be preserved)
        // Only the fields available in AwaitingRetry state should be present
        expect(serializedTask.lastSuccessTime).toBe(undefined);
        expect(isDateTime(serializedTask.lastFailureTime)).toBe(true);
        expect(serializedTask.lastAttemptTime).toBe(undefined);
        expect(isDateTime(serializedTask.pendingRetryUntil)).toBe(true);
        expect(serializedTask.schedulerIdentifier).toBe(undefined);

        // Step 3: Convert to JSON (what happens when saving to disk/database)
        const jsonString = JSON.stringify(serializedTask);
        
        // Step 4: Parse from JSON (what happens when loading from disk/database)
        const parsedFromJson = JSON.parse(jsonString);

        // Verify that parsed object no longer has DateTime objects (they become plain objects)
        expect(parsedFromJson.lastSuccessTime).toBe(undefined);
        expect(isDateTime(parsedFromJson.lastFailureTime)).toBe(false);
        expect(parsedFromJson.lastAttemptTime).toBe(undefined);
        expect(isDateTime(parsedFromJson.pendingRetryUntil)).toBe(false);

        // Step 5: Deserialize back to a Task (what the scheduler does when loading)
        const deserializedTask = tryDeserialize(parsedFromJson, registrations);

        // Verify that deserialization succeeded
        expect(isTaskTryDeserializeError(deserializedTask)).toBe(false);

        // Verify that DateTime fields are properly restored using helper functions
        expect(getLastSuccessTime(deserializedTask)).toBe(undefined);
        
        expect(isDateTime(getLastFailureTime(deserializedTask))).toBe(true);
        expect(getLastFailureTime(deserializedTask).toISOString()).toBe("2022-01-01T09:00:00.000Z");
        
        expect(getLastAttemptTime(deserializedTask)).toBe(undefined);
        
        expect(isDateTime(getPendingRetryUntil(deserializedTask))).toBe(true);
        expect(getPendingRetryUntil(deserializedTask).toISOString()).toBe("2022-01-01T12:00:00.000Z");

        // Verify other fields are preserved
        expect(deserializedTask.name).toBe("test-task");
        expect(getSchedulerIdentifier(deserializedTask)).toBe(undefined);
    });

    test("should handle partial DateTime fields in roundtrip", () => {
        const registrations = createTestRegistrations();
        
        // Create a task with only some DateTime fields using new state structure
        const lastSuccessTime = fromISOString("2022-01-01T10:00:00.000Z");
        const lastAttemptTime = fromISOString("2022-01-01T11:00:00.000Z");

        const state = createStateFromProperties(
            lastSuccessTime,
            undefined, // lastFailureTime
            lastAttemptTime,
            undefined, // pendingRetryUntil
            undefined  // schedulerIdentifier
        );

        const originalTask = makeTask(
            "test-task",
            parseCronExpression("0 * * * *"),
            () => Promise.resolve(),
            fromMilliseconds(5000),
            state
        );

        // Complete roundtrip
        const serializedTask = serialize(originalTask);
        const jsonString = JSON.stringify(serializedTask);
        const parsedFromJson = JSON.parse(jsonString);
        const deserializedTask = tryDeserialize(parsedFromJson, registrations);

        // Verify deserialization
        expect(isTaskTryDeserializeError(deserializedTask)).toBe(false);
        
        expect(isDateTime(getLastSuccessTime(deserializedTask))).toBe(true);
        expect(getLastSuccessTime(deserializedTask).toISOString()).toBe("2022-01-01T10:00:00.000Z");
        
        expect(getLastFailureTime(deserializedTask)).toBe(undefined);
        
        expect(isDateTime(getLastAttemptTime(deserializedTask))).toBe(true);
        expect(getLastAttemptTime(deserializedTask).toISOString()).toBe("2022-01-01T11:00:00.000Z");
        
        expect(getPendingRetryUntil(deserializedTask)).toBe(undefined);
        expect(getSchedulerIdentifier(deserializedTask)).toBe(undefined);
    });

    test("should demonstrate the problem was fixed (before this fix, the test would fail)", () => {
        // This test demonstrates what would have failed before the fix
        const registrations = createTestRegistrations();
        
        // Simulate a JSON-parsed task (as would come from storage)
        // This represents an AwaitingRun state with lastSuccessTime and lastAttemptTime
        const jsonParsedTask = {
            name: "test-task",
            cronExpression: "0 * * * *",
            retryDelayMs: 5000,
            lastSuccessTime: {
                "_luxonDateTime": "2022-01-01T10:00:00.000+00:00"
            },
            lastAttemptTime: {
                "_luxonDateTime": "2022-01-01T11:00:00.000+00:00"  
            }
        };

        // Before the fix: This would have failed because the old code
        // expected DateTime objects but got plain objects
        // After the fix: This should work because tryDeserialize now
        // properly handles JSON-parsed DateTime objects
        const result = tryDeserialize(jsonParsedTask, registrations);

        expect(isTaskTryDeserializeError(result)).toBe(false);
        expect(isDateTime(getLastSuccessTime(result))).toBe(true);
        expect(getLastSuccessTime(result).toISOString()).toBe("2022-01-01T10:00:00.000Z");
        expect(isDateTime(getLastAttemptTime(result))).toBe(true);
        expect(getLastAttemptTime(result).toISOString()).toBe("2022-01-01T11:00:00.000Z");
    });
});