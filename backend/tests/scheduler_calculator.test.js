
const { getNextExecution } = require("../src/scheduler/calculator");
const { parseCronExpression } = require("../src/scheduler/expression");
const { fromISOString } = require("../src/datetime");

describe("getNextExecution", () => {
    test("calculates next minute execution", () => {
        const expr = parseCronExpression("0 * * * *");
        // Jan 1, 2024 at 2:30 PM
        const from = fromISOString("2024-01-01T14:30:00.000Z");
        const next = getNextExecution(expr, from);

        expect(next.hour).toBe(15); // hours
        expect(next.minute).toBe(0); // minutes
        expect(next.second).toBe(0); // seconds
    });

    test("calculates next daily execution", () => {
        const expr = parseCronExpression("0 2 * * *");
        // Jan 1, 2024 at 2:30 PM
        const from = fromISOString("2024-01-01T14:30:00.000Z");
        const next = getNextExecution(expr, from);

        expect(next.day).toBe(2); // day
        expect(next.hour).toBe(2); // hours
        expect(next.minute).toBe(0); // minutes
    });

    test("calculates next execution within same hour", () => {
        const expr = parseCronExpression("45 * * * *");
        // Jan 1, 2024 at 2:30 PM
        const from = fromISOString("2024-01-01T14:30:00.000Z");
        const next = getNextExecution(expr, from);

        expect(next.hour).toBe(14); // hours
        expect(next.minute).toBe(45); // minutes
    });

    test("handles end of month correctly", () => {
        const expr = parseCronExpression("0 0 1 * *"); // First day of month
        // Jan 31, 2024 at 11:59 PM
        const from = fromISOString("2024-01-31T23:59:00.000Z");
        const next = getNextExecution(expr, from);

        expect(next.month).toBe(2); // February (month)
        expect(next.day).toBe(1); // day
        expect(next.hour).toBe(0); // hours
        expect(next.minute).toBe(0); // minutes
    });

    test("handles February 29th in leap year", () => {
        const expr = parseCronExpression("0 0 29 2 *");
        // Feb 28, 2024 (leap year)
        const from = fromISOString("2024-02-28T00:00:00.000Z");
        const next = getNextExecution(expr, from);

        expect(next.month).toBe(2); // February (month)
        expect(next.day).toBe(29); // day
    });

    test("handles step values correctly", () => {
        const expr = parseCronExpression("*/10 * * * *");
        // Jan 1, 2024 at 2:25 PM - should get next execution at 2:30 PM  
        const from = fromISOString("2024-01-01T14:25:00.000Z");
        const next = getNextExecution(expr, from);

        expect(next.minute).toBe(30); // minutes
    });

    test("handles complex range and step combinations", () => {
        const expr = parseCronExpression("10-50/10 * * * *");
        expect(expr.minute).toEqual([10, 20, 30, 40, 50]);
    });
});
