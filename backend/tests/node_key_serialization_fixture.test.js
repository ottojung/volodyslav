const nodeKeyVectors = require("../../scripts/fixtures/node-key-serialization.json");
const {
    isInvalidConstValueError,
    serializeNodeKey,
    stringToNodeName,
} = require("../src/generators/incremental_graph/database/node_key");

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
});
