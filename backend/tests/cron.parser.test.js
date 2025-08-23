/**
 * Tests for the cron expression parser module.
 */

const { 
    parseCronExpression, 
    matchesCronExpression, 
    getNextExecution,
    isCronExpression,
    isInvalidCronExpressionError,
    InvalidCronExpressionError 
} = require("../src/cron/parser");

const datetime = require("../src/datetime");

describe("Cron Parser", () => {
    let dt;
    
    beforeEach(() => {
        dt = datetime.make();
    });

    describe("parseCronExpression", () => {
        test("parses basic cron expressions", () => {
            const expr = parseCronExpression("0 * * * *");
            expect(isCronExpression(expr)).toBe(true);
            expect(expr.minute).toEqual([0]);
            expect(expr.hour).toEqual(Array.from({ length: 24 }, (_, i) => i));
            expect(expr.day).toEqual(Array.from({ length: 31 }, (_, i) => i + 1));
            expect(expr.month).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
            expect(expr.weekday).toEqual(Array.from({ length: 7 }, (_, i) => i));
        });

        test("parses specific time expressions", () => {
            const expr = parseCronExpression("0 2 * * *");
            expect(expr.minute).toEqual([0]);
            expect(expr.hour).toEqual([2]);
        });

        test("parses range expressions", () => {
            const expr = parseCronExpression("0-5 * * * *");
            expect(expr.minute).toEqual([0, 1, 2, 3, 4, 5]);
        });

        test("parses step expressions", () => {
            const expr = parseCronExpression("*/15 * * * *");
            expect(expr.minute).toEqual([0, 15, 30, 45]);
        });

        test("parses comma-separated expressions", () => {
            const expr = parseCronExpression("0,30 * * * *");
            expect(expr.minute).toEqual([0, 30]);
        });

        test("parses complex expressions", () => {
            const expr = parseCronExpression("0,15,30,45 9-17 * * 1-5");
            expect(expr.minute).toEqual([0, 15, 30, 45]);
            expect(expr.hour).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
            expect(expr.weekday).toEqual([1, 2, 3, 4, 5]);
        });

        test("throws on invalid expressions", () => {
            expect(() => parseCronExpression("")).toThrow(InvalidCronExpressionError);
            expect(() => parseCronExpression("0 * * *")).toThrow(InvalidCronExpressionError);
            expect(() => parseCronExpression("0 * * * * *")).toThrow(InvalidCronExpressionError);
            expect(() => parseCronExpression("60 * * * *")).toThrow(InvalidCronExpressionError);
            expect(() => parseCronExpression("* 25 * * *")).toThrow(InvalidCronExpressionError);
            expect(() => parseCronExpression("* * 32 * *")).toThrow(InvalidCronExpressionError);
            expect(() => parseCronExpression("* * * 13 *")).toThrow(InvalidCronExpressionError);
            expect(() => parseCronExpression("* * * * 7")).toThrow(InvalidCronExpressionError);
        });

        test("throws on non-string input", () => {
            expect(() => parseCronExpression(123)).toThrow(InvalidCronExpressionError);
            expect(() => parseCronExpression(null)).toThrow(InvalidCronExpressionError);
            expect(() => parseCronExpression(undefined)).toThrow(InvalidCronExpressionError);
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
            const dateTime = dt.fromEpochMs(new Date(2024, 0, 1, 14, 30, 0).getTime()); // Jan 1, 2024 at 2:30 PM
            expect(matchesCronExpression(expr, dateTime)).toBe(true);
        });

        test("does not match different time", () => {
            const expr = parseCronExpression("30 14 * * *");
            const dateTime = dt.fromEpochMs(new Date(2024, 0, 1, 14, 31, 0).getTime()); // Jan 1, 2024 at 2:31 PM
            expect(matchesCronExpression(expr, dateTime)).toBe(false);
        });

        test("matches wildcard expressions", () => {
            const expr = parseCronExpression("0 * * * *");
            const dateTime = dt.fromEpochMs(new Date(2024, 0, 1, 14, 30, 0).getTime());
            expect(matchesCronExpression(expr, dateTime)).toBe(true);
        });

        test("matches weekday expressions", () => {
            const expr = parseCronExpression("* * * * 1"); // Monday
            const monday = dt.fromEpochMs(new Date(2024, 0, 1).getTime()); // Jan 1, 2024 is a Monday
            const tuesday = dt.fromEpochMs(new Date(2024, 0, 2).getTime()); // Jan 2, 2024 is a Tuesday
            
            expect(matchesCronExpression(expr, monday)).toBe(true);
            expect(matchesCronExpression(expr, tuesday)).toBe(false);
        });
    });

    describe("getNextExecution", () => {
        test("calculates next minute execution", () => {
            const expr = parseCronExpression("0 * * * *");
            const from = dt.fromEpochMs(new Date(2024, 0, 1, 14, 30, 0).getTime()); // Jan 1, 2024 at 2:30 PM
            const next = getNextExecution(expr, from);
            const nextNative = dt.toNativeDate(next);
            
            expect(nextNative.getHours()).toBe(15);
            expect(nextNative.getMinutes()).toBe(0);
            expect(nextNative.getSeconds()).toBe(0);
            expect(nextNative.getMilliseconds()).toBe(0);
        });

        test("calculates next daily execution", () => {
            const expr = parseCronExpression("0 2 * * *");
            const from = dt.fromEpochMs(new Date(2024, 0, 1, 14, 30, 0).getTime()); // Jan 1, 2024 at 2:30 PM
            const next = getNextExecution(expr, from);
            const nextNative = dt.toNativeDate(next);
            
            expect(nextNative.getDate()).toBe(2); // Next day
            expect(nextNative.getHours()).toBe(2);
            expect(nextNative.getMinutes()).toBe(0);
        });

        test("calculates next execution within same hour", () => {
            const expr = parseCronExpression("45 * * * *");
            const from = dt.fromEpochMs(new Date(2024, 0, 1, 14, 30, 0).getTime()); // Jan 1, 2024 at 2:30 PM
            const next = getNextExecution(expr, from);
            const nextNative = dt.toNativeDate(next);
            
            expect(nextNative.getHours()).toBe(14);
            expect(nextNative.getMinutes()).toBe(45);
        });

        test("handles end of month correctly", () => {
            const expr = parseCronExpression("0 0 1 * *"); // First day of month
            const from = dt.fromEpochMs(new Date(2024, 0, 31, 23, 59, 0).getTime()); // Jan 31, 2024 at 11:59 PM
            const next = getNextExecution(expr, from);
            const nextNative = dt.toNativeDate(next);
            
            expect(nextNative.getMonth()).toBe(1); // February
            expect(nextNative.getDate()).toBe(1);
            expect(nextNative.getHours()).toBe(0);
            expect(nextNative.getMinutes()).toBe(0);
        });
    });

    describe("Edge cases", () => {
        test("handles February 29th in leap year", () => {
            const expr = parseCronExpression("0 0 29 2 *");
            const from = dt.fromEpochMs(new Date(2024, 1, 28).getTime()); // Feb 28, 2024 (leap year)
            const next = getNextExecution(expr, from);
            const nextNative = dt.toNativeDate(next);
            
            expect(nextNative.getMonth()).toBe(1); // February
            expect(nextNative.getDate()).toBe(29);
        });

        test("handles step values correctly", () => {
            const expr = parseCronExpression("*/10 * * * *");
            const from = dt.fromEpochMs(new Date(2024, 0, 1, 14, 25, 0).getTime());
            const next = getNextExecution(expr, from);
            const nextNative = dt.toNativeDate(next);
            
            expect(nextNative.getMinutes()).toBe(30);
        });

        test("handles complex range and step combinations", () => {
            const expr = parseCronExpression("10-50/10 * * * *");
            expect(expr.minute).toEqual([10, 20, 30, 40, 50]);
        });
    });
});
