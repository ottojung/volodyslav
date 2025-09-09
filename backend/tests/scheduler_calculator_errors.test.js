/**
 * Tests for CronCalculationError in scheduler calculator functions.
 * These tests verify that custom error classes are thrown when no valid execution time can be found.
 */

const { CronCalculationError, isCronCalculationError } = require("../src/scheduler/calculator");
const { parseCronExpression } = require("../src/scheduler/expression");

describe("CronCalculationError scenarios", () => {
    describe("getNextExecution error cases", () => {
        test("should throw CronCalculationError when no valid next execution can be found", () => {
            // Create a scenario that would be impossible to satisfy:
            // Try to create a cron expression that has valid fields but creates an impossible scenario
            // For example, February 30th (which doesn't exist in any year)
            expect(() => parseCronExpression("0 0 30 2 *")).toThrow(/No valid next execution/);
        });

        test("should include correct error details in CronCalculationError", () => {
            let thrownError;
            try {
                parseCronExpression("0 0 30 2 *"); // 30th of February at midnight  
            } catch (error) {
                thrownError = error;
            }
            
            expect(thrownError).toBeInstanceOf(CronCalculationError);
            expect(thrownError.name).toBe("CronCalculationError");
            expect(thrownError.message).toContain("No valid next execution time found");
        });
    });

    describe("Error type guard", () => {
        test("isCronCalculationError correctly identifies CronCalculationError instances", () => {
            const cronError = new CronCalculationError("Test error");
            const genericError = new Error("Generic error");
            
            expect(isCronCalculationError(cronError)).toBe(true);
            expect(isCronCalculationError(genericError)).toBe(false);
            expect(isCronCalculationError(null)).toBe(false);
            expect(isCronCalculationError(undefined)).toBe(false);
            expect(isCronCalculationError("string")).toBe(false);
        });

        test("thrown CronCalculationError can be caught with type guard", () => {
            let thrownError;
            try {
                parseCronExpression("0 0 30 2 *"); // 30th of February at midnight  
            } catch (error) {
                thrownError = error;
            }
            
            expect(thrownError).toBeDefined();
            expect(isCronCalculationError(thrownError)).toBe(true);
            expect(thrownError.name).toBe("CronCalculationError");
            expect(thrownError.details).toBeDefined();
        });
    });
});