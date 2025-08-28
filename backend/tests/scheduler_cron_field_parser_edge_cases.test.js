/**
 * Tests for scheduler cron expression field parser edge cases.
 * Focuses on testing boundary conditions and error scenarios in field parsing.
 */

const { parseField, FIELD_CONFIGS } = require("../src/scheduler/expression/field_parser");

describe("scheduler cron field parser edge cases", () => {

    describe("basic field parsing", () => {
        test("should parse wildcard '*' correctly for all field types", () => {
            const minuteResult = parseField("*", FIELD_CONFIGS.minute);
            expect(minuteResult).toHaveLength(60);
            expect(minuteResult[0]).toBe(0);
            expect(minuteResult[59]).toBe(59);

            const hourResult = parseField("*", FIELD_CONFIGS.hour);
            expect(hourResult).toHaveLength(24);
            expect(hourResult[0]).toBe(0);
            expect(hourResult[23]).toBe(23);

            const dayResult = parseField("*", FIELD_CONFIGS.day);
            expect(dayResult).toHaveLength(31);
            expect(dayResult[0]).toBe(1);
            expect(dayResult[30]).toBe(31);

            const monthResult = parseField("*", FIELD_CONFIGS.month);
            expect(monthResult).toHaveLength(12);
            expect(monthResult[0]).toBe(1);
            expect(monthResult[11]).toBe(12);

            const weekdayResult = parseField("*", FIELD_CONFIGS.weekday);
            expect(weekdayResult).toHaveLength(7);
            expect(weekdayResult[0]).toBe(0);
            expect(weekdayResult[6]).toBe(6);
        });

        test("should parse single valid numbers", () => {
            expect(parseField("0", FIELD_CONFIGS.minute)).toEqual([0]);
            expect(parseField("59", FIELD_CONFIGS.minute)).toEqual([59]);
            expect(parseField("23", FIELD_CONFIGS.hour)).toEqual([23]);
            expect(parseField("1", FIELD_CONFIGS.day)).toEqual([1]);
            expect(parseField("31", FIELD_CONFIGS.day)).toEqual([31]);
            expect(parseField("12", FIELD_CONFIGS.month)).toEqual([12]);
            expect(parseField("6", FIELD_CONFIGS.weekday)).toEqual([6]);
        });
    });

    describe("range parsing edge cases", () => {
        test("should parse valid ranges", () => {
            expect(parseField("1-5", FIELD_CONFIGS.minute)).toEqual([1, 2, 3, 4, 5]);
            expect(parseField("0-2", FIELD_CONFIGS.hour)).toEqual([0, 1, 2]);
            expect(parseField("1-3", FIELD_CONFIGS.day)).toEqual([1, 2, 3]);
            expect(parseField("1-1", FIELD_CONFIGS.month)).toEqual([1]); // Single value range
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

    describe("step parsing edge cases", () => {
        test("should parse valid step expressions", () => {
            expect(parseField("*/5", FIELD_CONFIGS.minute)).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
            expect(parseField("0-10/2", FIELD_CONFIGS.minute)).toEqual([0, 2, 4, 6, 8, 10]);
            expect(parseField("1-7/3", FIELD_CONFIGS.day)).toEqual([1, 4, 7]);
        });

        test("should throw FieldParseError for invalid step formats", () => {
            expect(() => parseField("/5", FIELD_CONFIGS.minute)).toThrow();
            expect(() => parseField("*//5", FIELD_CONFIGS.minute)).toThrow();
            expect(() => parseField("*/", FIELD_CONFIGS.minute)).toThrow();
            expect(() => parseField("*//", FIELD_CONFIGS.minute)).toThrow();
            expect(() => parseField("1/2/3", FIELD_CONFIGS.minute)).toThrow();
        });

        test("should throw FieldParseError for invalid step values", () => {
            expect(() => parseField("*/0", FIELD_CONFIGS.minute)).toThrow();
            expect(() => parseField("*/-1", FIELD_CONFIGS.minute)).toThrow();
            expect(() => parseField("*/abc", FIELD_CONFIGS.minute)).toThrow();
            // Note: parseInt("1.5") = 1, so this doesn't throw but creates step of 1
        });

        test("should handle step values larger than range", () => {
            // This should work but return fewer values
            const result = parseField("0-5/10", FIELD_CONFIGS.minute);
            expect(result).toEqual([0]); // Only first value since step is larger than range
        });
    });

    describe("comma-separated list parsing edge cases", () => {
        test("should parse valid comma-separated lists", () => {
            expect(parseField("1,3,5", FIELD_CONFIGS.minute)).toEqual([1, 3, 5]);
            expect(parseField("0,12,23", FIELD_CONFIGS.hour)).toEqual([0, 12, 23]);
            expect(parseField("1,15,31", FIELD_CONFIGS.day)).toEqual([1, 15, 31]);
        });

        test("should remove duplicates and sort results", () => {
            expect(parseField("5,1,3,1,5", FIELD_CONFIGS.minute)).toEqual([1, 3, 5]);
            expect(parseField("10,5,15,5,10", FIELD_CONFIGS.minute)).toEqual([5, 10, 15]);
        });

        test("should handle mixed expressions in comma-separated lists", () => {
            expect(parseField("1,3-5,10", FIELD_CONFIGS.minute)).toEqual([1, 3, 4, 5, 10]);
            expect(parseField("0,*/30", FIELD_CONFIGS.minute)).toEqual([0, 30]);
            expect(parseField("1-3,*/20,45", FIELD_CONFIGS.minute)).toEqual([0, 1, 2, 3, 20, 40, 45]);
        });

        test("should handle whitespace in comma-separated lists", () => {
            expect(parseField("1, 3, 5", FIELD_CONFIGS.minute)).toEqual([1, 3, 5]);
            expect(parseField(" 1 , 3 , 5 ", FIELD_CONFIGS.minute)).toEqual([1, 3, 5]);
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
            expect(parseField("0", FIELD_CONFIGS.minute)).toEqual([0]);
            expect(parseField("59", FIELD_CONFIGS.minute)).toEqual([59]);
            expect(() => parseField("-1", FIELD_CONFIGS.minute)).toThrow();
            expect(() => parseField("60", FIELD_CONFIGS.minute)).toThrow();

            // Hour field (0-23)
            expect(parseField("0", FIELD_CONFIGS.hour)).toEqual([0]);
            expect(parseField("23", FIELD_CONFIGS.hour)).toEqual([23]);
            expect(() => parseField("-1", FIELD_CONFIGS.hour)).toThrow();
            expect(() => parseField("24", FIELD_CONFIGS.hour)).toThrow();

            // Day field (1-31)
            expect(parseField("1", FIELD_CONFIGS.day)).toEqual([1]);
            expect(parseField("31", FIELD_CONFIGS.day)).toEqual([31]);
            expect(() => parseField("0", FIELD_CONFIGS.day)).toThrow();
            expect(() => parseField("32", FIELD_CONFIGS.day)).toThrow();

            // Month field (1-12)
            expect(parseField("1", FIELD_CONFIGS.month)).toEqual([1]);
            expect(parseField("12", FIELD_CONFIGS.month)).toEqual([12]);
            expect(() => parseField("0", FIELD_CONFIGS.month)).toThrow();
            expect(() => parseField("13", FIELD_CONFIGS.month)).toThrow();

            // Weekday field (0-6)
            expect(parseField("0", FIELD_CONFIGS.weekday)).toEqual([0]);
            expect(parseField("6", FIELD_CONFIGS.weekday)).toEqual([6]);
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
                .toThrow(/invalid range/);

            // Test invalid step
            expect(() => parseField("*/0", FIELD_CONFIGS.minute))
                .toThrow(/invalid step value/);
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
            expect(parseField("1.5", FIELD_CONFIGS.minute)).toEqual([1]);
            expect(parseField("1.0", FIELD_CONFIGS.minute)).toEqual([1]);
        });

        test("should handle scientific notation (parseInt behavior)", () => {
            // parseInt handles scientific notation by parsing the integer part
            expect(parseField("1e10", FIELD_CONFIGS.minute)).toEqual([1]);
            expect(parseField("2e5", FIELD_CONFIGS.minute)).toEqual([2]);
            // "1e-5" gets parsed as range "1e" to "5" (parseInt("1e") = 1, parseInt("5") = 5)
            expect(parseField("1e-5", FIELD_CONFIGS.minute)).toEqual([1, 2, 3, 4, 5]);
        });
    });
});