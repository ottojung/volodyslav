
const { getNextExecution } = require("../src/scheduler/calculator");
const { parseCronExpression } = require("../src/scheduler/expression");
const { fromISOString } = require("../src/datetime");

function next(cronExprStr, fromISOStringStr) {
    const expr = parseCronExpression(cronExprStr);
    const from = fromISOString(fromISOStringStr);
    const date = getNextExecution(expr, from);
    return date.toISOString();
}

describe("getNextExecution", () => {
    test("calculates next minute execution", () => {
        expect(next("0 * * * *", "2024-01-01T14:30:00.000Z")).toBe("2024-01-01T15:00:00.000Z");
    });

    test("calculates next daily execution", () => {
        expect(next("0 2 * * *", "2024-01-01T14:30:00.000Z")).toBe("2024-01-02T02:00:00.000Z");
    });

    test("calculates next execution within same hour", () => {
        expect(next("45 * * * *", "2024-01-01T14:30:00.000Z")).toBe("2024-01-01T14:45:00.000Z");
    });

    test("handles end of month correctly", () => {
        expect(next("0 0 1 * *", "2024-01-31T23:59:00.000Z")).toBe("2024-02-01T00:00:00.000Z");
    });

    test("handles February 29th in leap year", () => {
        expect(next("0 0 29 2 *", "2024-02-28T00:00:00.000Z")).toBe("2024-02-29T00:00:00.000Z");
    });

    test("handles step values correctly", () => {
        expect(next("*/10 * * * *", "2024-01-01T14:25:00.000Z")).toBe("2024-01-01T14:30:00.000Z");
    });

    test("handles complex range and step combinations", () => {
        const expr = parseCronExpression("10-50/10 * * * *");
        expect(expr.minute).toEqual([10, 20, 30, 40, 50]);
    });
});
