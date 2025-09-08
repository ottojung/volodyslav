/**
 * Tests for DateTime tryDeserialize function.
 */

const { 
    tryDeserialize, 
    fromISOString, 
    isDateTimeTryDeserializeError,
    isDateTime
} = require("../src/datetime");

describe("DateTime tryDeserialize", () => {
    const validISOString = "2022-01-01T00:00:00.000Z";
    const validDateTime = fromISOString(validISOString);

    describe("valid inputs", () => {
        test("should pass through existing DateTime objects", () => {
            const result = tryDeserialize(validDateTime);
            
            expect(isDateTimeTryDeserializeError(result)).toBe(false);
            expect(isDateTime(result)).toBe(true);
            expect(result.toISOString()).toBe(validISOString);
        });

        test("should deserialize valid ISO strings", () => {
            const result = tryDeserialize(validISOString);
            
            expect(isDateTimeTryDeserializeError(result)).toBe(false);
            expect(isDateTime(result)).toBe(true);
            expect(result.toISOString()).toBe(validISOString);
        });

        test("should deserialize JSON-parsed DateTime objects", () => {
            // Simulate what happens when a DateTime gets JSON.stringify'd and parsed
            const serialized = JSON.stringify({ dt: validDateTime });
            const parsed = JSON.parse(serialized);
            
            const result = tryDeserialize(parsed.dt);
            
            expect(isDateTimeTryDeserializeError(result)).toBe(false);
            expect(isDateTime(result)).toBe(true);
            expect(result.toISOString()).toBe(validISOString);
        });

        test("should deserialize objects with toISOString method", () => {
            const mockDate = {
                toISOString: () => validISOString
            };
            
            const result = tryDeserialize(mockDate);
            
            expect(isDateTimeTryDeserializeError(result)).toBe(false);
            expect(isDateTime(result)).toBe(true);
            expect(result.toISOString()).toBe(validISOString);
        });
    });

    describe("invalid inputs", () => {
        test("should return error for null", () => {
            const result = tryDeserialize(null);
            
            expect(isDateTimeTryDeserializeError(result)).toBe(true);
            expect(result.message).toContain("DateTime cannot be null");
        });

        test("should return error for undefined", () => {
            const result = tryDeserialize(undefined);
            
            expect(isDateTimeTryDeserializeError(result)).toBe(true);
            expect(result.message).toContain("DateTime cannot be undefined");
        });

        test("should return error for invalid ISO string", () => {
            const result = tryDeserialize("not-a-date");
            
            expect(isDateTimeTryDeserializeError(result)).toBe(true);
            expect(result.message).toContain("Invalid ISO string");
        });

        test("should return error for numbers", () => {
            const result = tryDeserialize(123);
            
            expect(isDateTimeTryDeserializeError(result)).toBe(true);
            expect(result.message).toContain("Cannot deserialize number to DateTime");
        });

        test("should return error for arrays", () => {
            const result = tryDeserialize([]);
            
            expect(isDateTimeTryDeserializeError(result)).toBe(true);
            expect(result.message).toContain("Cannot deserialize array to DateTime");
        });

        test("should return error for plain objects without DateTime structure", () => {
            const result = tryDeserialize({ foo: "bar" });
            
            expect(isDateTimeTryDeserializeError(result)).toBe(true);
            expect(result.message).toContain("Cannot deserialize object to DateTime");
        });

        test("should return error for object with invalid _luxonDateTime", () => {
            const result = tryDeserialize({ _luxonDateTime: "invalid-date" });
            
            expect(isDateTimeTryDeserializeError(result)).toBe(true);
            expect(result.message).toContain("Invalid DateTime object with invalid ISO string");
        });

        test("should return error for object with toISOString that throws", () => {
            const mockDate = {
                toISOString: () => { throw new Error("Mock error"); }
            };
            
            const result = tryDeserialize(mockDate);
            
            expect(isDateTimeTryDeserializeError(result)).toBe(true);
            expect(result.message).toContain("Failed to get ISO string from object");
        });
    });

    describe("error object properties", () => {
        test("should include the original value in error", () => {
            const invalidValue = { foo: "bar" };
            const result = tryDeserialize(invalidValue);
            
            expect(isDateTimeTryDeserializeError(result)).toBe(true);
            expect(result.value).toBe(invalidValue);
        });
    });
});