/**
 * Tests for deterministic revdeps ordering in migration_runner.js.
 *
 * Verifies that applyDecisions always produces sorted revdeps arrays
 * regardless of Map/Set insertion order.
 */

const { runMigration } = require("../src/generators/incremental_graph/migration_runner");
const { serializeNodeKey } = require("../src/generators/incremental_graph/database/node_key");
const { compareNodeKeyStringByNodeKey } = require("../src/generators/incremental_graph/database/node_key");
const { stringToNodeName } = require("../src/generators/incremental_graph/database");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger, stubDatetime, stubEnvironment } = require("./stubs");

jest.mock('../src/generators/incremental_graph/database', () => ({
    ...jest.requireActual('../src/generators/incremental_graph/database'),
    checkpointMigration: jest.fn(),
}));
const { checkpointMigration: mockCheckpointMigration } = require('../src/generators/incremental_graph/database');

// ---------------------------------------------------------------------------
// In-memory database stubs
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
            if (operation.table === table) {
                if (operation.type === "put") {
                    store.set(operation.key, operation.value);
                } else if (operation.type === "del") {
                    store.delete(operation.key);
                }
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

function makeRootDatabaseMock({ prevVersion, currentVersion, xStorage, yStorage }) {
    const rootDatabase = {
        version: currentVersion,
        async getMetaVersion() { return prevVersion; },
        getSchemaStorage() { return xStorage; },
        currentReplicaName() { return 'x'; },
        otherReplicaName() { return 'y'; },
        schemaStorageForReplica(name) { return name === 'x' ? xStorage : yStorage; },
        async clearReplicaStorage(_name) {},
        async setMetaVersionForReplica(_name, _v) {},
        async switchToReplica(_name) {},
        async setMetaVersion(_v) {},
        async _rawSync() {},
    };
    return { rootDatabase };
}

async function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    mockCheckpointMigration.mockReset();
    mockCheckpointMigration.mockImplementation(async (_caps, _db, _pre, _post, callback) => await callback());
    capabilities.checkpointMigration = mockCheckpointMigration;
    return capabilities;
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
describe("migration revdeps ordering", () => {
    test("migration sorts revdeps even when decision iteration order differs from sort order", async () => {
        const capabilities = await getTestCapabilities();

        const inputKey = nks("input");
        const depC = nks("c");
        const depA = nks("a");
        const depB = nks("b");

        // Previous storage: three dependents all depending on inputKey.
        // The Map in applyDecisions iterates in insertion order (depC, depA, depB).
        const xStorage = makeSchemaStorage();
        await xStorage.inputs.put(depC, { inputs: [inputKey], inputCounters: [1] });
        await xStorage.inputs.put(depA, { inputs: [inputKey], inputCounters: [1] });
        await xStorage.inputs.put(depB, { inputs: [inputKey], inputCounters: [1] });
        await xStorage.values.put(depC, { type: "all_events", events: [] });
        await xStorage.values.put(depA, { type: "all_events", events: [] });
        await xStorage.values.put(depB, { type: "all_events", events: [] });
        await xStorage.freshness.put(depC, "up-to-date");
        await xStorage.freshness.put(depA, "up-to-date");
        await xStorage.freshness.put(depB, "up-to-date");
        // Also need inputKey itself as a node
        await xStorage.inputs.put(inputKey, { inputs: [], inputCounters: [] });
        await xStorage.values.put(inputKey, { type: "all_events", events: [] });
        await xStorage.freshness.put(inputKey, "up-to-date");

        const yStorage = makeSchemaStorage();
        
        const { rootDatabase } = makeRootDatabaseMock({
            prevVersion: "1",
            currentVersion: "2",
            xStorage,
            yStorage,
        });

        const nodeDefs = [
            {
                output: "input",
                inputs: [],
                computor: async () => ({ type: "all_events", events: [] }),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "a",
                inputs: ["input"],
                computor: async () => ({ type: "all_events", events: [] }),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "b",
                inputs: ["input"],
                computor: async () => ({ type: "all_events", events: [] }),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "c",
                inputs: ["input"],
                computor: async () => ({ type: "all_events", events: [] }),
                isDeterministic: true,
                hasSideEffects: false,
            },
        ];

        await runMigration(capabilities, rootDatabase, nodeDefs, async (storage) => {
            await storage.keep(inputKey);
            await storage.keep(depC);
            await storage.keep(depA);
            await storage.keep(depB);
        });

        const resultRevdeps = await yStorage.revdeps.get(inputKey);
        expect(resultRevdeps).toBeDefined();
        expect(isSorted(resultRevdeps)).toBe(true);
        expect(resultRevdeps).toEqual([depA, depB, depC]);
    });

    test("migration result is stable across repeated identical runs", async () => {
        const capabilities1 = await getTestCapabilities();
        const capabilities2 = await getTestCapabilities();

        const inputKey = nks("input");
        const depZ = nks("z");
        const depA = nks("a");
        const depM = nks("m");

        async function makeStorageWithDeps() {
            const s = makeSchemaStorage();
            for (const dep of [depZ, depA, depM]) {
                await s.inputs.put(dep, { inputs: [inputKey], inputCounters: [1] });
                await s.values.put(dep, { type: "all_events", events: [] });
                await s.freshness.put(dep, "up-to-date");
            }
            await s.inputs.put(inputKey, { inputs: [], inputCounters: [] });
            await s.values.put(inputKey, { type: "all_events", events: [] });
            await s.freshness.put(inputKey, "up-to-date");
            return s;
        }

        const nodeDefs = [
            {
                output: "input",
                inputs: [],
                computor: async () => ({ type: "all_events", events: [] }),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "z",
                inputs: ["input"],
                computor: async () => ({ type: "all_events", events: [] }),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "a",
                inputs: ["input"],
                computor: async () => ({ type: "all_events", events: [] }),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "m",
                inputs: ["input"],
                computor: async () => ({ type: "all_events", events: [] }),
                isDeterministic: true,
                hasSideEffects: false,
            },
        ];

        const yStorage1 = makeSchemaStorage();
        const yStorage2 = makeSchemaStorage();
        
        

        const { rootDatabase: rootDatabase1 } = makeRootDatabaseMock({
            prevVersion: "1",
            currentVersion: "2",
            xStorage: await makeStorageWithDeps(),
            yStorage: yStorage1,
        });
        const { rootDatabase: rootDatabase2 } = makeRootDatabaseMock({
            prevVersion: "1",
            currentVersion: "2",
            xStorage: await makeStorageWithDeps(),
            yStorage: yStorage2,
        });

        async function keepAll(storage) {
            await storage.keep(inputKey);
            await storage.keep(depZ);
            await storage.keep(depA);
            await storage.keep(depM);
        }

        await runMigration(capabilities1, rootDatabase1, nodeDefs, keepAll);
        await runMigration(capabilities2, rootDatabase2, nodeDefs, keepAll);

        const result1 = await yStorage1.revdeps.get(inputKey);
        const result2 = await yStorage2.revdeps.get(inputKey);
        expect(result1).toEqual(result2);
        expect(isSorted(result1)).toBe(true);
    });

    test("migration with fan-in/fan-out graph produces sorted revdeps arrays", async () => {
        const capabilities = await getTestCapabilities();

        // Fan-out: sharedInput → depA, depB, depC
        // Fan-in: depA, depB both also depend on anotherInput
        const sharedInput = nks("shared_input");
        const anotherInput = nks("another_input");
        const depA = nks("a");
        const depB = nks("b");
        const depC = nks("c");

        const xStorage = makeSchemaStorage();

        // Set up nodes
        await xStorage.inputs.put(sharedInput, { inputs: [], inputCounters: [] });
        await xStorage.inputs.put(anotherInput, { inputs: [], inputCounters: [] });
        await xStorage.inputs.put(depA, { inputs: [sharedInput, anotherInput], inputCounters: [1, 1] });
        await xStorage.inputs.put(depB, { inputs: [sharedInput, anotherInput], inputCounters: [1, 1] });
        await xStorage.inputs.put(depC, { inputs: [sharedInput], inputCounters: [1] });

        for (const key of [sharedInput, anotherInput, depA, depB, depC]) {
            await xStorage.values.put(key, { type: "all_events", events: [] });
            await xStorage.freshness.put(key, "up-to-date");
        }

        const yStorage = makeSchemaStorage();
        
        const { rootDatabase } = makeRootDatabaseMock({
            prevVersion: "1",
            currentVersion: "2",
            xStorage,
            yStorage,
        });

        const nodeDefs = [
            { output: "shared_input", inputs: [], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false },
            { output: "another_input", inputs: [], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false },
            { output: "a", inputs: ["shared_input", "another_input"], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false },
            { output: "b", inputs: ["shared_input", "another_input"], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false },
            { output: "c", inputs: ["shared_input"], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false },
        ];

        await runMigration(capabilities, rootDatabase, nodeDefs, async (storage) => {
            await storage.keep(sharedInput);
            await storage.keep(anotherInput);
            await storage.keep(depA);
            await storage.keep(depB);
            await storage.keep(depC);
        });

        const sharedRevdeps = await yStorage.revdeps.get(sharedInput);
        const anotherRevdeps = await yStorage.revdeps.get(anotherInput);

        expect(sharedRevdeps).toBeDefined();
        expect(anotherRevdeps).toBeDefined();
        expect(isSorted(sharedRevdeps)).toBe(true);
        expect(isSorted(anotherRevdeps)).toBe(true);

        // sharedInput is depended on by depA, depB, depC
        expect(sharedRevdeps).toHaveLength(3);
        expect(sharedRevdeps).toEqual([depA, depB, depC]);

        // anotherInput is depended on by depA, depB
        expect(anotherRevdeps).toHaveLength(2);
        expect(anotherRevdeps).toEqual([depA, depB]);
    });
});
