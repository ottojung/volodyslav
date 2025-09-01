const { Duration } = require("luxon");

describe("Luxon Duration", () => {
    describe("Factory functions", () => {
        test("fromObject with seconds creates correct duration", () => {
            const duration = Duration.fromObject({seconds: 5});
            expect(duration.toMillis()).toBe(5000);
            expect(Math.floor(duration.as('seconds'))).toBe(5);
        });

        test("fromMillis creates correct duration", () => {
            const duration = Duration.fromMillis(1500);
            expect(duration.toMillis()).toBe(1500);
            expect(Math.floor(duration.as('seconds'))).toBe(1);
        });

        test("zero duration creation", () => {
            const duration = Duration.fromMillis(0);
            expect(duration.toMillis()).toBe(0);
        });

        test("common durations are available", () => {
            expect(Duration.fromObject({seconds: 1}).toMillis()).toBe(1000);
            expect(Duration.fromObject({minutes: 1}).toMillis()).toBe(60000);
        });
    });

    describe("Duration operations", () => {
        test("plus combines durations", () => {
            const d1 = Duration.fromObject({seconds: 3});
            const d2 = Duration.fromObject({seconds: 2});
            const result = d1.plus(d2);
            expect(Math.floor(result.as('seconds'))).toBe(5);
        });

        test("minus removes duration", () => {
            const d1 = Duration.fromObject({seconds: 5});
            const d2 = Duration.fromObject({seconds: 2});
            const result = d1.minus(d2);
            expect(Math.floor(result.as('seconds'))).toBe(3);
        });

        test("mapUnits scales duration", () => {
            const d1 = Duration.fromObject({seconds: 3});
            const result = d1.mapUnits(x => x * 2);
            expect(Math.floor(result.as('seconds'))).toBe(6);
        });

        test("compare works with valueOf", () => {
            const d1 = Duration.fromObject({seconds: 3});
            const d2 = Duration.fromObject({seconds: 5});
            expect(d1.toMillis() < d2.toMillis()).toBe(true);
            expect(d2.toMillis() > d1.toMillis()).toBe(true);
            expect(d1.toMillis() === d1.toMillis()).toBe(true);
        });
    });

    describe("Type guards", () => {
        test("Duration.isDuration correctly identifies Duration objects", () => {
            const duration = Duration.fromObject({seconds: 1});
            expect(Duration.isDuration(duration)).toBe(true);
            expect(Duration.isDuration({})).toBe(false);
            expect(Duration.isDuration(null)).toBe(false);
        });

        test("Error handling for invalid inputs", () => {
            expect(() => Duration.fromObject({seconds: NaN})).toThrow();
            expect(() => Duration.fromObject({seconds: Infinity})).toThrow();
        });
    });

    describe("String representation", () => {
        test("toString formats duration appropriately", () => {
            expect(Duration.fromMillis(500).toString()).toBe("PT0.5S");
            expect(Duration.fromObject({seconds: 30}).toString()).toBe("PT30S");
            expect(Duration.fromObject({minutes: 1, seconds: 30}).toString()).toBe("PT1M30S");
            expect(Duration.fromObject({hours: 1}).toString()).toBe("PT1H");
        });
    });

    describe("Error handling", () => {
        test("allows negative duration (Luxon behavior)", () => {
            const negDuration = Duration.fromObject({seconds: -1});
            expect(negDuration.toString()).toBe("PT-1S");
            expect(Duration.fromMillis(-100).toString()).toBe("PT-0.1S");
        });

        test("throws on invalid input", () => {
            expect(() => Duration.fromObject({seconds: NaN})).toThrow();
            expect(() => Duration.fromObject({seconds: Infinity})).toThrow();
        });
    });
});