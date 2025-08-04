/**
 * Tests for the main cron module.
 */

const { make, validate, parseCronExpression, isInvalidCronExpressionError } = require("../src/cron");
const { isTaskId } = require("../src/cron/task_id");
const datetime = require("../src/datetime");

describe("Cron Module", () => {
    let dt;

    beforeEach(() => {
        dt = datetime.make();
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe("make", () => {
        test("creates a scheduler with schedule function", () => {
            const cron = make();
            
            expect(typeof cron.schedule).toBe("function");
            expect(typeof cron.cancel).toBe("function");
            expect(typeof cron.cancelAll).toBe("function");
            expect(typeof cron.getTasks).toBe("function");
        });

        test("schedule function works with valid cron expressions", () => {
            const cron = make();
            const callback = jest.fn();
            
            const taskId = cron.schedule("0 * * * *", callback);
            expect(isTaskId(taskId)).toBe(true);
        });

        test("schedule function throws on invalid cron expressions", () => {
            const cron = make();
            const callback = jest.fn();
            
            expect(() => {
                cron.schedule("invalid", callback);
            }).toThrow();
        });

        test("cancel function works", () => {
            const cron = make();
            const callback = jest.fn();
            
            const taskId = cron.schedule("* * * * *", callback);
            const result = cron.cancel(taskId);
            
            expect(result).toBe(true);
        });

        test("cancelAll function works", () => {
            const cron = make();
            const callback = jest.fn();
            
            cron.schedule("* * * * *", callback);
            cron.schedule("0 * * * *", callback);
            
            const result = cron.cancelAll();
            expect(result).toBe(2);
        });

        test("getTasks function works", () => {
            const cron = make();
            const callback = jest.fn();
            
            expect(cron.getTasks()).toEqual([]);
            
            const now = dt.fromEpochMs(new Date(2024, 0, 1, 14, 30, 0).getTime());
            jest.spyOn(Date, 'now').mockReturnValue(now.epochMs);
            
            cron.schedule("0 * * * *", callback);
            const tasks = cron.getTasks();
            
            expect(tasks).toHaveLength(1);
            expect(isTaskId(tasks[0].id)).toBe(true);
            expect(tasks[0].cronExpression).toBe("0 * * * *");
            expect(tasks[0].nextExecution).toBeInstanceOf(Date);
        });
    });

    describe("validate", () => {
        test("returns true for valid cron expressions", () => {
            expect(validate("0 * * * *")).toBe(true);
            expect(validate("0 2 * * *")).toBe(true);
            expect(validate("*/15 * * * *")).toBe(true);
            expect(validate("0,30 * * * *")).toBe(true);
            expect(validate("0 9-17 * * 1-5")).toBe(true);
        });

        test("returns false for invalid cron expressions", () => {
            expect(validate("")).toBe(false);
            expect(validate("invalid")).toBe(false);
            expect(validate("0 * * *")).toBe(false);
            expect(validate("60 * * * *")).toBe(false);
            expect(validate("* 25 * * *")).toBe(false);
            expect(validate("* * 32 * *")).toBe(false);
            expect(validate("* * * 13 *")).toBe(false);
            expect(validate("* * * * 7")).toBe(false);
        });

        test("handles non-string input gracefully", () => {
            expect(validate(123)).toBe(false);
            expect(validate(null)).toBe(false);
            expect(validate(undefined)).toBe(false);
            expect(validate({})).toBe(false);
            expect(validate([])).toBe(false);
        });
    });

    describe("module exports", () => {
        test("exports parseCronExpression function", () => {
            expect(typeof parseCronExpression).toBe("function");
        });

        test("exports isInvalidCronExpressionError function", () => {
            expect(typeof isInvalidCronExpressionError).toBe("function");
        });

        test("parseCronExpression works as expected", () => {
            const result = parseCronExpression("0 * * * *");
            expect(result).toBeDefined();
            expect(result.minute).toEqual([0]);
        });

        test("isInvalidCronExpressionError works as expected", () => {
            let thrownError;
            try {
                parseCronExpression("invalid");
            } catch (error) {
                thrownError = error;
            }
            
            expect(thrownError).toBeDefined();
            expect(isInvalidCronExpressionError(thrownError)).toBe(true);
        });
    });

    describe("compatibility with node-cron interface", () => {
        test("provides same basic interface as node-cron", () => {
            const cron = make();
            
            // node-cron basic interface
            expect(typeof cron.schedule).toBe("function");
            
            // Extended interface for better functionality
            expect(typeof cron.cancel).toBe("function");
            expect(typeof cron.cancelAll).toBe("function");
            expect(typeof cron.getTasks).toBe("function");
        });

        test("schedule function signature matches node-cron", () => {
            const cron = make();
            const callback = jest.fn();
            
            // Should work with same parameters as node-cron
            const result = cron.schedule("0 * * * *", callback);
            expect(isTaskId(result)).toBe(true); // Returns TaskId instead of task object
        });
    });
});
