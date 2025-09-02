/**
 * Tests for scheduler cron expression equivalence logic edge cases.
 * Focuses on testing the equivalent method and complex comparison scenarios.
 */

const { parseCronExpression } = require("../src/scheduler/expression");

describe("scheduler cron expression equivalence edge cases", () => {

    describe("basic equivalence", () => {
        test("should return true for identical expressions", () => {
            const cron1 = parseCronExpression("0 * * * *");
            const cron2 = parseCronExpression("0 * * * *");

            expect(cron1.equivalent(cron2)).toBe(true);
            expect(cron2.equivalent(cron1)).toBe(true);
        });

        test("should return false for different expressions", () => {
            const cron1 = parseCronExpression("0 * * * *");
            const cron2 = parseCronExpression("0 0 * * *");

            expect(cron1.equivalent(cron2)).toBe(false);
            expect(cron2.equivalent(cron1)).toBe(false);
        });

        test("should handle wildcard equivalence", () => {
            const cron1 = parseCronExpression("* * * * *");
            const cron2 = parseCronExpression("* * * * *");

            expect(cron1.equivalent(cron2)).toBe(true);
        });
    });

    describe("semantically equivalent but syntactically different expressions", () => {
        test("should return true for semantically equivalent ranges", () => {
            // These represent the same schedule but use different syntax
            const cron1 = parseCronExpression("0-59 * * * *"); // every minute
            const cron2 = parseCronExpression("* * * * *"); // also every minute

            // The equivalent method checks parsed array equality, and these are actually the same
            expect(cron1.equivalent(cron2)).toBe(true);
        });

        test("should return false for different order in comma-separated lists", () => {
            const cron1 = parseCronExpression("1,2,3 * * * *");
            const cron2 = parseCronExpression("3,2,1 * * * *");

            // The parseField function sorts the values, so these should actually be equivalent
            expect(cron1.equivalent(cron2)).toBe(true);
        });

        test("should return true for duplicate values in comma-separated lists", () => {
            const cron1 = parseCronExpression("1,2,3 * * * *");
            const cron2 = parseCronExpression("1,1,2,2,3,3 * * * *");

            // The parseField function deduplicates values
            expect(cron1.equivalent(cron2)).toBe(true);
        });
    });

    describe("field-by-field equivalence", () => {
        test("should detect differences in minute field", () => {
            const cron1 = parseCronExpression("0 * * * *");
            const cron2 = parseCronExpression("1 * * * *");

            expect(cron1.equivalent(cron2)).toBe(false);
        });

        test("should detect differences in hour field", () => {
            const cron1 = parseCronExpression("0 0 * * *");
            const cron2 = parseCronExpression("0 1 * * *");

            expect(cron1.equivalent(cron2)).toBe(false);
        });

        test("should detect differences in day field", () => {
            const cron1 = parseCronExpression("0 0 1 * *");
            const cron2 = parseCronExpression("0 0 2 * *");

            expect(cron1.equivalent(cron2)).toBe(false);
        });

        test("should detect differences in month field", () => {
            const cron1 = parseCronExpression("0 0 1 1 *");
            const cron2 = parseCronExpression("0 0 1 2 *");

            expect(cron1.equivalent(cron2)).toBe(false);
        });

        test("should detect differences in weekday field", () => {
            const cron1 = parseCronExpression("0 0 * * 0");
            const cron2 = parseCronExpression("0 0 * * 1");

            expect(cron1.equivalent(cron2)).toBe(false);
        });
    });

    describe("complex expression equivalence", () => {
        test("should handle range expressions", () => {
            const cron1 = parseCronExpression("0-5 * * * *");
            const cron2 = parseCronExpression("0-5 * * * *");

            expect(cron1.equivalent(cron2)).toBe(true);
        });

        test("should detect differences in ranges", () => {
            const cron1 = parseCronExpression("0-5 * * * *");
            const cron2 = parseCronExpression("0-4 * * * *");

            expect(cron1.equivalent(cron2)).toBe(false);
        });

        test("should handle step expressions", () => {
            const cron1 = parseCronExpression("*/5 * * * *");
            const cron2 = parseCronExpression("*/5 * * * *");

            expect(cron1.equivalent(cron2)).toBe(true);
        });

        test("should detect differences in step expressions", () => {
            const cron1 = parseCronExpression("*/5 * * * *");
            const cron2 = parseCronExpression("*/10 * * * *");

            expect(cron1.equivalent(cron2)).toBe(false);
        });

        test("should handle mixed complex expressions", () => {
            const cron1 = parseCronExpression("0,15,30,45 2-4 1,15 1-6 1-5");
            const cron2 = parseCronExpression("0,15,30,45 2-4 1,15 1-6 1-5");

            expect(cron1.equivalent(cron2)).toBe(true);
        });

        test("should detect subtle differences in complex expressions", () => {
            const cron1 = parseCronExpression("0,15,30,45 2-4 1,15 1-6 1-5");
            const cron2 = parseCronExpression("0,15,30,45 2-4 1,15 1-6 1-4"); // Last field different

            expect(cron1.equivalent(cron2)).toBe(false);
        });
    });

    describe("boundary value equivalence", () => {
        test("should handle minimum values", () => {
            const cron1 = parseCronExpression("0 0 1 1 0");
            const cron2 = parseCronExpression("0 0 1 1 0");

            expect(cron1.equivalent(cron2)).toBe(true);
        });

        test("should handle maximum values", () => {
            const cron1 = parseCronExpression("59 23 31 12 6");
            const cron2 = parseCronExpression("59 23 31 12 6");

            expect(cron1.equivalent(cron2)).toBe(true);
        });

        test("should detect differences at boundaries", () => {
            const cron1 = parseCronExpression("0 0 1 1 0");
            const cron2 = parseCronExpression("1 0 1 1 0"); // First field different by 1

            expect(cron1.equivalent(cron2)).toBe(false);
        });
    });

    describe("array length differences", () => {
        test("should return false when field arrays have different lengths", () => {
            // This tests the implementation detail of checking array lengths first
            const cron1 = parseCronExpression("0,1 * * * *"); // 2 values
            const cron2 = parseCronExpression("0,1,2 * * * *"); // 3 values

            expect(cron1.equivalent(cron2)).toBe(false);
        });

        test("should handle single value vs multiple values", () => {
            const cron1 = parseCronExpression("0 * * * *"); // Single value
            const cron2 = parseCronExpression("0,1 * * * *"); // Multiple values

            expect(cron1.equivalent(cron2)).toBe(false);
        });
    });

    describe("reflexivity and symmetry", () => {
        test("should be reflexive - expression equals itself", () => {
            const cron = parseCronExpression("0 2 * * 1-5");

            expect(cron.equivalent(cron)).toBe(true);
        });

        test("should be symmetric - if A equals B, then B equals A", () => {
            const cron1 = parseCronExpression("*/15 9-17 * * 1-5");
            const cron2 = parseCronExpression("*/15 9-17 * * 1-5");

            expect(cron1.equivalent(cron2)).toBe(cron2.equivalent(cron1));
        });

        test("should maintain symmetry for different expressions", () => {
            const cron1 = parseCronExpression("0 9 * * *");
            const cron2 = parseCronExpression("0 17 * * *");

            expect(cron1.equivalent(cron2)).toBe(cron2.equivalent(cron1));
            expect(cron1.equivalent(cron2)).toBe(false);
        });
    });

    describe("edge cases with empty and full ranges", () => {
        test("should handle expressions that result in full ranges", () => {
            const cron1 = parseCronExpression("* * * * *");
            const cron2 = parseCronExpression("0-59 0-23 1-31 1-12 0-6");

            // These should be equivalent but the current implementation might not detect it
            // since it compares parsed arrays directly
            expect(cron1.equivalent(cron2)).toBe(true);
        });

        test("should handle single-element ranges", () => {
            const cron1 = parseCronExpression("5-5 * * * *");
            const cron2 = parseCronExpression("5 * * * *");

            expect(cron1.equivalent(cron2)).toBe(true);
        });
    });

    describe("whitespace and formatting equivalence", () => {
        test("should handle expressions that parse to same result despite different whitespace", () => {
            // The parseCronExpression should normalize whitespace
            const cron1 = parseCronExpression("0 * * * *");
            const cron2 = parseCronExpression("0  *   *    *     *");

            expect(cron1.equivalent(cron2)).toBe(true);
        });
    });

    describe("consistency checks", () => {
        test("should return consistent results for multiple calls", () => {
            const cron1 = parseCronExpression("0 9-17 * * 1-5");
            const cron2 = parseCronExpression("0 9-17 * * 1-5");

            const result1 = cron1.equivalent(cron2);
            const result2 = cron1.equivalent(cron2);
            const result3 = cron1.equivalent(cron2);

            expect(result1).toBe(result2);
            expect(result2).toBe(result3);
            expect(result1).toBe(true);
        });

        test("should not modify the cron expressions during comparison", () => {
            const cron1 = parseCronExpression("0 * * * *");
            const cron2 = parseCronExpression("0 * * * *");

            const beforeMinute1 = [...cron1.minute];
            const beforeHour1 = [...cron1.hour];
            const beforeMinute2 = [...cron2.minute];
            const beforeHour2 = [...cron2.hour];

            cron1.equivalent(cron2);

            expect(cron1.minute).toEqual(beforeMinute1);
            expect(cron1.hour).toEqual(beforeHour1);
            expect(cron2.minute).toEqual(beforeMinute2);
            expect(cron2.hour).toEqual(beforeHour2);
        });
    });

    describe("performance considerations", () => {
        test("should handle expressions with large arrays efficiently", () => {
            // This creates expressions with many values
            const largeCron1 = parseCronExpression("* * * * *");
            const largeCron2 = parseCronExpression("* * * * *");

            // eslint-disable-next-line volodyslav/no-date-class -- Performance timing test
            const startTime = Date.now();
            const result = largeCron1.equivalent(largeCron2);
            // eslint-disable-next-line volodyslav/no-date-class -- Performance timing test
            const endTime = Date.now();

            expect(result).toBe(true);
            expect(endTime - startTime).toBeLessThan(100); // Should be fast
        });

        test("should short-circuit on length differences", () => {
            const cron1 = parseCronExpression("0,1,2,3,4,5,6,7,8,9 * * * *");
            const cron2 = parseCronExpression("0 * * * *");

            // Should return false quickly due to length difference
            // eslint-disable-next-line volodyslav/no-date-class -- Performance timing test
            const startTime = Date.now();
            const result = cron1.equivalent(cron2);
            // eslint-disable-next-line volodyslav/no-date-class -- Performance timing test
            const endTime = Date.now();

            expect(result).toBe(false);
            expect(endTime - startTime).toBeLessThan(50);
        });
    });
});