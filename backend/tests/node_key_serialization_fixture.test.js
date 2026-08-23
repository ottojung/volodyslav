const nodeKeyVectors = require("../../scripts/fixtures/node-key-serialization.json");
const {
    isInvalidConstValueError,
    serializeNodeKey,
    stringToNodeName,
} = require("../src/generators/incremental_graph/database/node_key");
const { fromISOString } = require("../src/datetime");

describe("shared NodeKey serialization vectors", () => {
    test.each(nodeKeyVectors)("production serializes $description canonically", vector => {
        const serialized = serializeNodeKey({
            head: stringToNodeName(vector.nodeName),
            args: vector.bindings,
        });

        expect(serialized).toBe(vector.serialized);
    });

    test.each([NaN, Infinity, -Infinity])("rejects non-finite ConstValue number %p", value => {
        /** @type {unknown} */
        let caughtError;
        try {
            serializeNodeKey({
                head: stringToNodeName("node"),
                args: [{ nested: [value] }],
            });
        } catch (error) {
            caughtError = error;
        }
        expect(isInvalidConstValueError(caughtError)).toBe(true);
    });

    test.each([
        new Map(),
        BigInt(1),
        fromISOString("2025-01-01T00:00:00.000Z"),
    ])("rejects non-JSON ConstValue %p", value => {
        expect(() => serializeNodeKey({
            head: stringToNodeName("node"),
            args: [value],
        })).toThrow("Invalid ConstValue");
    });

    test("rejects JSON hooks, accessors, and sparse arrays without aliasing", () => {
        const transforming = { x: 1 };
        Object.defineProperty(transforming, "toJSON", {
            enumerable: false,
            value() { return "alias"; },
        });
        const accessor = {};
        Object.defineProperty(accessor, "x", { enumerable: true, get() { return 1; } });
        const sparse = [];
        sparse.length = 1;

        for (const value of [transforming, accessor, sparse]) {
            expect(() => serializeNodeKey({
                head: stringToNodeName("node"),
                args: [value],
            })).toThrow("Invalid ConstValue");
        }
        expect(serializeNodeKey({
            head: stringToNodeName("node"),
            args: ["alias"],
        })).toBe('{"head":"node","args":["alias"]}');
    });
});
