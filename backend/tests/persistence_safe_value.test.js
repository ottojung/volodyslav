const {
    findInvalidPersistenceSafeValue,
    isInvalidPersistenceSafeValueError,
} = require("../src/generators/incremental_graph/database/persistence_safe_value");

describe("persistence-safe ordinary JSON values", () => {
    test("accepts values whose JSON round trip preserves semantic structure", () => {
        const values = [
            null, false, true, -1.5, 0, "", "text", [],
            [1, { nested: [null, true] }], {}, { second: 2, first: 1 },
        ];
        for (const value of values) {
            expect(findInvalidPersistenceSafeValue(value)).toBeUndefined();
            expect(JSON.parse(JSON.stringify(value))).toEqual(value);
        }
    });

    test("rejects values with lossy or active JSON semantics", () => {
        class Instance {}
        const cycle = {};
        cycle.self = cycle;
        const sparse = [];
        sparse.length = 1;
        const outsideArrayIndex = [];
        Object.defineProperty(outsideArrayIndex, "4294967295", {
            value: 1,
            enumerable: true,
        });
        const accessor = {};
        Object.defineProperty(accessor, "value", {
            enumerable: true,
            get: () => 1,
        });
        const invalidValues = [
            undefined, Number.NaN, Infinity, -Infinity, 1n, Symbol("x"),
            () => 1, Object.create(Date.prototype), new Instance(),
            Object.create(null), { toJSON() { return "changed"; } }, accessor,
            sparse, outsideArrayIndex, [undefined], cycle,
            { nested: [Object.create(Date.prototype)] },
            new Proxy({}, {}),
        ];

        for (const value of invalidValues) {
            const invalid = findInvalidPersistenceSafeValue(value);
            expect(isInvalidPersistenceSafeValueError(invalid)).toBe(true);
        }
    });
});
