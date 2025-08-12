/**
 * Tests for runtime state structure module.
 */

const structure = require("../src/runtime_state_storage/structure");
const { make: makeDatetime } = require("../src/datetime");

describe("runtime_state_storage/structure", () => {
    let datetime;

    beforeEach(() => {
        datetime = makeDatetime();
    });

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
    });

    describe("serialize", () => {
        test("serializes runtime state to plain object", () => {
            const startTime = datetime.fromISOString("2025-01-01T10:00:00.000Z");
            const state = { version: structure.RUNTIME_STATE_VERSION, startTime, tasks: [] };

            const result = structure.serialize(state);
            expect(result).toEqual({
                version: structure.RUNTIME_STATE_VERSION,
                startTime: "2025-01-01T10:00:00.000Z",
                tasks: []
            });
        });
    });

    describe("makeDefault", () => {
        test("creates default runtime state with current time", () => {
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
    });
});
