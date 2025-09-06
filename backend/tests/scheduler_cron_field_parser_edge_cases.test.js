/**
 * Tests for scheduler cron expression field parser edge cases.
 * Focuses on testing boundary conditions and error scenarios in field parsing.
 */

const { parseField, FIELD_CONFIGS } = require("../src/scheduler/expression/field_parser");

/**
 * Helper function to create a boolean mask from an array of numbers.
 * @param {number[]} numbers - Array of valid numbers
 * @param {number} maxValue - Maximum value (inclusive) for the mask
 * @returns {boolean[]} Boolean mask
 */
function createMask(numbers, maxValue) {
    const mask = new Array(maxValue + 1).fill(false);
    for (const num of numbers) {
        if (num >= 0 && num <= maxValue) {
            mask[num] = true;
        }
    }
    return mask;
}

describe("scheduler cron field parser edge cases", () => {

    describe("basic field parsing", () => {
        test("should parse wildcard '*' correctly for all field types", () => {
            const minuteResult = parseField("*", FIELD_CONFIGS.minute);
            expect(minuteResult).toHaveLength(60);
            expect(minuteResult[0]).toBe(true);
            expect(minuteResult[59]).toBe(true);

            const hourResult = parseField("*", FIELD_CONFIGS.hour);
            expect(hourResult).toHaveLength(24);
            expect(hourResult[0]).toBe(true);
            expect(hourResult[23]).toBe(true);

            const dayResult = parseField("*", FIELD_CONFIGS.day);
            expect(dayResult).toHaveLength(32); // 0-31
            expect(dayResult[0]).toBe(false); // Day 0 is invalid
            expect(dayResult[1]).toBe(true);
            expect(dayResult[31]).toBe(true);

            const monthResult = parseField("*", FIELD_CONFIGS.month);
            expect(monthResult).toHaveLength(13); // 0-12
            expect(monthResult[0]).toBe(false); // Month 0 is invalid
            expect(monthResult[1]).toBe(true);
            expect(monthResult[12]).toBe(true);

            const weekdayResult = parseField("*", FIELD_CONFIGS.weekday);
            expect(weekdayResult).toHaveLength(7);
            expect(weekdayResult[0]).toBe(true);
            expect(weekdayResult[6]).toBe(true);
            expect(weekdayResult).toEqual(createMask([0, 1, 2, 3, 4, 5, 6], 6));
        });

        test("should parse single valid numbers", () => {
            expect(parseField("0", FIELD_CONFIGS.minute)).toEqual(createMask([0], 59));
            expect(parseField("59", FIELD_CONFIGS.minute)).toEqual(createMask([59], 59));
            expect(parseField("23", FIELD_CONFIGS.hour)).toEqual(createMask([23], 23));
            expect(parseField("1", FIELD_CONFIGS.day)).toEqual(createMask([1], 31));
            expect(parseField("31", FIELD_CONFIGS.day)).toEqual(createMask([31], 31));
            expect(parseField("12", FIELD_CONFIGS.month)).toEqual(createMask([12], 12));
            expect(parseField("6", FIELD_CONFIGS.weekday)).toEqual(createMask([6], 6));
        });
    });

    describe("range parsing edge cases", () => {
        test("should parse valid ranges", () => {
            expect(parseField("1-5", FIELD_CONFIGS.minute)).toEqual(createMask([1, 2, 3, 4, 5], 59));
            expect(parseField("0-2", FIELD_CONFIGS.hour)).toEqual(createMask([0, 1, 2], 23));
            expect(parseField("1-3", FIELD_CONFIGS.day)).toEqual(createMask([1, 2, 3], 31));
            expect(parseField("1-1", FIELD_CONFIGS.month)).toEqual(createMask([1], 12)); // Single value range
        });

        test("should throw FieldParseError for invalid range formats", () => {
            expect(() => parseField("1-", FIELD_CONFIGS.minute)).toThrow();
            expect(() => parseField("-5", FIELD_CONFIGS.minute)).toThrow();
            expect(() => parseField("1--5", FIELD_CONFIGS.minute)).toThrow();
            expect(() => parseField("1-2-3", FIELD_CONFIGS.minute)).toThrow();
        });

        test("should throw FieldParseError for ranges with start > end", () => {
            expect(() => parseField("5-3", FIELD_CONFIGS.minute)).toThrow();
            expect(() => parseField("10-5", FIELD_CONFIGS.hour)).toThrow();
        });

        test("should throw FieldParseError for out-of-range values in ranges", () => {
            expect(() => parseField("-1-5", FIELD_CONFIGS.minute)).toThrow();
            expect(() => parseField("0-60", FIELD_CONFIGS.minute)).toThrow();
            expect(() => parseField("25-30", FIELD_CONFIGS.hour)).toThrow();
            expect(() => parseField("0-5", FIELD_CONFIGS.day)).toThrow(); // day starts at 1
            expect(() => parseField("1-32", FIELD_CONFIGS.day)).toThrow();
            expect(() => parseField("0-12", FIELD_CONFIGS.month)).toThrow(); // month starts at 1
            expect(() => parseField("1-13", FIELD_CONFIGS.month)).toThrow();
            expect(() => parseField("-1-6", FIELD_CONFIGS.weekday)).toThrow();
            expect(() => parseField("0-7", FIELD_CONFIGS.weekday)).toThrow();
        });

        test("should throw FieldParseError for non-numeric values in ranges", () => {
            expect(() => parseField("a-5", FIELD_CONFIGS.minute)).toThrow();
            expect(() => parseField("1-b", FIELD_CONFIGS.minute)).toThrow();
            expect(() => parseField("abc-def", FIELD_CONFIGS.minute)).toThrow();
        });
    });

    describe("slash syntax rejection", () => {
        test("should throw FieldParseError for all slash syntax", () => {
            expect(() => parseField("*/5", FIELD_CONFIGS.minute)).toThrow();
            expect(() => parseField("0-10/2", FIELD_CONFIGS.minute)).toThrow();
            expect(() => parseField("1-7/3", FIELD_CONFIGS.day)).toThrow();
            expect(() => parseField("/5", FIELD_CONFIGS.minute)).toThrow();
            expect(() => parseField("*//5", FIELD_CONFIGS.minute)).toThrow();
            expect(() => parseField("*/", FIELD_CONFIGS.minute)).toThrow();
            expect(() => parseField("*//", FIELD_CONFIGS.minute)).toThrow();
            expect(() => parseField("1/2/3", FIELD_CONFIGS.minute)).toThrow();
            expect(() => parseField("*/0", FIELD_CONFIGS.minute)).toThrow();
            expect(() => parseField("*/-1", FIELD_CONFIGS.minute)).toThrow();
            expect(() => parseField("*/abc", FIELD_CONFIGS.minute)).toThrow();
            expect(() => parseField("0-5/10", FIELD_CONFIGS.minute)).toThrow();
        });
    });

    describe("comma-separated list parsing edge cases", () => {
        test("should parse valid comma-separated lists", () => {
            expect(parseField("1,3,5", FIELD_CONFIGS.minute)).toEqual(createMask([1, 3, 5], 59));
            expect(parseField("0,12,23", FIELD_CONFIGS.hour)).toEqual(createMask([0, 12, 23], 23));
            expect(parseField("1,15,31", FIELD_CONFIGS.day)).toEqual(createMask([1, 15, 31], 31));
        });

        test("should remove duplicates and sort results", () => {
            expect(parseField("5,1,3,1,5", FIELD_CONFIGS.minute)).toEqual(createMask([1, 3, 5], 59));
            expect(parseField("10,5,15,5,10", FIELD_CONFIGS.minute)).toEqual(createMask([5, 10, 15], 59));
        });

        test("should handle mixed expressions in comma-separated lists", () => {
            expect(parseField("1,3-5,10", FIELD_CONFIGS.minute)).toEqual(createMask([1, 3, 4, 5, 10], 59));
            expect(parseField("0,30", FIELD_CONFIGS.minute)).toEqual(createMask([0, 30], 59));
            expect(parseField("1-3,0,20,40,45", FIELD_CONFIGS.minute)).toEqual(createMask([0, 1, 2, 3, 20, 40, 45], 59));
        });

        test("should handle whitespace in comma-separated lists", () => {
            expect(parseField("1, 3, 5", FIELD_CONFIGS.minute)).toEqual(createMask([1, 3, 5], 59));
            expect(parseField(" 1 , 3 , 5 ", FIELD_CONFIGS.minute)).toEqual(createMask([1, 3, 5], 59));
        });

        test("should throw errors for invalid items in comma-separated lists", () => {
            expect(() => parseField("1,abc,5", FIELD_CONFIGS.minute)).toThrow();
            expect(() => parseField("1,60,5", FIELD_CONFIGS.minute)).toThrow(); // 60 is out of range for minutes
            expect(() => parseField("1,,5", FIELD_CONFIGS.minute)).toThrow();
        });
    });

    describe("boundary value testing", () => {
        test("should handle boundary values for each field type", () => {
            // Minute field (0-59)
            expect(parseField("0", FIELD_CONFIGS.minute)).toEqual(createMask([0], 59));
            expect(parseField("59", FIELD_CONFIGS.minute)).toEqual(createMask([59], 59));
            expect(() => parseField("-1", FIELD_CONFIGS.minute)).toThrow();
            expect(() => parseField("60", FIELD_CONFIGS.minute)).toThrow();

            // Hour field (0-23)
            expect(parseField("0", FIELD_CONFIGS.hour)).toEqual(createMask([0], 23));
            expect(parseField("23", FIELD_CONFIGS.hour)).toEqual(createMask([23], 23));
            expect(() => parseField("-1", FIELD_CONFIGS.hour)).toThrow();
            expect(() => parseField("24", FIELD_CONFIGS.hour)).toThrow();

            // Day field (1-31)
            expect(parseField("1", FIELD_CONFIGS.day)).toEqual(createMask([1], 31));
            expect(parseField("31", FIELD_CONFIGS.day)).toEqual(createMask([31], 31));
            expect(() => parseField("0", FIELD_CONFIGS.day)).toThrow();
            expect(() => parseField("32", FIELD_CONFIGS.day)).toThrow();

            // Month field (1-12)
            expect(parseField("1", FIELD_CONFIGS.month)).toEqual(createMask([1], 12));
            expect(parseField("12", FIELD_CONFIGS.month)).toEqual(createMask([12], 12));
            expect(() => parseField("0", FIELD_CONFIGS.month)).toThrow();
            expect(() => parseField("13", FIELD_CONFIGS.month)).toThrow();

            // Weekday field (0-6)
            expect(parseField("0", FIELD_CONFIGS.weekday)).toEqual(createMask([0], 6));
            expect(parseField("6", FIELD_CONFIGS.weekday)).toEqual(createMask([6], 6));
            expect(() => parseField("-1", FIELD_CONFIGS.weekday)).toThrow();
            expect(() => parseField("7", FIELD_CONFIGS.weekday)).toThrow();
        });
    });

    describe("error object properties", () => {
        test("should create FieldParseError with correct properties", () => {
            expect(() => parseField("invalid", FIELD_CONFIGS.minute))
                .toThrow(expect.objectContaining({
                    name: "FieldParseError",
                    fieldValue: "invalid",
                    fieldName: "minute"
                }));
        });

        test("should have informative error messages", () => {
            // Test out of range minute
            expect(() => parseField("60", FIELD_CONFIGS.minute))
                .toThrow(/out of range/);

            // Test invalid range
            expect(() => parseField("5-3", FIELD_CONFIGS.minute))
                .toThrow(/wrap-around ranges not supported/);

            // Test invalid step - now expects slash syntax rejection message
            expect(() => parseField("*/0", FIELD_CONFIGS.minute))
                .toThrow(/slash syntax not supported.*POSIX violation/);
        });
    });

    describe("malformed input edge cases", () => {
        test("should handle empty string", () => {
            expect(() => parseField("", FIELD_CONFIGS.minute)).toThrow();
        });

        test("should handle special characters", () => {
            expect(() => parseField("@", FIELD_CONFIGS.minute)).toThrow();
            expect(() => parseField("#", FIELD_CONFIGS.minute)).toThrow();
            expect(() => parseField("$", FIELD_CONFIGS.minute)).toThrow();
            expect(() => parseField("%", FIELD_CONFIGS.minute)).toThrow();
        });

        test("should handle extremely long strings", () => {
            const longString = "1".repeat(1000);
            expect(() => parseField(longString, FIELD_CONFIGS.minute)).toThrow();
        });

        test("should handle decimal numbers (parseInt behavior)", () => {
            // parseInt("1.5") returns 1, parseInt("1.0") returns 1
            expect(parseField("1.5", FIELD_CONFIGS.minute)).toEqual(createMask([1], 59));
            expect(parseField("1.0", FIELD_CONFIGS.minute)).toEqual(createMask([1], 59));
        });

        test("should handle scientific notation (parseInt behavior)", () => {
            // parseInt handles scientific notation by parsing the integer part
            expect(parseField("1e10", FIELD_CONFIGS.minute)).toEqual(createMask([1], 59));
            expect(parseField("2e5", FIELD_CONFIGS.minute)).toEqual(createMask([2], 59));
            // "1e-5" gets parsed as range "1e" to "5" (parseInt("1e") = 1, parseInt("5") = 5)
            expect(parseField("1e-5", FIELD_CONFIGS.minute)).toEqual(createMask([1, 2, 3, 4, 5], 59));
        });
    });
});