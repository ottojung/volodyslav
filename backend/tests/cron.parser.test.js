/**
 * Tests for the cron expression parser module.
 */

const { parseCronExpression } = require("../src/scheduler/expression");
const { matchesCronExpression } = require("../src/scheduler/calculator");

const { isCronExpression, isInvalidCronExpressionError } = require("../src/scheduler");

const { fromISOString } = require("../src/datetime");

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

describe("Cron Parser", () => {

    describe("parseCronExpression", () => {
        test("parses basic cron expressions", () => {
            const expr = parseCronExpression("0 * * * *");
            expect(isCronExpression(expr)).toBe(true);
            expect(expr.minute).toEqual(createMask([0], 59));
            expect(expr.hour).toEqual(createMask(Array.from({ length: 24 }, (_, i) => i), 23));
            expect(expr.day).toEqual(createMask(Array.from({ length: 31 }, (_, i) => i + 1), 31));
            expect(expr.month).toEqual(createMask(Array.from({ length: 12 }, (_, i) => i + 1), 12));
            expect(expr.weekday).toEqual(createMask([0, 1, 2, 3, 4, 5, 6], 6));
        });

        test("parses specific time expressions", () => {
            const expr = parseCronExpression("0 2 * * *");
            expect(expr.minute).toEqual(createMask([0], 59));
            expect(expr.hour).toEqual(createMask([2], 23));
        });

        test("parses range expressions", () => {
            const expr = parseCronExpression("0-5 * * * *");
            expect(expr.minute).toEqual(createMask([0, 1, 2, 3, 4, 5], 59));
        });

        test("parses comma-separated expressions equivalent to former step expressions", () => {
            const expr = parseCronExpression("0,15,30,45 * * * *");
            expect(expr.minute).toEqual(createMask([0, 15, 30, 45], 59));
        });

        test("parses comma-separated expressions", () => {
            const expr = parseCronExpression("0,30 * * * *");
            expect(expr.minute).toEqual(createMask([0, 30], 59));
        });

        test("parses complex expressions", () => {
            const expr = parseCronExpression("0,15,30,45 9-17 * * 1-5");
            expect(expr.minute).toEqual(createMask([0, 15, 30, 45], 59));
            expect(expr.hour).toEqual(createMask([9, 10, 11, 12, 13, 14, 15, 16, 17], 23));
            expect(expr.weekday).toEqual(createMask([1, 2, 3, 4, 5], 6));
        });

        test("throws on invalid expressions", () => {
            const testInvalidExpression = (expr) => {
                expect(() => parseCronExpression(expr)).toThrow();

                // Also verify the error type
                let thrownError;
                try {
                    parseCronExpression(expr);
                } catch (error) {
                    thrownError = error;
                }
                expect(thrownError).toBeDefined();
                expect(isInvalidCronExpressionError(thrownError)).toBe(true);
            };

            testInvalidExpression("");
            testInvalidExpression("0 * * *");
            testInvalidExpression("0 * * * * *");
            testInvalidExpression("60 * * * *");
            testInvalidExpression("* 25 * * *");
            testInvalidExpression("* * 32 * *");
            testInvalidExpression("* * * 13 *");
            testInvalidExpression("* * * * 7");
            // Test that slash syntax is now rejected
            testInvalidExpression("*/15 * * * *");
            testInvalidExpression("0-30/5 * * * *");
            testInvalidExpression("* */6 * * *");
        });

        test("throws on non-string input", () => {
            const testInvalidInput = (input) => {
                expect(() => parseCronExpression(input)).toThrow();

                // Also verify the error type  
                let thrownError;
                try {
                    parseCronExpression(input);
                } catch (error) {
                    thrownError = error;
                }
                expect(thrownError).toBeDefined();
                expect(isInvalidCronExpressionError(thrownError)).toBe(true);
            };

            testInvalidInput(123);
            testInvalidInput(null);
            testInvalidInput(undefined);
        });

        test("error contains helpful information", () => {
            let thrownError;
            try {
                parseCronExpression("60 * * * *");
            } catch (error) {
                thrownError = error;
            }

            expect(thrownError).toBeDefined();
            expect(isInvalidCronExpressionError(thrownError)).toBe(true);
            expect(thrownError.expression).toBe("60 * * * *");
            expect(thrownError.field).toBe("minute");
            expect(thrownError.reason).toContain("out of range");
        });
    });

    describe("matchesCronExpression", () => {
        test("matches exact time", () => {
            const expr = parseCronExpression("30 14 * * *");
            // Jan 1, 2024 at 2:30 PM
            const dateTime = fromISOString("2024-01-01T14:30:00.000Z");
            expect(matchesCronExpression(expr, dateTime)).toBe(true);
        });

        test("does not match different time", () => {
            const expr = parseCronExpression("30 14 * * *");
            // Jan 1, 2024 at 2:31 PM
            const dateTime = fromISOString("2024-01-01T14:31:00.000Z");
            expect(matchesCronExpression(expr, dateTime)).toBe(false);
        });

        test("matches wildcard expressions", () => {
            const expr = parseCronExpression("* * * * *");
            const dateTime = fromISOString("2024-01-01T14:30:00.000Z");
            expect(matchesCronExpression(expr, dateTime)).toBe(true);
        });

        test("matches weekday expressions", () => {
            const expr = parseCronExpression("* * * * 1"); // Monday (1)
            // Jan 1, 2024 is a Monday
            const monday = fromISOString("2024-01-01T00:00:00.000Z");
            // Jan 2, 2024 is a Tuesday
            const tuesday = fromISOString("2024-01-02T00:00:00.000Z");

            expect(matchesCronExpression(expr, monday)).toBe(true);
            expect(matchesCronExpression(expr, tuesday)).toBe(false);
        });
    });
});
