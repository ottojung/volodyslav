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

    describe("POSIX compliance", () => {
        describe("valid POSIX expressions", () => {
            test("POSIX example: weekday 03:15", () => {
                const expr = parseCronExpression("15 3 * * 1-5");
                expect(isCronExpression(expr)).toBe(true);
                expect(expr.minute).toEqual(createMask([15], 59));
                expect(expr.hour).toEqual(createMask([3], 23));
                expect(expr.weekday).toEqual(createMask([1, 2, 3, 4, 5], 6));
            });

            test("POSIX example: DOM/DOW OR semantics", () => {
                const expr = parseCronExpression("0 0 1,15 * 1");
                expect(isCronExpression(expr)).toBe(true);
                expect(expr.day).toEqual(createMask([1, 15], 31));
                expect(expr.weekday).toEqual(createMask([1], 6));
                expect(expr.isDomDowRestricted).toBe(true); // Both DOM and DOW are restricted
            });

            test("POSIX example: Feb 14 at 12:00", () => {
                const expr = parseCronExpression("0 12 14 2 *");
                expect(isCronExpression(expr)).toBe(true);
                expect(expr.minute).toEqual(createMask([0], 59));
                expect(expr.hour).toEqual(createMask([12], 23));
                expect(expr.day).toEqual(createMask([14], 31));
                expect(expr.month).toEqual(createMask([2], 12));
            });

            test("ranges and lists mixed", () => {
                const expr = parseCronExpression("0 6-10,15,16 14 2 *");
                expect(isCronExpression(expr)).toBe(true);
                expect(expr.hour).toEqual(createMask([6, 7, 8, 9, 10, 15, 16], 23));
            });

            test("Sunday only (DOW=0)", () => {
                const expr = parseCronExpression("0 0 * * 0");
                expect(isCronExpression(expr)).toBe(true);
                expect(expr.weekday).toEqual(createMask([0], 6));
            });
        });

        describe("invalid non-POSIX extensions", () => {
            const testInvalidExpression = (expr, expectedErrorType = "POSIX violation") => {
                expect(() => parseCronExpression(expr)).toThrow();
                
                // Verify it throws the right error and mentions POSIX violation
                let thrownError;
                try {
                    parseCronExpression(expr);
                } catch (error) {
                    thrownError = error;
                }
                expect(thrownError).toBeDefined();
                expect(isInvalidCronExpressionError(thrownError)).toBe(true);
                if (expectedErrorType === "POSIX violation") {
                    expect(thrownError.message).toContain("POSIX violation");
                }
                // For range errors, just verify they throw without requiring POSIX violation text
            };

            test("step values (not POSIX)", () => {
                testInvalidExpression("*/15 * * * *");
                testInvalidExpression("0-30/5 * * * *");
                testInvalidExpression("* */6 * * *");
                expect(true).toBe(true);
            });

            test("names (not POSIX)", () => {
                testInvalidExpression("0 0 * * mon");
                testInvalidExpression("0 0 * jan *");
                testInvalidExpression("0 0 * * monday");
                testInvalidExpression("0 0 1 january *");
                expect(true).toBe(true);
            });

            test("macros (not POSIX)", () => {
                testInvalidExpression("@hourly");
                testInvalidExpression("@daily");
                testInvalidExpression("@weekly");
                testInvalidExpression("@monthly");
                testInvalidExpression("@yearly");
                testInvalidExpression("@reboot");
                expect(true).toBe(true);
            });

            test("Quartz tokens (not POSIX)", () => {
                testInvalidExpression("0 0 ? * *");
                testInvalidExpression("0 0 * * 5#3");
                testInvalidExpression("0 0 * * 5L");
                testInvalidExpression("0 0 * * 5W");
                testInvalidExpression("0 0 L * *");
                testInvalidExpression("0 0 15W * *");
                expect(true).toBe(true);
            });

            test("DOW out of range (7 = Sunday not allowed, POSIX compliance)", () => {
                // Helper to test expressions that should fail with POSIX compliance message
                const testSundaySevenRejection = (expr) => {
                    expect(() => parseCronExpression(expr)).toThrow();
                    
                    let thrownError;
                    try {
                        parseCronExpression(expr);
                    } catch (error) {
                        thrownError = error;
                    }
                    expect(thrownError).toBeDefined();
                    expect(isInvalidCronExpressionError(thrownError)).toBe(true);
                    expect(thrownError.message).toContain("Sunday must be 0, not 7");
                    expect(thrownError.message).toContain("POSIX compliance");
                };
                
                // Test single value 7
                testSundaySevenRejection("0 0 * * 7");
                
                // Test ranges containing 7
                testSundaySevenRejection("0 0 * * 1-7");
                testSundaySevenRejection("0 0 * * 6-7");
                
                // Test lists containing 7
                testSundaySevenRejection("0 0 * * 1,7");
                testSundaySevenRejection("0 0 * * 0,1,7");
            });

            test("hour out of range", () => {
                testInvalidExpression("0 24 * * *", "range error");
                expect(true).toBe(true);
            });

            test("minute out of range", () => {
                testInvalidExpression("60 * * * *", "range error");
                expect(true).toBe(true);
            });

            test("day out of range", () => {
                testInvalidExpression("* * 32 * *", "range error");
                expect(true).toBe(true);
            });

            test("month out of range", () => {
                testInvalidExpression("* * * 13 *", "range error");
                expect(true).toBe(true);
            });

            test("malformed lists", () => {
                testInvalidExpression("0 0 1-5, * *", "range error"); // trailing comma
                testInvalidExpression("0 0 ,1-5 * *", "range error"); // leading comma
                testInvalidExpression("0 0 1,,5 * *", "range error"); // double comma
                expect(true).toBe(true);
            });

            test("wrap-around ranges (not POSIX)", () => {
                testInvalidExpression("0 0 * * 6-2"); // Saturday to Tuesday
                testInvalidExpression("22-2 * * * *"); // 22 to 2 in minutes
                expect(true).toBe(true);
            });
        });

        describe("DOM/DOW OR semantics validation", () => {
            test("DOM/DOW OR: runs on 1st, 15th, and every Monday", () => {
                const expr = parseCronExpression("0 0 1,15 * 1");
                
                // Test specific dates
                // January 1, 2024 is a Monday (both DOM and DOW match)
                const jan1 = fromISOString("2024-01-01T00:00:00.000Z");
                expect(matchesCronExpression(expr, jan1)).toBe(true);
                
                // January 15, 2024 is a Monday (both DOM and DOW match)
                const jan15 = fromISOString("2024-01-15T00:00:00.000Z");
                expect(matchesCronExpression(expr, jan15)).toBe(true);
                
                // January 8, 2024 is a Monday (DOW matches, DOM doesn't)
                const jan8 = fromISOString("2024-01-08T00:00:00.000Z");
                expect(matchesCronExpression(expr, jan8)).toBe(true);
                
                // January 2, 2024 is a Tuesday (neither DOM nor DOW matches)
                const jan2 = fromISOString("2024-01-02T00:00:00.000Z");
                expect(matchesCronExpression(expr, jan2)).toBe(false);
            });

            test("DOW only: runs only on Mondays", () => {
                const expr = parseCronExpression("0 0 * * 1");
                
                // January 1, 2024 is a Monday
                const jan1 = fromISOString("2024-01-01T00:00:00.000Z");
                expect(matchesCronExpression(expr, jan1)).toBe(true);
                
                // January 2, 2024 is a Tuesday
                const jan2 = fromISOString("2024-01-02T00:00:00.000Z");
                expect(matchesCronExpression(expr, jan2)).toBe(false);
            });
        });

        describe("boundary validation", () => {
            test("accepts boundary ranges", () => {
                expect(() => parseCronExpression("0-59 0-23 1-31 1-12 0-6")).not.toThrow();
            });

            test("rejects out-of-boundary ranges", () => {
                expect(() => parseCronExpression("0-60 * * * *")).toThrow();
                expect(() => parseCronExpression("* 0-24 * * *")).toThrow();
                expect(() => parseCronExpression("* * 1-32 * *")).toThrow();
                expect(() => parseCronExpression("* * * 1-13 *")).toThrow();
                expect(() => parseCronExpression("* * * * 0-7")).toThrow();
            });
        });

        describe("calendar edge cases", () => {
            test("April 31 with wildcard DOW never runs", () => {
                // This is valid syntax but April only has 30 days
                const expr = parseCronExpression("0 0 31 4 *");
                
                // Should be empty list for April (month 4)
                const validDays = expr.validDays(2024, 4);
                expect(validDays).toEqual([]);
            });

            test("April 31 with DOW runs on DOW matches", () => {
                // Valid syntax - should run on Mondays in April even though April 31 doesn't exist
                const expr = parseCronExpression("0 0 31 4 1");
                
                // Should include Mondays in April 2024 
                const validDays = expr.validDays(2024, 4);
                expect(validDays.length).toBeGreaterThan(0);
                
                // Verify it includes some Mondays (1, 8, 15, 22, 29 are Mondays in April 2024)
                expect(validDays).toContain(1);
                expect(validDays).toContain(8);
                expect(validDays).toContain(15);
                expect(validDays).toContain(22);
                expect(validDays).toContain(29);
            });
        });
    });
});
