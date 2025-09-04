
const { getNextExecution, getMostRecentExecution } = require("../src/scheduler/calculator");
const { parseCronExpression } = require("../src/scheduler/expression");
const { fromISOString } = require("../src/datetime");

function next(cronExprStr, fromISOStringStr) {
    const expr = parseCronExpression(cronExprStr);
    const from = fromISOString(fromISOStringStr);
    const date = getNextExecution(expr, from);
    return date.toISOString();
}

function prev(cronExprStr, fromISOStringStr) {
    const expr = parseCronExpression(cronExprStr);
    const from = fromISOString(fromISOStringStr);
    const date = getMostRecentExecution(expr, from);
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

    test("exclusive semantics: next('* * * * *') from exact boundary goes to next minute", () => {
        expect(next("* * * * *", "2025-01-01T00:00:00.000Z")).toBe("2025-01-01T00:01:00.000Z");
    });

    test("hour must be revalidated even if minute matched without carry (15 10 * * *)", () => {
        // From 11:14, next valid is *next day* 10:15 (not today 11:15, because 11 is invalid hour)
        expect(next("15 10 * * *", "2025-01-01T11:14:00.000Z")).toBe("2025-01-02T10:15:00.000Z");
    });

    test.failing("DOW=7 should match Sunday (0) the same as DOW=0", () => {
        expect(next("0 12 * * 7", "2025-01-05T11:00:00.000Z")).toBe("2025-01-05T12:00:00.000Z"); // 2025-01-05 is Sunday
    });

    test.failing("DOM/DOW OR semantics: fire on the 1st even if not Monday (0 9 1 * 1)", () => {
        // Jan 1, 2025 is Wednesday; should still fire at 09:00 because DOM=1
        expect(next("0 9 1 * 1", "2025-01-01T08:59:00.000Z")).toBe("2025-01-01T09:00:00.000Z");
    });

    test.failing("DOM/DOW OR semantics: also fire on next Monday even if not the 1st (0 9 1 * 1)", () => {
        // From Jan 2, 2025 → next Monday is Jan 6 at 09:00
        expect(next("0 9 1 * 1", "2025-01-02T10:00:00.000Z")).toBe("2025-01-06T09:00:00.000Z");
    });

    test("DOM=31 should skip months without 31 days", () => {
        expect(next("0 0 31 * *", "2025-04-01T00:00:00.000Z")).toBe("2025-05-31T00:00:00.000Z");
    });

    test.failing("leap day: next Feb 29 should be 2028 if starting in 2025", () => {
        expect(next("0 0 29 2 *", "2025-02-01T00:00:00.000Z")).toBe("2028-02-29T00:00:00.000Z");
    });

    test("month list warp (next): 0 0 1 4,7,10 * from Oct 1 goes to next Apr 1", () => {
        expect(next("0 0 1 4,7,10 *", "2025-10-01T00:00:00.000Z")).toBe("2026-04-01T00:00:00.000Z");
    });

    test("hour range: 0 8-17 * * * from 17:01 jumps to next day 08:00", () => {
        expect(next("0 8-17 * * *", "2025-01-14T17:01:00.000Z")).toBe("2025-01-15T08:00:00.000Z");
    });

    test("minute steps align forward: */15 * * * * from :07 first at :15", () => {
        expect(next("*/15 * * * *", "2025-01-14T10:07:00.000Z")).toBe("2025-01-14T10:15:00.000Z");
    });

    test("DOW wildcard (explicit 0..6) should behave like '*'", () => {
        expect(next("0 12 3 * *", "2025-01-01T10:00:00.000Z")).toBe("2025-01-03T12:00:00.000Z");
        expect(next("0 12 3 * 0,1,2,3,4,5,6", "2025-01-01T10:00:00.000Z")).toBe("2025-01-03T12:00:00.000Z");
    });

    test("compound: */15 8-17 20 * * late on 20th → next month 20 at 08:00", () => {
        expect(next("*/15 8-17 20 * *", "2025-01-20T17:50:00.000Z")).toBe("2025-02-20T08:00:00.000Z");
    });

    test("DOM-only: 0 12 13 * * should fire regardless of weekday", () => {
        expect(next("0 12 13 * *", "2025-01-13T11:59:00.000Z")).toBe("2025-01-13T12:00:00.000Z"); // Jan 13, 2025 is Monday; weekday irrelevant
    });

    test("DOW-only: 0 12 * * 1 (Monday) should ignore DOM and pick next Monday", () => {
        expect(next("0 12 * * 1", "2025-01-01T10:00:00.000Z")).toBe("2025-01-06T12:00:00.000Z");
    });
});

