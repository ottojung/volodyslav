const nodeKeyVectors = require("../../scripts/fixtures/node-key-serialization.json");
const {
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
});
