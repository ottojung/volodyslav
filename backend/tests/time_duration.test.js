const { fromMilliseconds, fromSeconds, fromMinutes, fromHours, fromObject, isDuration } = require("../src/datetime");

describe("Luxon Duration", () => {
    describe("Factory functions", () => {
        test("fromObject with seconds creates correct duration", () => {
            const duration = fromSeconds(5);
            expect(duration.toMillis()).toBe(5000);
            expect(Math.floor(duration.as('seconds'))).toBe(5);
        });

        test("fromMilliseconds creates correct duration", () => {
            const duration = fromMilliseconds(1500);
            expect(duration.toMillis()).toBe(1500);
            expect(Math.floor(duration.as('seconds'))).toBe(1);
        });

        test("zero duration creation", () => {
            const duration = fromMilliseconds(0);
            expect(duration.toMillis()).toBe(0);
        });

        test("common durations are available", () => {
            expect(fromSeconds(1).toMillis()).toBe(1000);
            expect(fromMinutes(1).toMillis()).toBe(60000);
        });
    });

    describe("Duration operations", () => {
        test("plus combines durations", () => {
            const d1 = fromSeconds(3);
            const d2 = fromSeconds(2);
            const result = d1.plus(d2);
            expect(Math.floor(result.as('seconds'))).toBe(5);
        });

        test("minus removes duration", () => {
            const d1 = fromSeconds(5);
            const d2 = fromSeconds(2);
            const result = d1.minus(d2);
            expect(Math.floor(result.as('seconds'))).toBe(3);
        });

        test("mapUnits scales duration", () => {
            const d1 = fromSeconds(3);
            const result = d1.mapUnits(x => x * 2);
            expect(Math.floor(result.as('seconds'))).toBe(6);
        });

        test("compare works with valueOf", () => {
            const d1 = fromSeconds(3);
            const d2 = fromSeconds(5);
            expect(d1.toMillis() < d2.toMillis()).toBe(true);
            expect(d2.toMillis() > d1.toMillis()).toBe(true);
            expect(d1.toMillis() === d1.toMillis()).toBe(true);
        });
    });

    describe("Type guards", () => {
        test("Duration.isDuration correctly identifies Duration objects", () => {
            const duration = fromSeconds(1);
            expect(isDuration(duration)).toBe(true);
            expect(isDuration({})).toBe(false);
            expect(isDuration(null)).toBe(false);
        });

        test("Error handling for invalid inputs", () => {
            expect(() => fromSeconds(NaN)).toThrow();
            expect(() => fromSeconds(Infinity)).toThrow();
        });
    });

    describe("String representation", () => {
        test("toString formats duration appropriately", () => {
            expect(fromMilliseconds(500).toString()).toBe("PT0.5S");
            expect(fromSeconds(30).toString()).toBe("PT30S");
            expect(fromObject({ minutes: 1, seconds: 30 }).toString()).toBe("PT1M30S");
            expect(fromHours(1).toString()).toBe("PT1H");
        });
    });

    describe("Error handling", () => {
        test("allows negative duration (Luxon behavior)", () => {
            const negDuration = fromSeconds(-1);
            expect(negDuration.toString()).toBe("PT-1S");
            expect(fromMilliseconds(-100).toString()).toBe("PT-0.1S");
        });

        test("throws on invalid input", () => {
            expect(() => fromSeconds(NaN)).toThrow();
            expect(() => fromSeconds(Infinity)).toThrow();
        });
    });
});