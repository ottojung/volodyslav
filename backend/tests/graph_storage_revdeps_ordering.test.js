/**
 * Tests for deterministic revdeps ordering in graph_storage.js.
 *
 * Verifies that ensureReverseDepsIndexed always produces sorted arrays
 * regardless of insertion order.
 */

const { makeGraphStorage } = require("../src/generators/incremental_graph/graph_storage");
const { serializeNodeKey } = require("../src/generators/incremental_graph/database/node_key");
const { compareNodeKeyStringByNodeKey } = require("../src/generators/incremental_graph/database/node_key");
const { stringToNodeName } = require("../src/generators/incremental_graph/database");

// ---------------------------------------------------------------------------
// In-memory database stubs (copied from migration_runner.test.js pattern)
// ---------------------------------------------------------------------------
function makeInMemoryDb(table) {
    const store = new Map();
    return {
        async get(key) { return store.get(key); },
        async put(key, value) { store.set(key, value); },
        async rawPut(key, value) { store.set(key, value); },
        async del(key) { store.delete(key); },
        async rawDel(key) { store.delete(key); },
        putOp(key, value) { return { type: "put", table, key, value }; },
        rawPutOp(key, value) { return { type: "put", table, key, value }; },
        delOp(key) { return { type: "del", table, key }; },
        async *keys() {
            for (const key of [...store.keys()].sort()) yield key;
        },
        apply(operation) {
            if (operation.table !== table) return;
            if (operation.type === "put") {
                store.set(operation.key, operation.value);
            } else if (operation.type === "del") {
                store.delete(operation.key);
            }
        },
    };
}

function makeSchemaStorage() {
    const values = makeInMemoryDb("values");
    const freshness = makeInMemoryDb("freshness");
    const inputs = makeInMemoryDb("inputs");
    const revdeps = makeInMemoryDb("revdeps");
    const counters = makeInMemoryDb("counters");
    const timestamps = makeInMemoryDb("timestamps");

    return {
        values,
        freshness,
        inputs,
        revdeps,
        counters,
        timestamps,
        async batch(operations) {
            for (const operation of operations) {
                values.apply(operation);
                freshness.apply(operation);
                inputs.apply(operation);
                revdeps.apply(operation);
                counters.apply(operation);
                timestamps.apply(operation);
            }
        },
    };
}

