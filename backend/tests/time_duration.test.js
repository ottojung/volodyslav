const { fromSeconds, fromMilliseconds, zero, COMMON } = require("../src/time_duration");
const { isTimeDuration, isInvalidDurationError } = require("../src/time_duration");

describe("TimeDuration", () => {
    describe("Factory functions", () => {
        test("fromSeconds creates correct duration", () => {
            const duration = fromSeconds(5);
            expect(duration.toMilliseconds()).toBe(5000);
            expect(duration.toSeconds()).toBe(5);
        });

        test("fromMilliseconds creates correct duration", () => {
            const duration = fromMilliseconds(1500);
            expect(duration.toMilliseconds()).toBe(1500);
            expect(duration.toSeconds()).toBe(1);
        });

        test("zero creates zero duration", () => {
            const duration = zero();
            expect(duration.toMilliseconds()).toBe(0);
        });

        test("COMMON durations are available", () => {
            expect(COMMON.ONE_SECOND.toMilliseconds()).toBe(1000);
            expect(COMMON.ONE_MINUTE.toMilliseconds()).toBe(60000);
        });
    });

    describe("Duration operations", () => {
        test("add combines durations", () => {
            const d1 = fromSeconds(3);
            const d2 = fromSeconds(2);
            const result = d1.add(d2);
            expect(result.toSeconds()).toBe(5);
        });

        test("subtract removes duration", () => {
            const d1 = fromSeconds(5);
            const d2 = fromSeconds(2);
            const result = d1.subtract(d2);
            expect(result.toSeconds()).toBe(3);
        });

        test("multiply scales duration", () => {
            const d1 = fromSeconds(3);
            const result = d1.multiply(2);
            expect(result.toSeconds()).toBe(6);
        });

        test("compare works correctly", () => {
            const d1 = fromSeconds(3);
            const d2 = fromSeconds(5);
            expect(d1.compare(d2)).toBe(-1);
            expect(d2.compare(d1)).toBe(1);
            expect(d1.compare(d1)).toBe(0);
        });
    });

    describe("Type guards", () => {
        test("isTimeDuration correctly identifies TimeDuration objects", () => {
            const duration = fromSeconds(1);
            expect(isTimeDuration(duration)).toBe(true);
            expect(isTimeDuration({})).toBe(false);
            expect(isTimeDuration(null)).toBe(false);
        });

        test("isInvalidDurationError correctly identifies errors", () => {
            expect(isInvalidDurationError(new Error())).toBe(false);

            expect(() => fromSeconds(-1)).toThrow();
        });
    });

    describe("String representation", () => {
        test("toString formats duration appropriately", () => {
            expect(fromMilliseconds(500).toString()).toBe("500ms");
            expect(fromSeconds(30).toString()).toBe("30s");
            expect(fromSeconds(90).toString()).toBe("1m");
            expect(fromSeconds(3700).toString()).toBe("1h");
        });
    });

    describe("Error handling", () => {
        test("throws on negative duration", () => {
            expect(() => fromSeconds(-1)).toThrow();
            expect(() => fromMilliseconds(-100)).toThrow();
        });

        test("throws on invalid input", () => {
            expect(() => fromSeconds(NaN)).toThrow();
            expect(() => fromSeconds(Infinity)).toThrow();
        });
    });
});
