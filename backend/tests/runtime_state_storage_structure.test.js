/**
 * Tests for runtime state structure module.
 */

const structure = require("../src/runtime_state_storage/structure");
const { fromISOString, toISOString, make: makeDatetime } = require("../src/datetime");

describe("runtime_state_storage/structure", () => {

    describe("tryDeserialize", () => {
        test("deserializes valid runtime state object", () => {
            const validObject = {
                version: structure.RUNTIME_STATE_VERSION,
                startTime: "2025-01-01T10:00:00.000Z",
                tasks: []
            };

            const result = structure.tryDeserialize(validObject);
            expect(structure.isTryDeserializeError(result)).toBe(false);
            expect(result.state).toMatchObject({
                version: structure.RUNTIME_STATE_VERSION,
                startTime: expect.any(Object),
                tasks: []
            });
        });

        test("returns error for null input", () => {
            const result = structure.tryDeserialize(null);
            expect(structure.isTryDeserializeError(result)).toBe(true);
            expect(result).toBeInstanceOf(structure.InvalidStructureError);
            expect(result.message).toContain("non-null object");
        });

        test("returns error for non-object input", () => {
            const result = structure.tryDeserialize("not an object");
            expect(structure.isTryDeserializeError(result)).toBe(true);
            expect(result).toBeInstanceOf(structure.InvalidStructureError);
        });

        test("returns error for missing startTime field", () => {
            const invalidObject = {};
            const result = structure.tryDeserialize(invalidObject);
            expect(structure.isTryDeserializeError(result)).toBe(true);
            expect(result).toBeInstanceOf(structure.MissingFieldError);
            expect(result.field).toBe("startTime");
        });

        test("returns error for non-string startTime", () => {
            const invalidObject = { startTime: 123 };
            const result = structure.tryDeserialize(invalidObject);
            expect(structure.isTryDeserializeError(result)).toBe(true);
            expect(result).toBeInstanceOf(structure.InvalidTypeError);
            expect(result.field).toBe("startTime");
            expect(result.expectedType).toBe("string");
        });

        test("returns error for invalid ISO string", () => {
            const invalidObject = { startTime: "not-a-valid-date" };
            const result = structure.tryDeserialize(invalidObject);
            expect(structure.isTryDeserializeError(result)).toBe(true);
            expect(result).toBeInstanceOf(structure.InvalidTypeError);
            expect(result.field).toBe("startTime");
            expect(result.expectedType).toBe("valid ISO string");
        });

        test("returns error for unsupported version", () => {
            const result = structure.tryDeserialize({ version: 999, startTime: "2025-01-01T10:00:00.000Z", tasks: [] });
            expect(structure.isTryDeserializeError(result)).toBe(true);
            expect(result).toBeInstanceOf(structure.UnsupportedVersionError);
        });

        test("returns error for non-array tasks field", () => {
            const result = structure.tryDeserialize({
                version: structure.RUNTIME_STATE_VERSION,
                startTime: "2025-01-01T10:00:00.000Z",
                tasks: "not-an-array",
            });
            expect(structure.isTryDeserializeError(result)).toBe(true);
            expect(result).toBeInstanceOf(structure.TasksFieldInvalidStructureError);
        });

        test("deserializes tasks with all optional fields", () => {
            const obj = {
                version: structure.RUNTIME_STATE_VERSION,
                startTime: "2025-01-01T10:00:00.000Z",
                tasks: [
                    {
                        name: "my-task",
                        cronExpression: "0 * * * *",
                        retryDelayMs: 5000,
                        lastSuccessTime: "2025-01-01T09:00:00.000Z",
                        lastFailureTime: "2025-01-01T08:00:00.000Z",
                        lastAttemptTime: "2025-01-01T09:30:00.000Z",
                        pendingRetryUntil: "2025-01-01T10:05:00.000Z",
                        schedulerIdentifier: "scheduler-1",
                    },
                ],
            };

            const result = structure.tryDeserialize(obj);
            expect(structure.isTryDeserializeError(result)).toBe(false);
            expect(result.taskErrors).toHaveLength(0);
            const task = result.state.tasks[0];
            expect(task.name).toBe("my-task");
            expect(task.cronExpression).toBe("0 * * * *");
            expect(task.retryDelayMs).toBe(5000);
            expect(toISOString(task.lastSuccessTime)).toBe("2025-01-01T09:00:00.000Z");
            expect(toISOString(task.lastFailureTime)).toBe("2025-01-01T08:00:00.000Z");
            expect(toISOString(task.lastAttemptTime)).toBe("2025-01-01T09:30:00.000Z");
            expect(toISOString(task.pendingRetryUntil)).toBe("2025-01-01T10:05:00.000Z");
            expect(task.schedulerIdentifier).toBe("scheduler-1");
        });

        test("collects task errors without failing the whole deserialization", () => {
            const obj = {
                version: structure.RUNTIME_STATE_VERSION,
                startTime: "2025-01-01T10:00:00.000Z",
                tasks: [
                    { name: "valid-task", cronExpression: "0 * * * *", retryDelayMs: 0 },
                    { name: "bad-task" },          // missing cronExpression
                    null,                           // not an object
                ],
            };

            const result = structure.tryDeserialize(obj);
            expect(structure.isTryDeserializeError(result)).toBe(false);
            expect(result.state.tasks).toHaveLength(1);
            expect(result.state.tasks[0].name).toBe("valid-task");
            expect(result.taskErrors.length).toBeGreaterThan(0);
            expect(result.taskErrors.every((e) => structure.isTryDeserializeTaskError(e))).toBe(true);
        });

        test("returns task error for duplicate task names", () => {
            const obj = {
                version: structure.RUNTIME_STATE_VERSION,
                startTime: "2025-01-01T10:00:00.000Z",
                tasks: [
                    { name: "dup", cronExpression: "0 * * * *", retryDelayMs: 0 },
                    { name: "dup", cronExpression: "1 * * * *", retryDelayMs: 0 },
                ],
            };

            const result = structure.tryDeserialize(obj);
            expect(structure.isTryDeserializeError(result)).toBe(false);
            // Only first occurrence is kept; second is a task error.
            expect(result.state.tasks).toHaveLength(1);
            expect(result.taskErrors).toHaveLength(1);
            expect(result.taskErrors[0]).toBeInstanceOf(structure.TaskInvalidValueError);
        });

        test("returns task error for negative retryDelayMs", () => {
            const obj = {
                version: structure.RUNTIME_STATE_VERSION,
                startTime: "2025-01-01T10:00:00.000Z",
                tasks: [{ name: "t", cronExpression: "* * * * *", retryDelayMs: -1 }],
            };

            const result = structure.tryDeserialize(obj);
            expect(structure.isTryDeserializeError(result)).toBe(false);
            expect(result.state.tasks).toHaveLength(0);
            expect(result.taskErrors).toHaveLength(1);
            expect(result.taskErrors[0]).toBeInstanceOf(structure.TaskInvalidValueError);
        });

        test("migrates version 1 state to version 2 (sets tasks to empty array)", () => {
            const obj = { version: 1, startTime: "2025-01-01T10:00:00.000Z" };

            const result = structure.tryDeserialize(obj);
            expect(structure.isTryDeserializeError(result)).toBe(false);
            expect(result.migrated).toBe(true);
            expect(result.state.version).toBe(structure.RUNTIME_STATE_VERSION);
            expect(result.state.tasks).toEqual([]);
        });
    });

    describe("serialize", () => {
        test("serializes runtime state to plain object", () => {
            const startTime = fromISOString("2025-01-01T10:00:00.000Z");
            const state = { version: structure.RUNTIME_STATE_VERSION, startTime, tasks: [] };

            const result = structure.serialize(state);
            expect(result).toEqual({
                version: structure.RUNTIME_STATE_VERSION,
                startTime: "2025-01-01T10:00:00.000Z",
                tasks: []
            });
        });

        test("serializes tasks with all optional fields", () => {
            const startTime = fromISOString("2025-01-01T10:00:00.000Z");
            const state = {
                version: structure.RUNTIME_STATE_VERSION,
                startTime,
                tasks: [
                    {
                        name: "my-task",
                        cronExpression: "0 * * * *",
                        retryDelayMs: 3000,
                        lastSuccessTime: fromISOString("2025-01-01T09:00:00.000Z"),
                        lastFailureTime: fromISOString("2025-01-01T08:00:00.000Z"),
                        lastAttemptTime: fromISOString("2025-01-01T09:30:00.000Z"),
                        pendingRetryUntil: fromISOString("2025-01-01T10:05:00.000Z"),
                        schedulerIdentifier: "sched-A",
                    },
                ],
            };

            const result = structure.serialize(state);
            expect(result.tasks).toHaveLength(1);
            const t = result.tasks[0];
            expect(t.name).toBe("my-task");
            expect(t.lastSuccessTime).toBe("2025-01-01T09:00:00.000Z");
            expect(t.lastFailureTime).toBe("2025-01-01T08:00:00.000Z");
            expect(t.lastAttemptTime).toBe("2025-01-01T09:30:00.000Z");
            expect(t.pendingRetryUntil).toBe("2025-01-01T10:05:00.000Z");
            expect(t.schedulerIdentifier).toBe("sched-A");
        });

        test("serializes tasks sorted by name", () => {
            const startTime = fromISOString("2025-01-01T10:00:00.000Z");
            const state = {
                version: structure.RUNTIME_STATE_VERSION,
                startTime,
                tasks: [
                    { name: "z-task", cronExpression: "* * * * *", retryDelayMs: 0 },
                    { name: "a-task", cronExpression: "* * * * *", retryDelayMs: 0 },
                    { name: "m-task", cronExpression: "* * * * *", retryDelayMs: 0 },
                ],
            };

            const result = structure.serialize(state);
            expect(result.tasks.map((t) => t.name)).toEqual(["a-task", "m-task", "z-task"]);
        });

        test("round-trips through serialize then tryDeserialize", () => {
            const startTime = fromISOString("2025-03-15T12:30:00.000Z");
            const state = {
                version: structure.RUNTIME_STATE_VERSION,
                startTime,
                tasks: [
                    {
                        name: "task-1",
                        cronExpression: "0 9 * * *",
                        retryDelayMs: 60000,
                        lastSuccessTime: fromISOString("2025-03-15T09:00:00.000Z"),
                        schedulerIdentifier: "worker-1",
                    },
                ],
            };

            const serialized = structure.serialize(state);
            const restored = structure.tryDeserialize(serialized);
            expect(structure.isTryDeserializeError(restored)).toBe(false);
            expect(restored.state.tasks).toHaveLength(1);
            expect(restored.state.tasks[0].name).toBe("task-1");
            expect(restored.state.tasks[0].schedulerIdentifier).toBe("worker-1");
            expect(toISOString(restored.state.tasks[0].lastSuccessTime)).toBe("2025-03-15T09:00:00.000Z");
        });
    });

    describe("makeDefault", () => {
        test("creates default runtime state with current time", () => {
            const datetime = makeDatetime();
            const now = datetime.now();
            datetime.now = jest.fn().mockReturnValue(now);

            const result = structure.makeDefault(datetime);
            expect(result).toEqual({
                version: structure.RUNTIME_STATE_VERSION,
                startTime: now,
                tasks: []
            });
            expect(datetime.now).toHaveBeenCalledTimes(1);
        });
    });

    describe("error type guards", () => {
        test("isTryDeserializeError identifies base error type", () => {
            const error = new structure.TryDeserializeError("test", "field", "value", "type");
            expect(structure.isTryDeserializeError(error)).toBe(true);
            expect(structure.isTryDeserializeError(new Error("regular error"))).toBe(false);
        });

        test("TryDeserializeError includes all required fields", () => {
            const error = new structure.TryDeserializeError("test message", "testField", "testValue", "testType");
            expect(error.message).toBe("test message");
            expect(error.field).toBe("testField");
            expect(error.value).toBe("testValue");
            expect(error.expectedType).toBe("testType");
            expect(error.name).toBe("TryDeserializeError");
        });

        test("MissingFieldError extends TryDeserializeError", () => {
            const error = new structure.MissingFieldError("missingField");
            expect(structure.isTryDeserializeError(error)).toBe(true);
            expect(error.name).toBe("MissingFieldError");
            expect(error.field).toBe("missingField");
        });

        test("InvalidTypeError extends TryDeserializeError", () => {
            const error = new structure.InvalidTypeError("field", "value", "expectedType");
            expect(structure.isTryDeserializeError(error)).toBe(true);
            expect(error.name).toBe("InvalidTypeError");
            expect(error.field).toBe("field");
            expect(error.value).toBe("value");
            expect(error.expectedType).toBe("expectedType");
        });

        test("InvalidStructureError extends TryDeserializeError", () => {
            const error = new structure.InvalidStructureError("message", "value");
            expect(structure.isTryDeserializeError(error)).toBe(true);
            expect(error.name).toBe("InvalidStructureError");
            expect(error.field).toBe("root");
            expect(error.value).toBe("value");
        });

        test("RuntimeStateFileParseError has correct properties", () => {
            const cause = new SyntaxError("Invalid JSON");
            const error = new structure.RuntimeStateFileParseError("Parse failed", "/path/file.json", cause);
            expect(structure.isRuntimeStateFileParseError(error)).toBe(true);
            expect(error.name).toBe("RuntimeStateFileParseError");
            expect(error.message).toBe("Parse failed");
            expect(error.filepath).toBe("/path/file.json");
            expect(error.cause).toBe(cause);
            expect(structure.isRuntimeStateFileParseError(new Error("regular error"))).toBe(false);
        });

        test("RuntimeStateCorruptedError has correct properties", () => {
            const deserializeError = new structure.MissingFieldError("startTime");
            const error = new structure.RuntimeStateCorruptedError(deserializeError, "/path/file.json");
            expect(structure.isRuntimeStateCorruptedError(error)).toBe(true);
            expect(error.name).toBe("RuntimeStateCorruptedError");
            expect(error.message).toContain("Runtime state is corrupted");
            expect(error.location).toBe("/path/file.json");
            expect(error.deserializeError).toBe(deserializeError);
            expect(structure.isRuntimeStateCorruptedError(new Error("regular error"))).toBe(false);
        });
    });
});
