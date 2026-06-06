/**
 * Tests for deterministic revdeps ordering in identifier-native graph_state.js.
 *
 * Verifies that ensureReverseDepsIndexed always produces lexicographically
 * sorted identifier arrays regardless of insertion order.
 */

const { makeGraphStorage } = require("../src/generators/incremental_graph/graph_state");
const {
    nodeIdentifierFromString,
    nodeIdentifierToDatabaseKey,
    nodeIdentifierToString,
} = require("../src/generators/incremental_graph/database");

function makeInMemoryDb(table) {
    const store = new Map();
    return {
        async get(key) { return store.get(key); },
        async put(key, value) { store.set(key, value); },
        async noFlushPut(key, value) { store.set(key, value); },
        async del(key) { store.delete(key); },
        async noFlushDel(key) { store.delete(key); },
        putOp(key, value) { return { type: "put", table, key, value }; },
        delOp(key) { return { type: "del", table, key }; },
        async *keys() {
            for (const key of [...store.keys()].sort()) {
                yield key;
            }
        },
        apply(operation) {
            if (operation.table !== table) {
                return;
            }
            if (operation.type === "put") {
                store.set(operation.key, operation.value);
                return;
            }
            if (operation.type === "del") {
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
    const global = makeInMemoryDb("global");

    return {
        values,
        freshness,
        inputs,
        revdeps,
        counters,
        timestamps,
        global,
        async batch(operations) {
            for (const operation of operations) {
                values.apply(operation);
                freshness.apply(operation);
                inputs.apply(operation);
                revdeps.apply(operation);
                counters.apply(operation);
                timestamps.apply(operation);
                global.apply(operation);
            }
        },
    };
}

function makeRootDatabase(schemaStorage) {
    return {
        getSchemaStorage() { return schemaStorage; },
    };
}

/**
 * @param {string} identifier
 */
function nid(identifier) {
    return nodeIdentifierFromString(identifier);
}

/**
 * @param {Array<import('../src/generators/incremental_graph/database').NodeIdentifier>} identifiers
 */
function isSorted(identifiers) {
    for (let index = 0; index < identifiers.length - 1; index++) {
        const left = identifiers[index];
        const right = identifiers[index + 1];
        if (left === undefined || right === undefined) {
            throw new Error("Unexpected undefined identifier while checking order");
        }
        if (nodeIdentifierToString(left) > nodeIdentifierToString(right)) {
            return false;
        }
    }
    return true;
}

describe("ensureReverseDepsIndexed – sorted identifier insertion", () => {
    /** @type {ReturnType<typeof makeSchemaStorage>} */
    let schema;
    /** @type {ReturnType<typeof makeGraphStorage>} */
    let storage;

    beforeEach(() => {
        schema = makeSchemaStorage();
        storage = makeGraphStorage(makeRootDatabase(schema));
    });

    test("insert into empty list produces single-element array", async () => {
        const input = nid("1-abcdefghi");
        const dep = nid("2-abcdefghi");

        await storage.withBatch(async (batch) => {
            await storage.ensureReverseDepsIndexed(dep, [input], batch);
        });

        const result = await storage.revdeps.get(input);
        expect(result).toEqual([dep]);
    });

    test("inserts at beginning (new dep sorts before existing)", async () => {
        const input = nid("1-abcdefghi");
        const depB = nid("2-abcdefghi");
        const depA = nid("1-abcdefghi");

        await storage.withBatch(async (batch) => {
            await storage.ensureReverseDepsIndexed(depB, [input], batch);
        });
        await storage.withBatch(async (batch) => {
            await storage.ensureReverseDepsIndexed(depA, [input], batch);
        });

        const result = await storage.revdeps.get(input);
        expect(result).toEqual([depA, depB]);
        expect(isSorted(result)).toBe(true);
    });

    test("inserts at end (new dep sorts after existing)", async () => {
        const input = nid("1-abcdefghi");
        const depA = nid("1-abcdefghi");
        const depB = nid("2-abcdefghi");

        await storage.withBatch(async (batch) => {
            await storage.ensureReverseDepsIndexed(depA, [input], batch);
        });
        await storage.withBatch(async (batch) => {
            await storage.ensureReverseDepsIndexed(depB, [input], batch);
        });

        const result = await storage.revdeps.get(input);
        expect(result).toEqual([depA, depB]);
        expect(isSorted(result)).toBe(true);
    });

    test("inserts in the middle", async () => {
        const input = nid("1-abcdefghi");
        const depA = nid("1-abcdefghi");
        const depC = nid("3-abcdefghi");
        const depB = nid("2-abcdefghi");

        await storage.withBatch(async (batch) => {
            await storage.ensureReverseDepsIndexed(depA, [input], batch);
        });
        await storage.withBatch(async (batch) => {
            await storage.ensureReverseDepsIndexed(depC, [input], batch);
        });
        await storage.withBatch(async (batch) => {
            await storage.ensureReverseDepsIndexed(depB, [input], batch);
        });

        const result = await storage.revdeps.get(input);
        expect(result).toEqual([depA, depB, depC]);
        expect(isSorted(result)).toBe(true);
    });

    test("duplicate insertion is ignored (idempotent)", async () => {
        const input = nid("1-abcdefghi");
        const dep = nid("2-abcdefghi");

        await storage.withBatch(async (batch) => {
            await storage.ensureReverseDepsIndexed(dep, [input], batch);
        });
        await storage.withBatch(async (batch) => {
            await storage.ensureReverseDepsIndexed(dep, [input], batch);
        });
        await storage.withBatch(async (batch) => {
            await storage.ensureReverseDepsIndexed(dep, [input], batch);
        });

        const result = await storage.revdeps.get(input);
        expect(result).toEqual([dep]);
    });

    test("multiple inserts in one batch keep sorted invariant", async () => {
        const input = nid("1-abcdefghi");
        const depC = nid("3-abcdefghi");
        const depA = nid("1-abcdefghi");
        const depB = nid("2-abcdefghi");

        await storage.withBatch(async (batch) => {
            await storage.ensureReverseDepsIndexed(depC, [input], batch);
            await storage.ensureReverseDepsIndexed(depA, [input], batch);
            await storage.ensureReverseDepsIndexed(depB, [input], batch);
        });

        const result = await storage.revdeps.get(input);
        expect(isSorted(result)).toBe(true);
        expect(result).toHaveLength(3);
    });

    test("same dependents inserted in different orders produce identical stored array", async () => {
        const input1 = nid("3-abcdefghi");
        const input2 = nid("4-abcdefghi");
        const depA = nid("1-abcdefghi");
        const depB = nid("2-abcdefghi");
        const depC = nid("3-abcdefghi");

        const schema1 = makeSchemaStorage();
        const storage1 = makeGraphStorage(makeRootDatabase(schema1));
        await storage1.withBatch(async (batch) => {
            await storage1.ensureReverseDepsIndexed(depC, [input1, input2], batch);
            await storage1.ensureReverseDepsIndexed(depA, [input1, input2], batch);
            await storage1.ensureReverseDepsIndexed(depB, [input1, input2], batch);
        });

        const schema2 = makeSchemaStorage();
        const storage2 = makeGraphStorage(makeRootDatabase(schema2));
        await storage2.withBatch(async (batch) => {
            await storage2.ensureReverseDepsIndexed(depB, [input1, input2], batch);
            await storage2.ensureReverseDepsIndexed(depC, [input1, input2], batch);
            await storage2.ensureReverseDepsIndexed(depA, [input1, input2], batch);
        });

        const first1 = await storage1.revdeps.get(input1);
        const first2 = await storage1.revdeps.get(input2);
        const second1 = await storage2.revdeps.get(input1);
        const second2 = await storage2.revdeps.get(input2);

        expect(first1).toEqual(second1);
        expect(first2).toEqual(second2);
        expect(isSorted(first1)).toBe(true);
        expect(isSorted(first2)).toBe(true);
    });

    test("stored representation uses identifier database keys", async () => {
        const input = nid("1-abcdefghi");
        const dep = nid("2-abcdefghi");

        await storage.withBatch(async (batch) => {
            await storage.ensureReverseDepsIndexed(dep, [input], batch);
        });

        const raw = await schema.revdeps.get(nodeIdentifierToDatabaseKey(input));
        expect(raw).toEqual([nodeIdentifierToDatabaseKey(dep)]);
    });
});
