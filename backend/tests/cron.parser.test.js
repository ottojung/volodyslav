/**
 * Tests for the cron expression parser module.
 */

const { 
    parseCronExpression, 
    matchesCronExpression,
    getNextExecution,
    isCronExpression,
    isInvalidCronExpressionError
} = require("../src/scheduler");

const { fromEpochMs } = require("../src/datetime");

describe("Cron Parser", () => {

    describe("parseCronExpression", () => {
        test("parses basic cron expressions", () => {
            const expr = parseCronExpression("0 * * * *");
            expect(isCronExpression(expr)).toBe(true);
            expect(expr.minute).toEqual([0]);
            expect(expr.hour).toEqual(Array.from({ length: 24 }, (_, i) => i));
            expect(expr.day).toEqual(Array.from({ length: 31 }, (_, i) => i + 1));
            expect(expr.month).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
            expect(expr.weekday).toEqual(["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]);
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
            expect(expr.weekday).toEqual(["monday", "tuesday", "wednesday", "thursday", "friday"]);
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
            // Jan 1, 2024 at 2:30 PM - using correct epoch milliseconds
            const epochMs = 1704119400000; // 2024-01-01T14:30:00.000Z
            const dateTime = fromEpochMs(epochMs);
            expect(matchesCronExpression(expr, dateTime)).toBe(true);
        });

        test("does not match different time", () => {
            const expr = parseCronExpression("30 14 * * *");
            // Jan 1, 2024 at 2:31 PM - using correct epoch milliseconds
            const epochMs = 1704119460000; // 2024-01-01T14:31:00.000Z
            const dateTime = fromEpochMs(epochMs);
            expect(matchesCronExpression(expr, dateTime)).toBe(false);
        });

        test("matches wildcard expressions", () => {
            const expr = parseCronExpression("* * * * *");
            // Using same corrected epoch timestamp
            const epochMs = 1704119400000; // 2024-01-01T14:30:00.000Z
            const dateTime = fromEpochMs(epochMs);
            expect(matchesCronExpression(expr, dateTime)).toBe(true);
        });

        test("matches weekday expressions", () => {
            const expr = parseCronExpression("* * * * monday"); // Monday
            // Jan 1, 2024 is a Monday - 2024-01-01T00:00:00.000Z
            const mondayMs = 1704067200000;
            // Jan 2, 2024 is a Tuesday - 2024-01-02T00:00:00.000Z  
            const tuesdayMs = 1704153600000;
            const monday = fromEpochMs(mondayMs);
            const tuesday = fromEpochMs(tuesdayMs);
            
            expect(matchesCronExpression(expr, monday)).toBe(true);
            expect(matchesCronExpression(expr, tuesday)).toBe(false);
        });
    });

    describe("getNextExecution", () => {
        test("calculates next minute execution", () => {
            const expr = parseCronExpression("0 * * * *");
            // Jan 1, 2024 at 2:30 PM
            const fromMs = 1704119400000; // 2024-01-01T14:30:00.000Z
            const from = fromEpochMs(fromMs);
            const next = getNextExecution(expr, from);
            
            expect(next.hour).toBe(15); // hours
            expect(next.minute).toBe(0); // minutes
            expect(next.second).toBe(0); // seconds
        });

        test("calculates next daily execution", () => {
            const expr = parseCronExpression("0 2 * * *");
            // Jan 1, 2024 at 2:30 PM
            const fromMs = 1704119400000; // 2024-01-01T14:30:00.000Z
            const from = fromEpochMs(fromMs);
            const next = getNextExecution(expr, from);
            
            expect(next.day).toBe(2); // day
            expect(next.hour).toBe(2); // hours
            expect(next.minute).toBe(0); // minutes
        });

        test("calculates next execution within same hour", () => {
            const expr = parseCronExpression("45 * * * *");
            // Jan 1, 2024 at 2:30 PM
            const fromMs = 1704119400000; // 2024-01-01T14:30:00.000Z
            const from = fromEpochMs(fromMs);
            const next = getNextExecution(expr, from);
            
            expect(next.hour).toBe(14); // hours
            expect(next.minute).toBe(45); // minutes
        });

        test("handles end of month correctly", () => {
            const expr = parseCronExpression("0 0 1 * *"); // First day of month
            // Jan 31, 2024 at 11:59 PM - 2024-01-31T23:59:00.000Z
            const fromMs = 1706745540000;
            const from = fromEpochMs(fromMs);
            const next = getNextExecution(expr, from);
            
            expect(next.month).toBe(2); // February (month)
            expect(next.day).toBe(1); // day
            expect(next.hour).toBe(0); // hours
            expect(next.minute).toBe(0); // minutes
        });
    });

    describe("Edge cases", () => {
        test("handles February 29th in leap year", () => {
            const expr = parseCronExpression("0 0 29 2 *");
            // Feb 28, 2024 (leap year) - 2024-02-28T00:00:00.000Z
            const fromMs = 1709078400000;
            const from = fromEpochMs(fromMs);
            const next = getNextExecution(expr, from);
            
            expect(next.month).toBe(2); // February (month)
            expect(next.day).toBe(29); // day
        });

        test("handles step values correctly", () => {
            const expr = parseCronExpression("*/10 * * * *");
            // Jan 1, 2024 at 2:25 PM - should get next execution at 2:30 PM  
            const fromMs = 1704119100000; // 2024-01-01T14:25:00.000Z
            const from = fromEpochMs(fromMs);
            const next = getNextExecution(expr, from);
            
            expect(next.minute).toBe(30); // minutes
        });

        test("handles complex range and step combinations", () => {
            const expr = parseCronExpression("10-50/10 * * * *");
            expect(expr.minute).toEqual([10, 20, 30, 40, 50]);
        });
    });
});
