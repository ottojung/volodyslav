
const { parseCronExpression } = require("../src/scheduler/expression");
const { fromObject, fromISOString } = require("../src/datetime");
const { matchesCronExpression, getMostRecentExecution } = require("../src/scheduler/calculator");

function prev(cronExprStr, fromISOStringStr) {
    const expr = parseCronExpression(cronExprStr);
    const from = fromISOString(fromISOStringStr);
    const date = getMostRecentExecution(expr, from);
    return date.toISOString();
}

const ONE_MINUTE = fromObject({ minutes: 1 });
function naivePrev(cronExprStr, fromISOStringStr) {
    const expr = parseCronExpression(cronExprStr);
    const from = fromISOString(fromISOStringStr);
    let candidate = from.startOfMinute();
    while (candidate.year > from.year - 10) {
        if (matchesCronExpression(expr, candidate)) {
            return candidate.toISOString();
        }
        candidate = candidate.subtract(ONE_MINUTE);
    }

    throw new Error("naivePrev: exceeded iteration limit");
}

describe("Compared to reference implementation", () => {

    for (const minute of ["*", "0"]) {
        for (const hour of ["*", "0"]) {
            for (const dom of ["*", "1"]) {
                for (const month of ["*"]) {
                    for (const dow of ["*"]) {
                        const expr = `${minute} ${hour} ${dom} ${month} ${dow}`;
                        for (const date of ["2024-02-29T23:59:59.999Z", "2025-12-31T00:00:00.000Z"]) {
                            test(`fuzz prev: ${expr} from ${date}`, () => {
                                const result = prev(expr, date);
                                const expected = naivePrev(expr, date);
                                expect(result).toBe(expected);
                            });
                        }
                    }
                }
            }
        }
    }

});