describe("getMostRecentExecution", () => {
    test("calculates previous minute execution", () => {
        expect(prev("0 * * * *", "2024-01-01T14:30:00.000Z")).toBe("2024-01-01T14:00:00.000Z");
    });

    test.failing("calculates previous daily execution", () => {
        expect(prev("0 2 * * *", "2024-01-02T14:30:00.000Z")).toBe("2024-01-02T02:00:00.000Z");
    });

    test("calculates previous execution within same hour", () => {
        expect(prev("45 * * * *", "2024-01-01T14:50:00.000Z")).toBe("2024-01-01T14:45:00.000Z");
    });

    test.failing("handles end of month correctly", () => {
        expect(prev("0 0 1 * *", "2024-02-15T00:00:00.000Z")).toBe("2024-02-01T00:00:00.000Z");
    });

    test.failing("handles February 29th in leap year", () => {
        expect(prev("0 0 29 2 *", "2024-03-01T00:00:00.000Z")).toBe("2024-02-29T00:00:00.000Z");
    });

    test("handles step values correctly", () => {
        expect(prev("*/10 * * * *", "2024-01-01T14:35:00.000Z")).toBe("2024-01-01T14:30:00.000Z");
    });

    test("inclusive semantics: prev('* * * * *') returns the current minute when matching", () => {
        expect(prev("* * * * *", "2025-01-01T14:30:00.000Z")).toBe("2025-01-01T14:30:00.000Z");
    });

    test.failing("previous daily: prev('0 2 * * *') from same day afternoon → 02:00 that day", () => {
        expect(prev("0 2 * * *", "2024-01-02T14:30:00.000Z")).toBe("2024-01-02T02:00:00.000Z");
    });

    test("previous within same hour: prev('45 * * * *') from :50 → :45", () => {
        expect(prev("45 * * * *", "2024-01-01T14:50:00.000Z")).toBe("2024-01-01T14:45:00.000Z");
    });

    test.failing("previous month boundary: prev('0 0 1 * *') mid-Feb → Feb 1", () => {
        expect(prev("0 0 1 * *", "2024-02-15T00:00:00.000Z")).toBe("2024-02-01T00:00:00.000Z");
    });

    test.failing("previous leap day: prev('0 0 29 2 *') on 2024-03-01 → 2024-02-29", () => {
        expect(prev("0 0 29 2 *", "2024-03-01T00:00:00.000Z")).toBe("2024-02-29T00:00:00.000Z");
    });

    test("previous step values align: prev('*/10 * * * *') from :35 → :30", () => {
        expect(prev("*/10 * * * *", "2024-01-01T14:35:00.000Z")).toBe("2024-01-01T14:30:00.000Z");
    });

    test.failing("DOW=7 previous should match Sunday same as 0", () => {
        // From Monday 00:00 → previous Sunday 12:00
        expect(prev("0 12 * * 7", "2025-01-06T00:00:00.000Z")).toBe("2025-01-05T12:00:00.000Z");
    });

    test.failing("DOM/DOW OR semantics for previous: closer of Jan 1 or previous Monday", () => {
        // From Jan 2, 2025 morning → expected Jan 1, 2025 12:00 (closer than Mon Dec 30, 2024)
        expect(prev("0 12 1 * 1", "2025-01-02T10:00:00.000Z")).toBe("2025-01-01T12:00:00.000Z");
    });

    test.failing("previous must revalidate hour even if minute underflow is not needed (15 10 * * *)", () => {
        // From 14:16, previous should be 10:15 (not 14:15 because 14 is invalid hour)
        expect(prev("15 10 * * *", "2025-01-02T14:16:00.000Z")).toBe("2025-01-02T10:15:00.000Z");
    });

    test.failing("month list wraparound (previous): 0 0 1 4,7,10 * from 2025-01-01 → 2024-10-01", () => {
        expect(prev("0 0 1 4,7,10 *", "2025-01-01T12:00:00.000Z")).toBe("2024-10-01T00:00:00.000Z");
    });

    test("previous DOW-only: 0 12 * * 1 from Mon 11:00 → previous Monday 12:00", () => {
        expect(prev("0 12 * * 1", "2025-01-06T11:00:00.000Z")).toBe("2024-12-30T12:00:00.000Z");
    });

    test("previous minute step alignment: prev('*/15 * * * *') from :01 → :00", () => {
        expect(prev("*/15 * * * *", "2025-01-14T10:01:00.000Z")).toBe("2025-01-14T10:00:00.000Z");
    });
});