function makeRootDatabase(schemaStorage) {
    return {
        getSchemaStorage() { return schemaStorage; },
    };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * @param {string} head
 * @param {Array<unknown>} args
 */
function nks(head, args = []) {
    return serializeNodeKey({ head: stringToNodeName(head), args });
}

/**
 * Returns true if the array is sorted according to compareNodeKeyStringByNodeKey.
 * @param {string[]} arr
 */
function isSorted(arr) {
    for (let i = 0; i < arr.length - 1; i++) {
        if (compareNodeKeyStringByNodeKey(arr[i], arr[i + 1]) > 0) {
            return false;
        }
    }
    return true;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("ensureReverseDepsIndexed – sorted insertion", () => {
    /** @type {ReturnType<typeof makeSchemaStorage>} */
    let schema;
    /** @type {ReturnType<typeof makeGraphStorage>} */
    let storage;

    beforeEach(() => {
        schema = makeSchemaStorage();
        storage = makeGraphStorage(makeRootDatabase(schema));
    });

    test("insert into empty list produces single-element array", async () => {
        const input = nks("input");
        const dep = nks("dep");

        await storage.withBatch(async (batch) => {
            await storage.ensureReverseDepsIndexed(dep, [input], batch);
        });

        const result = await schema.revdeps.get(input);
        expect(result).toEqual([dep]);
    });

    test("inserts at beginning (new dep sorts before existing)", async () => {
        const input = nks("input");
        const depB = nks("b");
        const depA = nks("a"); // "a" < "b"

        await storage.withBatch(async (batch) => {
            await storage.ensureReverseDepsIndexed(depB, [input], batch);
        });
        await storage.withBatch(async (batch) => {
            await storage.ensureReverseDepsIndexed(depA, [input], batch);
        });

        const result = await schema.revdeps.get(input);
        expect(result).toEqual([depA, depB]);
        expect(isSorted(result)).toBe(true);
    });

    test("inserts at end (new dep sorts after existing)", async () => {
        const input = nks("input");
        const depA = nks("a");
        const depB = nks("b"); // "b" > "a"

        await storage.withBatch(async (batch) => {
            await storage.ensureReverseDepsIndexed(depA, [input], batch);
        });
        await storage.withBatch(async (batch) => {
            await storage.ensureReverseDepsIndexed(depB, [input], batch);
        });

        const result = await schema.revdeps.get(input);
        expect(result).toEqual([depA, depB]);
        expect(isSorted(result)).toBe(true);
    });

    test("inserts in the middle", async () => {
        const input = nks("input");
        const depA = nks("a");
        const depC = nks("c");
        const depB = nks("b"); // should go between a and c

        await storage.withBatch(async (batch) => {
            await storage.ensureReverseDepsIndexed(depA, [input], batch);
        });
        await storage.withBatch(async (batch) => {
            await storage.ensureReverseDepsIndexed(depC, [input], batch);
        });
        await storage.withBatch(async (batch) => {
            await storage.ensureReverseDepsIndexed(depB, [input], batch);
        });

        const result = await schema.revdeps.get(input);
        expect(result).toEqual([depA, depB, depC]);
        expect(isSorted(result)).toBe(true);
    });

    test("duplicate insertion is ignored (idempotent)", async () => {
        const input = nks("input");
        const dep = nks("dep");

        await storage.withBatch(async (batch) => {
            await storage.ensureReverseDepsIndexed(dep, [input], batch);
        });
        await storage.withBatch(async (batch) => {
            await storage.ensureReverseDepsIndexed(dep, [input], batch);
        });
        await storage.withBatch(async (batch) => {
            await storage.ensureReverseDepsIndexed(dep, [input], batch);
        });

        const result = await schema.revdeps.get(input);
        expect(result).toEqual([dep]);
    });

    test("multiple inserts in one batch keep sorted invariant", async () => {
        const input = nks("input");
        const depC = nks("c");
        const depA = nks("a");
        const depB = nks("b");

        await storage.withBatch(async (batch) => {
            await storage.ensureReverseDepsIndexed(depC, [input], batch);
            await storage.ensureReverseDepsIndexed(depA, [input], batch);
            await storage.ensureReverseDepsIndexed(depB, [input], batch);
        });

        const result = await schema.revdeps.get(input);
        expect(isSorted(result)).toBe(true);
        expect(result).toHaveLength(3);
    });

    test("same dependents inserted in different orders produce identical stored array", async () => {
        const input1 = nks("input1");
        const input2 = nks("input2");
        const depA = nks("a");
        const depB = nks("b");
        const depC = nks("c");

        // Storage 1: insert A, B, C
        const schema1 = makeSchemaStorage();
        const storage1 = makeGraphStorage(makeRootDatabase(schema1));
        await storage1.withBatch(async (batch) => {
            await storage1.ensureReverseDepsIndexed(depA, [input1], batch);
        });
        await storage1.withBatch(async (batch) => {
            await storage1.ensureReverseDepsIndexed(depB, [input1], batch);
        });
        await storage1.withBatch(async (batch) => {
            await storage1.ensureReverseDepsIndexed(depC, [input1], batch);
        });

        // Storage 2: insert C, A, B (different order)
        const schema2 = makeSchemaStorage();
        const storage2 = makeGraphStorage(makeRootDatabase(schema2));
        await storage2.withBatch(async (batch) => {
            await storage2.ensureReverseDepsIndexed(depC, [input2], batch);
        });
        await storage2.withBatch(async (batch) => {
            await storage2.ensureReverseDepsIndexed(depA, [input2], batch);
        });
        await storage2.withBatch(async (batch) => {
            await storage2.ensureReverseDepsIndexed(depB, [input2], batch);
        });

        const result1 = await schema1.revdeps.get(input1);
        const result2 = await schema2.revdeps.get(input2);
        expect(result1).toEqual(result2);
        expect(isSorted(result1)).toBe(true);
    });

    test("mixed heads and arg shapes sort deterministically", async () => {
        const input = nks("input");
        // variety of dep keys
        const deps = [
            nks("z"),
            nks("a"),
            nks("m"),
            nks("f", [null]),
            nks("f", [false]),
            nks("f", [1]),
            nks("f", ["hello"]),
            nks("f", [[]]),
            nks("f", [{}]),
        ];

        // Insert in original order
        for (const dep of deps) {
            await storage.withBatch(async (batch) => {
                await storage.ensureReverseDepsIndexed(dep, [input], batch);
            });
        }

        const result1 = await schema.revdeps.get(input);
        expect(isSorted(result1)).toBe(true);

        // Insert in reversed order on a fresh storage
        const schema2 = makeSchemaStorage();
        const storage2 = makeGraphStorage(makeRootDatabase(schema2));
        for (const dep of [...deps].reverse()) {
            await storage2.withBatch(async (batch) => {
                await storage2.ensureReverseDepsIndexed(dep, [input], batch);
            });
        }

        const result2 = await schema2.revdeps.get(input);
        expect(result1).toEqual(result2);
    });

    test("multiple inputs each get correctly sorted revdeps", async () => {
        const inputX = nks("x");
        const inputY = nks("y");
        const depB = nks("b");
        const depA = nks("a");

        await storage.withBatch(async (batch) => {
            // Both deps depend on both inputs
            await storage.ensureReverseDepsIndexed(depB, [inputX, inputY], batch);
            await storage.ensureReverseDepsIndexed(depA, [inputX, inputY], batch);
        });

        const resultX = await schema.revdeps.get(inputX);
        const resultY = await schema.revdeps.get(inputY);
        expect(isSorted(resultX)).toBe(true);
        expect(isSorted(resultY)).toBe(true);
        expect(resultX).toEqual([depA, depB]);
        expect(resultY).toEqual([depA, depB]);
    });
});
