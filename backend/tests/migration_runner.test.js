const { runMigration } = require("../src/generators/incremental_graph/migration_runner");
const { compileNodeDef } = require("../src/generators/incremental_graph/compiled_node");
const {
    IDENTIFIERS_KEY,
    GRAPH_SCHEME_KEY,
    nodeIdentifierToString,
    buildGraphSchemeFromNodeDefs,
    serializeGraphScheme,
    isMissingGraphSchemeError,
} = require("../src/generators/incremental_graph/database");
const {
    isUndecidedNodes,
    isPartialDeleteFanIn,
    isDecisionConflict,
} = require("../src/generators/incremental_graph");
const { toJsonKey } = require("./test_json_key_helper");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger, stubDatetime, stubEnvironment } = require("./stubs");
jest.mock('../src/generators/incremental_graph/database', () => ({
    ...jest.requireActual('../src/generators/incremental_graph/database'),
    checkpointMigration: jest.fn(),
}));
const { checkpointMigration: mockCheckpointMigration } = require('../src/generators/incremental_graph/database');

const validationActual = jest.requireActual('../src/generators/incremental_graph/database/sync_merge_validation');
jest.mock('../src/generators/incremental_graph/database/sync_merge_validation', () => ({
    ...jest.requireActual('../src/generators/incremental_graph/database/sync_merge_validation'),
    assertValidFinalMergeState: jest.fn(),
}));
const {
    assertValidFinalMergeState,
    FinalMergeStateError,
    isFinalMergeStateError,
} = require("../src/generators/incremental_graph/database/sync_merge_validation");
const {
    makeIdentifierLookup,
} = require("../src/generators/incremental_graph/database");

/**
 * Get the migrated identifier for a given node key from the storage's global IDENTIFIERS_KEY.
 * @param {import('../src/generators/incremental_graph/database').SchemaStorage} storage
 * @param {string} nodeKey
 * @returns {Promise<string>}
 */
async function getMigratedKey(storage, nodeKey) {
    const entries = await storage.global.get(IDENTIFIERS_KEY);
    if (!entries) return nodeKey;
    const entry = entries.find(([, key]) => String(key) === nodeKey);
    return entry ? nodeIdentifierToString(entry[0]) : nodeKey;
}

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
    const global = makeInMemoryDb("global");
    const valid = makeInMemoryDb("valid");
    const timestamps = makeInMemoryDb("timestamps");

    // Tests use simplified mocks where the "NodeIdentifier" string is the same
    // as the semantic node key JSON string. When identifiers_keys_map is not
    // explicitly seeded, fall back to an identity mapping derived from values.
    const originalValuesPut = values.put.bind(values);
    values.put = async (key, value) => {
        await originalValuesPut(key, value);
        if (await timestamps.get(key) === undefined) {
            await timestamps.put(key, { createdAt: "2024-01-01T00:00:00.000Z", modifiedAt: "2024-01-01T00:00:00.000Z" });
        }
        if (await freshness.get(key) === undefined) {
            await freshness.put(key, "up-to-date");
        }
    };

    const originalGlobalGet = global.get.bind(global);
    global.get = async (key) => {
        if (key !== IDENTIFIERS_KEY) {
            return await originalGlobalGet(key);
        }

        const stored = await originalGlobalGet(key);
        if (stored !== undefined) return stored;

        const out = [];
        for await (const k of values.keys()) {
            out.push([k, k]);
        }
        return out;
    };

    return {
        values,
        freshness,
        global,
        valid,
        timestamps,
        async batch(operations) {
            for (const operation of operations) {
                values.apply(operation);
                freshness.apply(operation);
                global.apply(operation);
                valid.apply(operation);
                timestamps.apply(operation);
            }
        },
    };
}

/**
 * Build a standard in-memory rootDatabase mock.
 * @param {object} opts
 * @param {string|undefined} opts.prevVersion - what getGlobalVersion returns
 * @param {string} opts.currentVersion - version field on rootDatabase
 * @param {object} opts.xStorage - the x-namespace SchemaStorage
 * @param {object} opts.yStorage - the y-namespace SchemaStorage
 * @returns {{ rootDatabase: any, setCurrentReplicaPointerCalled: boolean }}
 */
function makeRootDatabaseMock({ prevVersion, currentVersion, xStorage, yStorage }) {
    let setCurrentReplicaPointerCalled = false;
    let setCurrentReplicaPointerCalledWith = undefined;
    let clearReplicaStorageCalledWith = undefined;
    let setGlobalVersionCalledWith = undefined;

    const rootDatabase = {
        version: currentVersion,
        async getGlobalVersion() { return prevVersion; },
        getSchemaStorage() { return xStorage; },
        currentReplicaName() { return 'x'; },
        otherReplicaName() { return 'y'; },
        schemaStorageForReplica(name) {
            if (name === 'x') {
                return xStorage;
            }
            if (name === 'y') {
                return yStorage;
            }
            throw new Error(`Unexpected replica name: ${name}`);
        },
        async clearReplicaStorage(name) { clearReplicaStorageCalledWith = name; },
        async setCurrentReplicaPointer(name) {
            setCurrentReplicaPointerCalled = true;
            setCurrentReplicaPointerCalledWith = name;
        },
        async setGlobalVersion(v) {
            setGlobalVersionCalledWith = v;
        },
        async _rawSync() {},
        getFingerprint() { return 'testmigrfinprt'; },
        getVersion() { return this.version; },
        getLastNodeIndex() { return this._computed.lastNodeIndex; },
        advanceLastNodeIndex(value) { this._computed.lastNodeIndex = Math.max(this._computed.lastNodeIndex, value); },
        _computed: { lastNodeIndex: 0 },
    };

    return {
        rootDatabase,
        get setCurrentReplicaPointerCalled() { return setCurrentReplicaPointerCalled; },
        get setCurrentReplicaPointerCalledWith() { return setCurrentReplicaPointerCalledWith; },
        get clearReplicaStorageCalledWith() { return clearReplicaStorageCalledWith; },
        get setGlobalVersionCalledWith() { return setGlobalVersionCalledWith; },
    };
}

/**
 * Creates a yStorage and wraps it for backward compatibility with tests that
 * previously used makeYDb to create a yDb object.
 * Now simply returns the storage as yStorage.
 * @param {object} storage - The y-namespace SchemaStorage
 * @returns {{ yStorage: object }}
 */
function makeYDb(storage) {
    return { yStorage: storage };
}

/**
 * Creates test capabilities.
 * @returns {Promise<object>}
 */
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

/**
 * Seed a graph_scheme in xStorage from the given nodeDefs.
 * Used by tests where auto-generation from valid cannot infer dependency edges.
 * @param {import('../src/generators/incremental_graph/database').SchemaStorage} storage
 * @param {Array<import('../src/generators/incremental_graph/types').NodeDef>} nodeDefs
 */
async function seedGraphScheme(storage, nodeDefs) {
    const compiledNodes = nodeDefs.map(compileNodeDef);
    const scheme = serializeGraphScheme(buildGraphSchemeFromNodeDefs(compiledNodes));
    await storage.global.put(GRAPH_SCHEME_KEY, JSON.stringify(scheme));
}

/**
 * Seed the standard zero-arity A graph scheme used by single-node tests.
 * @param {import('../src/generators/incremental_graph/database').SchemaStorage} storage
 */
async function seedSingleAGraphScheme(storage) {
    await seedGraphScheme(storage, [{
        output: "A",
        inputs: [],
        computor: async () => ({ type: "all_events", events: [] }),
        isDeterministic: true,
        hasSideEffects: false,
    }]);
}

/**
 * Builds a minimal but representative migration scenario.
 * The xStorage has one node ("A") that the migration callback can act upon.
 */
function makeSimpleMigrationSetup({ prevVersion = "1.0.0", currentVersion = "2.0.0" } = {}) {
    const xStorage = makeSchemaStorage();
    const yStorage = makeSchemaStorage();
    const nodeKey = toJsonKey("A");
    const nodeDefs = [{
        output: "A",
        inputs: [],
        computor: async () => ({ type: "all_events", events: [] }),
        isDeterministic: true,
        hasSideEffects: false,
    }];
    const { rootDatabase } = makeRootDatabaseMock({
        prevVersion,
        currentVersion,
        xStorage,
        yStorage,
    });
    return { rootDatabase, nodeDefs, nodeKey, xStorage, yStorage };
}

beforeEach(() => {
    assertValidFinalMergeState.mockImplementation(
        (storage, lookup) => validationActual.assertValidFinalMergeState(storage, lookup)
    );
});

describe("runMigration", () => {

    test("versioned source without graph_scheme fails before activating target", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");
        const value = { type: "all_events", events: [] };

        await xStorage.values.put(nodeKey, value);
        await xStorage.freshness.put(nodeKey, "up-to-date");
        await xStorage.global.put("version", "1.0.0");
        await xStorage.global.put(IDENTIFIERS_KEY, [[nodeKey, nodeKey]]);

        const mock = makeRootDatabaseMock({
            prevVersion: "1.0.0",
            currentVersion: "2.0.0",
            xStorage,
            yStorage,
        });
        const nodeDefs = [{
            output: "A",
            inputs: [],
            computor: async () => value,
            isDeterministic: true,
            hasSideEffects: false,
        }];

        let caught;
        try {
            await runMigration(capabilities, mock.rootDatabase, nodeDefs, async (storage) => {
                await storage.keep(nodeKey);
            });
        } catch (error) {
            caught = error;
        }

        expect(caught).toBeDefined();
        expect(String(caught && caught.message)).toContain("global/graph_scheme");
        expect(isMissingGraphSchemeError(caught)).toBe(true);
        expect(mock.setCurrentReplicaPointerCalled).toBe(false);
        expect(mock.setCurrentReplicaPointerCalledWith).toBeUndefined();
        expect(await yStorage.global.get("version")).toBeUndefined();
    });

    test("cyclic schema is rejected before migration writes target state", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const aKey = toJsonKey("A");
        const bKey = toJsonKey("B");

        await xStorage.values.put(aKey, { type: "all_events", events: [] });
        await xStorage.values.put(bKey, { type: "all_events", events: [] });
        await xStorage.freshness.put(aKey, "up-to-date");
        await xStorage.freshness.put(bKey, "up-to-date");
        await xStorage.global.put("version", "1.0.0");
        await xStorage.global.put(IDENTIFIERS_KEY, [[aKey, aKey], [bKey, bKey]]);

        // seed a valid old graph scheme for the source replica
        const validDefs = [
            { output: "A", inputs: [], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: false, hasSideEffects: false },
            { output: "B", inputs: ["A"], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: false, hasSideEffects: false },
        ];
        await seedGraphScheme(xStorage, validDefs);

        // The new schema has a cycle (A -> B -> A)
        const cyclicDefs = [
            { output: "A", inputs: ["B(x)"], computor: async () => ({ value: "a" }), isDeterministic: false, hasSideEffects: false },
            { output: "B", inputs: ["A(x)"], computor: async () => ({ value: "b" }), isDeterministic: false, hasSideEffects: false },
        ];

        const mock = makeRootDatabaseMock({
            prevVersion: "1.0.0",
            currentVersion: "2.0.0",
            xStorage,
            yStorage,
        });

        let caught;
        try {
            await runMigration(capabilities, mock.rootDatabase, cyclicDefs, async (_storage) => {
                throw new Error("migration callback should not be called");
            });
        } catch (error) {
            caught = error;
        }

        expect(caught).toBeDefined();
        expect(mock.setCurrentReplicaPointerCalled).toBe(false);
        expect(await yStorage.global.get("version")).toBeUndefined();
        expect(await yStorage.values.get(aKey)).toBeUndefined();
    });

    test("invalidate preserves graph records from previous storage", async () => {
        const capabilities = await getTestCapabilities();
        const previousStorage = makeSchemaStorage();
        const currentStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");

        await previousStorage.values.put(nodeKey, { type: "all_events", events: [] });
        await previousStorage.freshness.put(nodeKey, "up-to-date");

        const { yStorage } = makeYDb(currentStorage);
        const { rootDatabase } = makeRootDatabaseMock({
            prevVersion: "previous",
            currentVersion: "current",
            xStorage: previousStorage,
            yStorage,
        });

        const nodeDefs = [{
            output: "A",
            inputs: [],
            computor: async () => ({ type: "all_events", events: [] }),
            isDeterministic: true,
            hasSideEffects: false,
        }];

        await seedGraphScheme(previousStorage, nodeDefs);
        await runMigration(capabilities, rootDatabase, nodeDefs, async (storage) => {
            await storage.invalidate(nodeKey);
        });

        const migratedKey = await getMigratedKey(currentStorage, nodeKey);
        await expect(currentStorage.freshness.get(migratedKey)).resolves.toBe("potentially-outdated");
    });

    describe("fresh database (getGlobalVersion returns undefined)", () => {
        test("skips migration and does not switch to replica", async () => {
            const capabilities = await getTestCapabilities();
            const previousStorage = makeSchemaStorage();
            const currentStorage = makeSchemaStorage();
            const { yStorage } = makeYDb(currentStorage);
            const mock = makeRootDatabaseMock({
                prevVersion: undefined,
                currentVersion: "1.0.0",
                xStorage: previousStorage,
                yStorage,
            });

            await runMigration(capabilities, mock.rootDatabase, [], async (_storage) => {
                throw new Error("callback must not be called for a fresh database");
            });

            expect(mock.setCurrentReplicaPointerCalled).toBe(false);
        });

        test("fresh init is now owned by prepareIncrementalGraphStorage, not runMigration", async () => {
              const capabilities = await getTestCapabilities();
            const xStorage = makeSchemaStorage();
            const { yStorage } = makeYDb(makeSchemaStorage());
            const mock = makeRootDatabaseMock({
                prevVersion: undefined,
                currentVersion: "1.0.0",
                xStorage,
                yStorage,
            });

            await runMigration(capabilities, mock.rootDatabase, [], async () => {});

            // runMigration no longer writes version for fresh databases.
            // Fresh initialization is handled by prepareIncrementalGraphStorage.
            const storedVersion = await xStorage.global.get("version");
            expect(storedVersion).toBeUndefined();
        });

        test("does not call checkpointMigration", async () => {
            const capabilities = await getTestCapabilities();
            const xStorage = makeSchemaStorage();
            const { yStorage } = makeYDb(makeSchemaStorage());
            const mock = makeRootDatabaseMock({
                prevVersion: undefined,
                currentVersion: "1.0.0",
                xStorage,
                yStorage,
            });

            await runMigration(capabilities, mock.rootDatabase, [], async () => {});

            expect(capabilities.checkpointMigration).not.toHaveBeenCalled();
        });

        test("fresh graph_scheme init is owned by prepareIncrementalGraphStorage", async () => {
            const capabilities = await getTestCapabilities();
            const xStorage = makeSchemaStorage();
            const { yStorage } = makeYDb(makeSchemaStorage());
            const mock = makeRootDatabaseMock({
                prevVersion: undefined,
                currentVersion: "1.0.0",
                xStorage,
                yStorage,
            });

            const nodeDefs = [{
                output: "A",
                inputs: [],
                computor: async () => ({ type: "all_events", events: [] }),
                isDeterministic: true,
                hasSideEffects: false,
            }];

            await runMigration(capabilities, mock.rootDatabase, nodeDefs, async () => {});

            // runMigration no longer writes graph_scheme for fresh databases.
            const storedScheme = await xStorage.global.get(GRAPH_SCHEME_KEY);
            expect(storedScheme).toBeUndefined();
        });
    });

    describe("no migration needed (version already matches)", () => {
        test("skips migration and does not switch to replica", async () => {
          const capabilities = await getTestCapabilities();
            const xStorage = makeSchemaStorage();
            const { yStorage } = makeYDb(makeSchemaStorage());
            const mock = makeRootDatabaseMock({
                prevVersion: "1.0.0",
                currentVersion: "1.0.0",
                xStorage,
                yStorage,
            });

            await runMigration(capabilities, mock.rootDatabase, [], async (_storage) => {
                throw new Error("callback must not be called when version matches");
            });

            expect(mock.setCurrentReplicaPointerCalled).toBe(false);
        });

        test("does not call checkpointMigration", async () => {
            const capabilities = await getTestCapabilities();
            const xStorage = makeSchemaStorage();
            const { yStorage } = makeYDb(makeSchemaStorage());
            const mock = makeRootDatabaseMock({
                prevVersion: "1.0.0",
                currentVersion: "1.0.0",
                xStorage,
                yStorage,
            });

            await runMigration(capabilities, mock.rootDatabase, [], async () => {});

            expect(capabilities.checkpointMigration).not.toHaveBeenCalled();
        });
    });

    describe("successful migration", () => {
        test("y namespace is populated with migrated data after successful migration", async () => {
            const capabilities = await getTestCapabilities();
            const xStorage = makeSchemaStorage();
            const nodeKey = toJsonKey("A");
            await xStorage.values.put(nodeKey, { type: "all_events", events: [] });

            const yStorage = makeSchemaStorage();
            const mock = makeRootDatabaseMock({
                prevVersion: "1.0.0",
                currentVersion: "2.0.0",
                xStorage,
                yStorage,
            });

            const nodeDefs = [{
                output: "A",
                inputs: [],
                computor: async () => ({ type: "all_events", events: [] }),
                isDeterministic: true,
                hasSideEffects: false,
            }];

            await seedGraphScheme(xStorage, nodeDefs);
            await runMigration(capabilities, mock.rootDatabase, nodeDefs, async (storage) => {
                await storage.keep(nodeKey);
            });

            // y namespace is populated with the migrated node's stored data.
            const migratedKey = await getMigratedKey(yStorage, nodeKey);
            const migratedValue = await yStorage.values.get(migratedKey);
            expect(migratedValue).toBeDefined();
        });

        test("migration does not transfer valid flags from old graph state", async () => {
            const capabilities = await getTestCapabilities();
            const xStorage = makeSchemaStorage();
            const nodeKey = toJsonKey("A");
            const depKey = toJsonKey("B");

            // Set up xStorage with a node that has valid flags
            await xStorage.values.put(nodeKey, { type: "all_events", events: [] });
            await xStorage.freshness.put(nodeKey, "up-to-date");
            // Store a validity flag in xStorage's valid sublevel
            await xStorage.valid.put(nodeKey, [depKey]);

            const yStorage = makeSchemaStorage();
            const mock = makeRootDatabaseMock({
                prevVersion: "1.0.0",
                currentVersion: "2.0.0",
                xStorage,
                yStorage,
            });

            const nodeDefs = [{
                output: "A",
                inputs: [],
                computor: async () => ({ type: "all_events", events: [] }),
                isDeterministic: true,
                hasSideEffects: false,
            }];

            await seedGraphScheme(xStorage, nodeDefs);
            await runMigration(capabilities, mock.rootDatabase, nodeDefs, async (storage) => {
                await storage.keep(nodeKey);
            });

            // After migration, yStorage must have no valid records.
            // Valid flags are mandatory for every up-to-date input edge;
            // zero-input nodes never have incoming validity.
            const validKeys = [];
            for await (const key of yStorage.valid.keys()) {
                validKeys.push(key);
            }
            expect(validKeys).toEqual([]);
        });

        test("kept node with potentially-outdated freshness does not gain valid flags after migration", async () => {
            const capabilities = await getTestCapabilities();
            const xStorage = makeSchemaStorage();
            const depKey = toJsonKey("A");
            const staleDepKey = toJsonKey("X");
            const keptKey = toJsonKey("B");

            // Set up a graph in xStorage: A (up-to-date, inputs=[]) and X (up-to-date).
            // B depends on both A and X, but B is stale (potentially-outdated).
            // B's inputs are [A, X], but valid is missing for both A and X.
            await xStorage.values.put(depKey, { type: "all_events", events: [] });
            await xStorage.values.put(staleDepKey, { type: "all_events", events: [] });
            await xStorage.values.put(keptKey, { type: "all_events", events: [] });
            await xStorage.values.put(depKey, { type: "all_events", events: [] });
            await xStorage.values.put(staleDepKey, { type: "all_events", events: [] });
            await xStorage.values.put(keptKey, { type: "all_events", events: [] });
            await xStorage.freshness.put(depKey, "up-to-date");
            await xStorage.freshness.put(staleDepKey, "up-to-date");
            await xStorage.freshness.put(keptKey, "potentially-outdated");

            const yStorage = makeSchemaStorage();
            const mock = makeRootDatabaseMock({
                prevVersion: "1.0.0",
                currentVersion: "2.0.0",
                xStorage,
                yStorage,
            });

            const nodeDefs = [
                { output: "A", inputs: [], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false },
                { output: "X", inputs: [], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false },
                { output: "B", inputs: ["A", "X"], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false },
            ];
            // valid is intentionally empty, so auto-generation cannot infer B's dependencies.
            await seedGraphScheme(xStorage, nodeDefs);

            await runMigration(capabilities, mock.rootDatabase, nodeDefs, async (storage) => {
                await storage.keep(depKey);
                await storage.keep(staleDepKey);
                await storage.keep(keptKey);
            });

            const keptMigratedKey = await getMigratedKey(yStorage, keptKey);
            const depMigratedKey = await getMigratedKey(yStorage, depKey);
            const staleDepMigratedKey = await getMigratedKey(yStorage, staleDepKey);

            // A and X are up-to-date keeps with zero inputs → no valid entries for them
            const validADeps = await yStorage.valid.get(depMigratedKey);
            const validXDeps = await yStorage.valid.get(staleDepMigratedKey);
            expect(validADeps).toBeUndefined();
            expect(validXDeps).toBeUndefined();

            // B's freshness remains potentially-outdated (B was not up-to-date before migration)
            const bFreshness = await yStorage.freshness.get(keptMigratedKey);
            expect(bFreshness).toBe("potentially-outdated");

            // B was not up-to-date before migration, so no valid flags were built
            // representing B as a dependent of A or X.
            // The valid sublevel must be empty — B did not gain synthetic validity.
            const allValidKeys = [];
            for await (const key of yStorage.valid.keys()) {
                allValidKeys.push(key);
            }
            expect(allValidKeys).toEqual([]);
        });

        test("preserves existing valid flags for stale kept nodes whose dependency's value is unchanged", async () => {
            // A → B
            // B is potentially-outdated, valid[A] contains B
            // migration keeps A and B
            // after migration valid[A] still contains B
            const capabilities = await getTestCapabilities();
            const xStorage = makeSchemaStorage();
            const aKey = toJsonKey("A");
            const bKey = toJsonKey("B");

            await xStorage.values.put(aKey, { type: "all_events", events: [] });
            await xStorage.values.put(bKey, { type: "all_events", events: [] });
            await xStorage.values.put(aKey, { type: "all_events", events: [] });
            await xStorage.values.put(bKey, { type: "all_events", events: [] });
            await xStorage.freshness.put(aKey, "up-to-date");
            await xStorage.freshness.put(bKey, "potentially-outdated");
            await xStorage.valid.put(aKey, [bKey]);

            const yStorage = makeSchemaStorage();
            const mock = makeRootDatabaseMock({
                prevVersion: "1.0.0",
                currentVersion: "2.0.0",
                xStorage,
                yStorage,
            });

            const nodeDefs = [
                { output: "A", inputs: [], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false },
                { output: "B", inputs: ["A"], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false },
            ];
            // valid[A] = [B] is set above, so auto-generation from valid handles this test.

            await seedGraphScheme(xStorage, nodeDefs);
            await runMigration(capabilities, mock.rootDatabase, nodeDefs, async (storage) => {
                await storage.keep(aKey);
                await storage.keep(bKey);
            });

            const aMigratedKey = await getMigratedKey(yStorage, aKey);
            const bMigratedKey = await getMigratedKey(yStorage, bKey);

            const validA = await yStorage.valid.get(aMigratedKey) ?? [];
            const bIdStr = String(bMigratedKey);
            expect(validA.some(id => String(id) === bIdStr)).toBe(true);
        });

        test("does not invent valid flags for stale kept nodes when valid was absent before migration", async () => {
            // A → B
            // B is potentially-outdated, valid[A] does NOT contain B
            // migration keeps A and B
            // after migration valid[A] still does not contain B
            const capabilities = await getTestCapabilities();
            const xStorage = makeSchemaStorage();
            const aKey = toJsonKey("A");
            const bKey = toJsonKey("B");

            await xStorage.values.put(aKey, { type: "all_events", events: [] });
            await xStorage.values.put(bKey, { type: "all_events", events: [] });
            await xStorage.values.put(aKey, { type: "all_events", events: [] });
            await xStorage.values.put(bKey, { type: "all_events", events: [] });
            await xStorage.freshness.put(aKey, "up-to-date");
            await xStorage.freshness.put(bKey, "potentially-outdated");
            // valid[A] intentionally missing for B

            const yStorage = makeSchemaStorage();
            const mock = makeRootDatabaseMock({
                prevVersion: "1.0.0",
                currentVersion: "2.0.0",
                xStorage,
                yStorage,
            });

            const nodeDefs = [
                { output: "A", inputs: [], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false },
                { output: "B", inputs: ["A"], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false },
            ];
            // valid is intentionally empty, so auto-generation cannot infer B's dependency.
            await seedGraphScheme(xStorage, nodeDefs);

            await runMigration(capabilities, mock.rootDatabase, nodeDefs, async (storage) => {
                await storage.keep(aKey);
                await storage.keep(bKey);
            });

            const aMigratedKey = await getMigratedKey(yStorage, aKey);
            const bMigratedKey = await getMigratedKey(yStorage, bKey);

            const validA = await yStorage.valid.get(aMigratedKey) ?? [];
            const bIdStr = String(bMigratedKey);
            expect(validA.some(id => String(id) === bIdStr)).toBe(false);
        });

        test("writes version to y/global/version before calling setCurrentReplicaPointer", async () => {
            const capabilities = await getTestCapabilities();
            const xStorage = makeSchemaStorage();
            const nodeKey = toJsonKey("A");
            await xStorage.values.put(nodeKey, { type: "all_events", events: [] });

            const callOrder = [];
            let setCurrentReplicaPointerCalled = false;
            const yStorage = makeSchemaStorage();

            // Intercept yStorage.global.noFlushPut to record when version is written.
            const originalNoFlushPut = yStorage.global.noFlushPut.bind(yStorage.global);
            yStorage.global.noFlushPut = async (key, value) => {
                callOrder.push({ action: "globalRawPut", key: String(key), value });
                return originalNoFlushPut(key, value);
            };

            const rootDatabase = {
                version: "2.0.0",
                async getGlobalVersion() { return "1.0.0"; },
                getSchemaStorage() { return xStorage; },
                currentReplicaName() { return 'x'; },
                otherReplicaName() { return 'y'; },
                schemaStorageForReplica(name) { return name === 'x' ? xStorage : yStorage; },
                async clearReplicaStorage(_name) {},
                async setCurrentReplicaPointer(name) {
                    callOrder.push({ action: "setCurrentReplicaPointer", name });
                    setCurrentReplicaPointerCalled = true;
                },
                async setGlobalVersion(_v) {},
                async _rawSync() {},
                getFingerprint() { return 'testmigrfinprt'; },
                getVersion() { return this.version; },
                getLastNodeIndex() { return this._computed.lastNodeIndex; },
                advanceLastNodeIndex(value) { this._computed.lastNodeIndex = Math.max(this._computed.lastNodeIndex, value); },
                _computed: { lastNodeIndex: 0 },
            };

            const nodeDefs = [{
                output: "A",
                inputs: [],
                computor: async () => ({ type: "all_events", events: [] }),
                isDeterministic: true,
                hasSideEffects: false,
            }];

            await seedGraphScheme(xStorage, nodeDefs);
            await runMigration(capabilities, rootDatabase, nodeDefs, async (storage) => {
                await storage.keep(nodeKey);
            });

            expect(setCurrentReplicaPointerCalled).toBe(true);
            // Version must be written to y before setCurrentReplicaPointer is called.
            const versionWriteIdx = callOrder.findIndex(
                (e) => e.action === "globalRawPut" && e.key === "version" && e.value === "2.0.0"
            );
            const switchIdx = callOrder.findIndex((e) => e.action === "setCurrentReplicaPointer");
            expect(versionWriteIdx).toBeGreaterThanOrEqual(0);
            expect(switchIdx).toBeGreaterThan(versionWriteIdx);
            // Also verify the value is readable from yStorage after migration.
            await expect(yStorage.global.get("version")).resolves.toBe("2.0.0");
        });

        test("calls setCurrentReplicaPointer with 'y' on successful migration", async () => {
            const capabilities = await getTestCapabilities();
            const previousStorage = makeSchemaStorage();
            const nodeKey = toJsonKey("A");
            await previousStorage.values.put(nodeKey, { type: "all_events", events: [] });
            await previousStorage.freshness.put(nodeKey, "up-to-date");

            const yStorage = makeSchemaStorage();
            const mock = makeRootDatabaseMock({
                prevVersion: "1.0.0",
                currentVersion: "2.0.0",
                xStorage: previousStorage,
                yStorage,
            });

            const nodeDefs = [{
                output: "A",
                inputs: [],
                computor: async () => ({ type: "all_events", events: [] }),
                isDeterministic: true,
                hasSideEffects: false,
            }];

            await seedGraphScheme(previousStorage, nodeDefs);
            await runMigration(capabilities, mock.rootDatabase, nodeDefs, async (storage) => {
                await storage.keep(nodeKey);
            });

            expect(mock.setCurrentReplicaPointerCalled).toBe(true);
        });

        test("calls checkpointMigration once for the whole migration", async () => {
            const capabilities = await getTestCapabilities();
            const { rootDatabase, nodeDefs, nodeKey, xStorage } = makeSimpleMigrationSetup();
            await xStorage.values.put(nodeKey, { type: "all_events", events: [] });

            await seedGraphScheme(xStorage, nodeDefs);
            await runMigration(capabilities, rootDatabase, nodeDefs, async (storage) => {
                await storage.keep(nodeKey);
            });

            expect(capabilities.checkpointMigration).toHaveBeenCalledTimes(1);
        });

        test("pre-migration checkpoint message contains both the old and new version", async () => {
            const capabilities = await getTestCapabilities();
            const { rootDatabase, nodeDefs, nodeKey, xStorage } = makeSimpleMigrationSetup({
                prevVersion: "1.0.0",
                currentVersion: "2.0.0",
            });
            await xStorage.values.put(nodeKey, { type: "all_events", events: [] });

            await seedGraphScheme(xStorage, nodeDefs);
            await runMigration(capabilities, rootDatabase, nodeDefs, async (storage) => {
                await storage.keep(nodeKey);
            });

            const preMessage = capabilities.checkpointMigration.mock.calls[0][2];
            expect(preMessage).toContain("pre-migration:");
            expect(preMessage).toContain("1.0.0");
            expect(preMessage).toContain("2.0.0");
        });

        test("post-migration checkpoint message contains the new version", async () => {
            const capabilities = await getTestCapabilities();
            const { rootDatabase, nodeDefs, nodeKey, xStorage } = makeSimpleMigrationSetup({
                prevVersion: "1.0.0",
                currentVersion: "2.0.0",
            });
            await xStorage.values.put(nodeKey, { type: "all_events", events: [] });

            await seedGraphScheme(xStorage, nodeDefs);
            await runMigration(capabilities, rootDatabase, nodeDefs, async (storage) => {
                await storage.keep(nodeKey);
            });

            const postMessage = capabilities.checkpointMigration.mock.calls[0][3];
            expect(postMessage).toContain("post-migration:");
            expect(postMessage).toContain("2.0.0");
        });

        test("pre-migration commit happens before setCurrentReplicaPointer inside the checkpointMigration", async () => {
            const capabilities = await getTestCapabilities();
            const callOrder = [];
            capabilities.checkpointMigration.mockImplementation(async (_caps, _db, preMessage, postMessage, callback) => {
                callOrder.push(`checkpoint:${preMessage}`);
                await callback();
                callOrder.push(`checkpoint:${postMessage}`);
            });

            const xStorage = makeSchemaStorage();
            const nodeKey = toJsonKey("A");
            await xStorage.values.put(nodeKey, { type: "all_events", events: [] });

            const yStorage = makeSchemaStorage();
            const rootDatabase = {
                version: "2.0.0",
                async getGlobalVersion() { return "1.0.0"; },
                getSchemaStorage() { return xStorage; },
                currentReplicaName() { return 'x'; },
                otherReplicaName() { return 'y'; },
                schemaStorageForReplica(name) { return name === 'x' ? xStorage : yStorage; },
                async clearReplicaStorage(_name) {},
                async setCurrentReplicaPointer(name) { callOrder.push(`setCurrentReplicaPointer:${name}`); },
                async setGlobalVersion(_v) {},
                async _rawSync() {},
                getFingerprint() { return 'testmigrfinprt'; },
                getVersion() { return this.version; },
                getLastNodeIndex() { return this._computed.lastNodeIndex; },
                advanceLastNodeIndex(value) { this._computed.lastNodeIndex = Math.max(this._computed.lastNodeIndex, value); },
                _computed: { lastNodeIndex: 0 },
            };
            const nodeDefs = [{
                output: "A",
                inputs: [],
                computor: async () => ({ type: "all_events", events: [] }),
                isDeterministic: true,
                hasSideEffects: false,
            }];

            await seedGraphScheme(xStorage, nodeDefs);
            await runMigration(capabilities, rootDatabase, nodeDefs, async (storage) => {
                await storage.keep(nodeKey);
            });

            const preIdx = callOrder.findIndex((e) => typeof e === "string" && e.startsWith("checkpoint:pre-migration"));
            const switchIdx = callOrder.findIndex((e) => typeof e === "string" && e.startsWith("setCurrentReplicaPointer:"));
            expect(preIdx).toBeGreaterThanOrEqual(0);
            expect(switchIdx).toBeGreaterThan(preIdx);
        });

        test("post-migration commit happens after setCurrentReplicaPointer inside the checkpointMigration", async () => {
            const capabilities = await getTestCapabilities();
            const callOrder = [];
            capabilities.checkpointMigration.mockImplementation(async (_caps, _db, preMessage, postMessage, callback) => {
                callOrder.push(`checkpoint:${preMessage}`);
                await callback();
                callOrder.push(`checkpoint:${postMessage}`);
            });

            const xStorage = makeSchemaStorage();
            const nodeKey = toJsonKey("A");
            await xStorage.values.put(nodeKey, { type: "all_events", events: [] });

            const yStorage = makeSchemaStorage();
            const rootDatabase = {
                version: "2.0.0",
                async getGlobalVersion() { return "1.0.0"; },
                getSchemaStorage() { return xStorage; },
                currentReplicaName() { return 'x'; },
                otherReplicaName() { return 'y'; },
                schemaStorageForReplica(name) { return name === 'x' ? xStorage : yStorage; },
                async clearReplicaStorage(_name) {},
                async setCurrentReplicaPointer(name) { callOrder.push(`setCurrentReplicaPointer:${name}`); },
                async setGlobalVersion(_v) {},
                async _rawSync() {},
                getFingerprint() { return 'testmigrfinprt'; },
                getVersion() { return this.version; },
                getLastNodeIndex() { return this._computed.lastNodeIndex; },
                advanceLastNodeIndex(value) { this._computed.lastNodeIndex = Math.max(this._computed.lastNodeIndex, value); },
                _computed: { lastNodeIndex: 0 },
            };
            const nodeDefs = [{
                output: "A",
                inputs: [],
                computor: async () => ({ type: "all_events", events: [] }),
                isDeterministic: true,
                hasSideEffects: false,
            }];

            await seedGraphScheme(xStorage, nodeDefs);
            await runMigration(capabilities, rootDatabase, nodeDefs, async (storage) => {
                await storage.keep(nodeKey);
            });

            const postIdx = callOrder.findIndex((e) => typeof e === "string" && e.startsWith("checkpoint:post-migration"));
            const switchIdx = callOrder.findIndex((e) => typeof e === "string" && e.startsWith("setCurrentReplicaPointer:"));
            expect(postIdx).toBeGreaterThan(switchIdx);
        });
    });

    describe("failure cases", () => {
        test("callback throws: setCurrentReplicaPointer is NOT called and error propagates", async () => {
            const capabilities = await getTestCapabilities();
            const xStorage = makeSchemaStorage();
            const nodeKey = toJsonKey("A");
            await xStorage.values.put(nodeKey, { type: "all_events", events: [] });

            const yMock = makeYDb(makeSchemaStorage());
            const mock = makeRootDatabaseMock({
                prevVersion: "1.0.0",
                currentVersion: "2.0.0",
                xStorage,
                yStorage: yMock.yStorage,
            });

            const nodeDefs = [{
                output: "A",
                inputs: [],
                computor: async () => ({ type: "all_events", events: [] }),
                isDeterministic: true,
                hasSideEffects: false,
            }];

            const callbackError = new Error("callback failure");
            await seedGraphScheme(xStorage, nodeDefs);
            await expect(
                runMigration(capabilities, mock.rootDatabase, nodeDefs, async (_storage) => {
                    throw callbackError;
                })
            ).rejects.toBe(callbackError);

            expect(mock.setCurrentReplicaPointerCalled).toBe(false);
        });

        test("finalize throws UndecidedNodesError when a node has no decision: setCurrentReplicaPointer is NOT called", async () => {
            const capabilities = await getTestCapabilities();
            const xStorage = makeSchemaStorage();
            const nodeKey = toJsonKey("A");
            await xStorage.values.put(nodeKey, { type: "all_events", events: [] });

            const yMock = makeYDb(makeSchemaStorage());
            const mock = makeRootDatabaseMock({
                prevVersion: "1.0.0",
                currentVersion: "2.0.0",
                xStorage,
                yStorage: yMock.yStorage,
            });

            const nodeDefs = [{
                output: "A",
                inputs: [],
                computor: async () => ({ type: "all_events", events: [] }),
                isDeterministic: true,
                hasSideEffects: false,
            }];

            // Callback runs but assigns no decision to node A
            let caughtError;
            try {
                await seedGraphScheme(xStorage, nodeDefs);
                await runMigration(capabilities, mock.rootDatabase, nodeDefs, async (_storage) => {
                    // intentionally leave A undecided
                });
            } catch (err) {
                caughtError = err;
            }

            expect(isUndecidedNodes(caughtError)).toBe(true);
            expect(mock.setCurrentReplicaPointerCalled).toBe(false);
        });

        test("callback throws: unification is not attempted and error propagates", async () => {
            const capabilities = await getTestCapabilities();
            const xStorage = makeSchemaStorage();
            const nodeKey = toJsonKey("A");
            await xStorage.values.put(nodeKey, { type: "all_events", events: [] });

            const yStorage = makeSchemaStorage();
            const mock = makeRootDatabaseMock({
                prevVersion: "1.0.0",
                currentVersion: "2.0.0",
                xStorage,
                yStorage,
            });

            const nodeDefs = [{
                output: "A",
                inputs: [],
                computor: async () => ({ type: "all_events", events: [] }),
                isDeterministic: true,
                hasSideEffects: false,
            }];

            await seedGraphScheme(xStorage, nodeDefs);
            await expect(
                runMigration(capabilities, mock.rootDatabase, nodeDefs, async () => {
                    throw new Error("intentional failure");
                })
            ).rejects.toThrow("intentional failure");

            // unification was never attempted so y namespace is still empty
            expect(mock.setCurrentReplicaPointerCalled).toBe(false);
        });

        test("callback throws: checkpointMigration attempts the pre-migration commit step before failing", async () => {
            const capabilities = await getTestCapabilities();
            const { rootDatabase, nodeDefs, nodeKey, xStorage } = makeSimpleMigrationSetup();
            await xStorage.values.put(nodeKey, { type: "all_events", events: [] });
            const callOrder = [];
            capabilities.checkpointMigration.mockImplementation(async (_caps, _db, preMessage, postMessage, callback) => {
                callOrder.push(`checkpoint:${preMessage}`);
                await callback();
                callOrder.push(`checkpoint:${postMessage}`);
            });

            await seedGraphScheme(xStorage, nodeDefs);
            await expect(
                runMigration(capabilities, rootDatabase, nodeDefs, async () => {
                    throw new Error("intentional failure");
                })
            ).rejects.toThrow("intentional failure");

            expect(capabilities.checkpointMigration).toHaveBeenCalledTimes(1);
            expect(callOrder).toHaveLength(1);
            expect(callOrder[0]).toContain("pre-migration:");
        });

        test("finalize throws: checkpointMigration attempts the pre-migration commit step before failing", async () => {
            const capabilities = await getTestCapabilities();
            const { rootDatabase, nodeDefs, nodeKey, xStorage } = makeSimpleMigrationSetup();
            await xStorage.values.put(nodeKey, { type: "all_events", events: [] });
            const callOrder = [];
            capabilities.checkpointMigration.mockImplementation(async (_caps, _db, preMessage, postMessage, callback) => {
                callOrder.push(`checkpoint:${preMessage}`);
                await callback();
                callOrder.push(`checkpoint:${postMessage}`);
            });

            // Callback runs but assigns no decision → finalize throws UndecidedNodesError
            await seedGraphScheme(xStorage, nodeDefs);
            await expect(
                runMigration(capabilities, rootDatabase, nodeDefs, async (_storage) => {
                    // intentionally leave the node undecided
                })
            ).rejects.toThrow();

            expect(capabilities.checkpointMigration).toHaveBeenCalledTimes(1);
            expect(callOrder).toHaveLength(1);
            expect(callOrder[0]).toContain("pre-migration:");
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers shared by the failure-focused describe blocks below
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read all entries from every sublevel of a SchemaStorage and return them as a
 * plain object whose keys are "sublevel:nodeKey".  Used to assert the
 * x-namespace is byte-for-byte identical before and after a failed migration.
 */
async function captureStorageSnapshot(storage) {
    const snapshot = {};
    for await (const key of storage.values.keys()) {
        snapshot[`values:${key}`] = await storage.values.get(key);
    }
    for await (const key of storage.freshness.keys()) {
        snapshot[`freshness:${key}`] = await storage.freshness.get(key);
    }
    for await (const key of storage.valid.keys()) {
        snapshot[`valid:${key}`] = await storage.valid.get(key);
    }
    for await (const key of storage.timestamps.keys()) {
        snapshot[`timestamps:${key}`] = await storage.timestamps.get(key);
    }
    return snapshot;
}

/** Populate xStorage with realistic data for node "A". */
async function populateNode(storage, nodeKey, {
    value = { type: "all_events", events: [] },
    freshness = "up-to-date",
    timestamps = undefined,
} = {}) {
    await storage.values.put(nodeKey, value);
    await storage.freshness.put(nodeKey, freshness);
    if (timestamps !== undefined) {
        await storage.timestamps.put(nodeKey, timestamps);
    }
}

/** Build a two-node graph where B depends on A (A → B). */
async function buildTwoNodeGraph(storage, nodeKeyA, nodeKeyB, {
    timestampA = undefined,
    timestampB = undefined,
} = {}) {
        await populateNode(storage, nodeKeyA, { timestamps: timestampA });
    await populateNode(storage, nodeKeyB, {
        freshness: "potentially-outdated",
        timestamps: timestampB,
    });
    await storage.valid.put(nodeKeyA, [nodeKeyB]);
}

/** NodeDefs for a two-node schema [A, B]. */
function makeTwoNodeDefs() {
    return ["A", "B"].map((name) => ({
        output: name,
        inputs: name === "B" ? ["A"] : [],
        computor: async () => ({ type: "all_events", events: [] }),
        isDeterministic: true,
        hasSideEffects: false,
    }));
}

/** Build a three-node fan-in graph: A → C, B → C. */
async function buildFanInGraph(storage, nkA, nkB, nkC) {
    await populateNode(storage, nkA);
    await populateNode(storage, nkB);
    await populateNode(storage, nkC);
    await storage.valid.put(nkA, [nkC]);
    await storage.valid.put(nkB, [nkC]);
}

/** NodeDefs for a fan-in schema A→C, B→C. */
function makeFanInNodeDefs() {
    return [
        { output: "A", inputs: [], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false },
        { output: "B", inputs: [], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false },
        { output: "C", inputs: ["A", "B"], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false },
    ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Core invariant: x-namespace data is unchanged after any kind of failure
// ─────────────────────────────────────────────────────────────────────────────

describe("x-namespace state preserved on migration failure", () => {
    test("callback throws synchronously: every x-sublevel entry is identical to before", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");
        await populateNode(xStorage, nodeKey, { freshness: "up-to-date" });
        await seedSingleAGraphScheme(xStorage);

        const { yStorage } = makeYDb(makeSchemaStorage());
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage, yStorage });
        const snapshotBefore = await captureStorageSnapshot(xStorage);

        await expect(
            runMigration(capabilities, rootDatabase, [{ output: "A", inputs: [], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false }],
                async () => { throw new Error("boom"); })
        ).rejects.toThrow("boom");

        expect(await captureStorageSnapshot(xStorage)).toEqual(snapshotBefore);
    });

    test("callback returns rejected promise: every x-sublevel entry is identical to before", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");
        await populateNode(xStorage, nodeKey);
        await seedSingleAGraphScheme(xStorage);

        const { yStorage } = makeYDb(makeSchemaStorage());
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage, yStorage });
        const snapshotBefore = await captureStorageSnapshot(xStorage);

        const rejection = new Error("async rejection");
        await expect(
            runMigration(capabilities, rootDatabase, [{ output: "A", inputs: [], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false }],
                () => Promise.reject(rejection))
        ).rejects.toBe(rejection);

        expect(await captureStorageSnapshot(xStorage)).toEqual(snapshotBefore);
    });

    test("UndecidedNodesError from finalize: x-namespace data unchanged", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const nkA = toJsonKey("A");
        const nkB = toJsonKey("B");
        await populateNode(xStorage, nkA);
        await populateNode(xStorage, nkB, { freshness: "potentially-outdated" });
        await seedGraphScheme(xStorage, makeTwoNodeDefs());

        const { yStorage } = makeYDb(makeSchemaStorage());
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "v1", currentVersion: "v2", xStorage, yStorage });
        const snapshotBefore = await captureStorageSnapshot(xStorage);

        // Callback only decides A, leaves B undecided → UndecidedNodesError
        let caughtUndecided;
        try {
            await seedGraphScheme(xStorage, makeTwoNodeDefs());
            await runMigration(capabilities, rootDatabase, makeTwoNodeDefs(), async (storage) => {
                await storage.keep(nkA);
                // B intentionally left undecided
            });
        } catch (e) { caughtUndecided = e; }
        expect(isUndecidedNodes(caughtUndecided)).toBe(true);

        expect(await captureStorageSnapshot(xStorage)).toEqual(snapshotBefore);
    });

    test("PartialDeleteFanInError from finalize: x-namespace data unchanged", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const [nkA, nkB, nkC] = [toJsonKey("A"), toJsonKey("B"), toJsonKey("C")];
        await buildFanInGraph(xStorage, nkA, nkB, nkC);

        const { yStorage } = makeYDb(makeSchemaStorage());
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "v1", currentVersion: "v2", xStorage, yStorage });
        const snapshotBefore = await captureStorageSnapshot(xStorage);

        // Delete only A but keep B → fan-in violation on C
        let caughtFanIn;
        try {
            await seedGraphScheme(xStorage, makeFanInNodeDefs());
            await runMigration(capabilities, rootDatabase, makeFanInNodeDefs(), async (storage) => {
                await storage.delete(nkA);
                await storage.keep(nkB);
                // C is left for finalize to propagate; PartialDeleteFanIn because B is not deleted
            });
        } catch (e) { caughtFanIn = e; }
        expect(isPartialDeleteFanIn(caughtFanIn)).toBe(true);

        expect(await captureStorageSnapshot(xStorage)).toEqual(snapshotBefore);
    });

    test("DecisionConflictError from callback: x-namespace data unchanged", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");
        await populateNode(xStorage, nodeKey);
        await seedSingleAGraphScheme(xStorage);

        const { yStorage } = makeYDb(makeSchemaStorage());
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage, yStorage });
        const snapshotBefore = await captureStorageSnapshot(xStorage);

        // keep then invalidate on the same node → DecisionConflictError
        let caughtConflict;
        try {
            await runMigration(capabilities, rootDatabase, [{ output: "A", inputs: [], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false }],
                async (storage) => {
                    await storage.keep(nodeKey);
                    await storage.invalidate(nodeKey); // conflicts with keep
                });
        } catch (e) { caughtConflict = e; }
        expect(isDecisionConflict(caughtConflict)).toBe(true);

        expect(await captureStorageSnapshot(xStorage)).toEqual(snapshotBefore);
    });

    test("noFlushPut() throws during unification into y: x-namespace data unchanged, setCurrentReplicaPointer not called", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");
        await populateNode(xStorage, nodeKey);
        await seedSingleAGraphScheme(xStorage);
        const snapshotBefore = await captureStorageSnapshot(xStorage);

        // Build a yStorage whose noFlushPut throws on all sublevels
        const yStorage = makeSchemaStorage();
        const writeError = new Error("write failure");
        for (const name of ['values', 'freshness', 'global', 'valid', 'timestamps']) {
            yStorage[name].noFlushPut = async () => { throw writeError; };
            yStorage[name].noFlushDel = async () => { throw writeError; };
        }

        const mock = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage, yStorage });

        await expect(
            runMigration(capabilities, mock.rootDatabase, [{ output: "A", inputs: [], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false }],
                async (storage) => { await storage.keep(nodeKey); })
        ).rejects.toMatchObject({ cause: writeError });

        expect(mock.setCurrentReplicaPointerCalled).toBe(false);
        expect(await captureStorageSnapshot(xStorage)).toEqual(snapshotBefore);
    });

    test("global.noFlushPut throws during version write: x-namespace data unchanged, setCurrentReplicaPointer not called", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");
        await populateNode(xStorage, nodeKey);
        await seedSingleAGraphScheme(xStorage);
        const snapshotBefore = await captureStorageSnapshot(xStorage);

        const globalWriteError = new Error("global noFlushPut failure");
        const yStorage = makeSchemaStorage();
        // Make yStorage.global.noFlushPut throw so the version write during unification fails.
        yStorage.global.noFlushPut = async () => { throw globalWriteError; };
        yStorage.global.noFlushDel = async () => { throw globalWriteError; };

        const { rootDatabase } = makeRootDatabaseMock({
            prevVersion: "1",
            currentVersion: "2",
            xStorage,
            yStorage,
        });

        await expect(
            runMigration(capabilities, rootDatabase, [{ output: "A", inputs: [], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false }],
                async (storage) => { await storage.keep(nodeKey); })
        ).rejects.toMatchObject({ cause: globalWriteError });

        expect(await captureStorageSnapshot(xStorage)).toEqual(snapshotBefore);
    });

    test("setCurrentReplicaPointer throws: error propagates and x had not been modified before the throw", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");
        await populateNode(xStorage, nodeKey);
        await seedSingleAGraphScheme(xStorage);
        const snapshotBefore = await captureStorageSnapshot(xStorage);

        const swapError = new Error("swap failed");
        const yStorage = makeSchemaStorage();
        // Override setCurrentReplicaPointer to throw without touching xStorage
        const rootDatabase = {
            version: "2",
            async getGlobalVersion() { return "1"; },
            getSchemaStorage() { return xStorage; },
            currentReplicaName() { return 'x'; },
            otherReplicaName() { return 'y'; },
            schemaStorageForReplica(name) { return name === 'x' ? xStorage : yStorage; },
            async clearReplicaStorage(_name) {},
            async setCurrentReplicaPointer() { throw swapError; },
            async setGlobalVersion() {},
            async _rawSync() {},
            getFingerprint() { return 'testmigrfinprt'; },
            getVersion() { return this.version; },
            getLastNodeIndex() { return this._computed.lastNodeIndex; },
            advanceLastNodeIndex(value) { this._computed.lastNodeIndex = Math.max(this._computed.lastNodeIndex, value); },
            _computed: { lastNodeIndex: 0 },
        };

        await expect(
            runMigration(capabilities, rootDatabase, [{ output: "A", inputs: [], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false }],
                async (storage) => { await storage.keep(nodeKey); })
        ).rejects.toBe(swapError);

        // x was never modified by migration code — only setCurrentReplicaPointer would do that
        expect(await captureStorageSnapshot(xStorage)).toEqual(snapshotBefore);
    });

    test("multi-node graph: all x-values intact after UndecidedNodesError", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const nkA = toJsonKey("A");
        const nkB = toJsonKey("B");
        await buildTwoNodeGraph(xStorage, nkA, nkB);

        const { yStorage } = makeYDb(makeSchemaStorage());
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "v1", currentVersion: "v2", xStorage, yStorage });
        const snapshotBefore = await captureStorageSnapshot(xStorage);

        // Only decide A; B is left undecided
        let caughtUndecided2;
        try {
            await seedGraphScheme(xStorage, makeTwoNodeDefs());
            await runMigration(capabilities, rootDatabase, makeTwoNodeDefs(), async (storage) => {
                await storage.keep(nkA);
            });
        } catch (e) { caughtUndecided2 = e; }
        expect(isUndecidedNodes(caughtUndecided2)).toBe(true);

        expect(await captureStorageSnapshot(xStorage)).toEqual(snapshotBefore);
    });

    test("multi-node graph: freshness and values preserved after callback error", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const nkA = toJsonKey("A");
        const nkB = toJsonKey("B");
        await buildTwoNodeGraph(xStorage, nkA, nkB);

        const { yStorage } = makeYDb(makeSchemaStorage());
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "v1", currentVersion: "v2", xStorage, yStorage });

        await seedGraphScheme(xStorage, makeTwoNodeDefs());
        await expect(
            runMigration(capabilities, rootDatabase, makeTwoNodeDefs(), async (storage) => {
                await storage.keep(nkA);
                throw new Error("halfway failure");
            })
        ).rejects.toThrow("halfway failure");

        // Verify each sublevel individually for clarity
        await expect(xStorage.freshness.get(nkA)).resolves.toBe("up-to-date");
        await expect(xStorage.freshness.get(nkB)).resolves.toBe("potentially-outdated");
    });

    test("three-node fan-in partially deleted: all three x-values preserved after PartialDeleteFanInError", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const [nkA, nkB, nkC] = [toJsonKey("A"), toJsonKey("B"), toJsonKey("C")];
        await buildFanInGraph(xStorage, nkA, nkB, nkC);
        const snapshotBefore = await captureStorageSnapshot(xStorage);

        const { yStorage } = makeYDb(makeSchemaStorage());
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "v1", currentVersion: "v2", xStorage, yStorage });

        await seedGraphScheme(xStorage, makeFanInNodeDefs());
        await expect(
            runMigration(capabilities, rootDatabase, makeFanInNodeDefs(), async (storage) => {
                await storage.delete(nkA);
                await storage.keep(nkB);
                // C is undecided — will trigger fan-in or undecided error
            })
        ).rejects.toThrow();

        expect(await captureStorageSnapshot(xStorage)).toEqual(snapshotBefore);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Migration validation: assertValidFinalMergeState is called before activation
// ─────────────────────────────────────────────────────────────────────────────

describe("migration validation", () => {
    test("assertValidFinalMergeState rejects target with missing valid flag for up-to-date node", async () => {
        // A -> B
        // B is up-to-date with inputs [A]
        // valid[A] is missing B
        // This violates the invariant: every up-to-date node must have
        // valid flags for every input.
        const storage = makeSchemaStorage();
        await storage.global.put('graph_scheme', JSON.stringify({
            format: 1,
            nodes: [
                { head: "A", arity: 0, inputTemplates: [] },
                { head: "B", arity: 0, inputTemplates: [{ head: "A", args: [] }] },
            ],
        }));
        const aKey = toJsonKey("A");
        const bKey = toJsonKey("B");

        await storage.values.put(aKey, { type: "all_events", events: [] });
        await storage.values.put(bKey, { type: "all_events", events: [] });
        await storage.values.put(aKey, { type: "all_events", events: [] });
        await storage.values.put(bKey, { type: "all_events", events: [] });
        await storage.freshness.put(aKey, "up-to-date");
        await storage.freshness.put(bKey, "up-to-date");
        // valid[A] intentionally missing B

        const identifiers = await storage.global.get(IDENTIFIERS_KEY);
        const lookup = makeIdentifierLookup(identifiers);

        await expect(
            assertValidFinalMergeState(storage, lookup)
        ).rejects.toThrow(FinalMergeStateError);
    });

    test("assertValidFinalMergeState rejects valid entry referencing unknown identifier", async () => {
        const storage = makeSchemaStorage();
        await storage.global.put('graph_scheme', JSON.stringify({
            format: 1,
            nodes: [
                { head: "A", arity: 0, inputTemplates: [] },
                { head: "B", arity: 0, inputTemplates: [{ head: "A", args: [] }] },
            ],
        }));
        const aKey = toJsonKey("A");
        const bKey = toJsonKey("B");

        await storage.values.put(aKey, { type: "all_events", events: [] });
        await storage.freshness.put(aKey, "up-to-date");
        // valid references B which is not materialized
        await storage.valid.put(aKey, [bKey]);

        const identifiers = await storage.global.get(IDENTIFIERS_KEY);
        const lookup = makeIdentifierLookup(identifiers);

        await expect(
            assertValidFinalMergeState(storage, lookup)
        ).rejects.toThrow(FinalMergeStateError);
    });

    test("valid target passes assertValidFinalMergeState", async () => {
        const storage = makeSchemaStorage();
        await storage.global.put('graph_scheme', JSON.stringify({
            format: 1,
            nodes: [
                { head: "A", arity: 0, inputTemplates: [] },
                { head: "B", arity: 0, inputTemplates: [{ head: "A", args: [] }] },
            ],
        }));
        const aKey = toJsonKey("A");
        const bKey = toJsonKey("B");

        await storage.values.put(aKey, { type: "all_events", events: [] });
        await storage.values.put(bKey, { type: "all_events", events: [] });
        await storage.values.put(aKey, { type: "all_events", events: [] });
        await storage.values.put(bKey, { type: "all_events", events: [] });
        await storage.freshness.put(aKey, "up-to-date");
        await storage.freshness.put(bKey, "up-to-date");
        await storage.timestamps.put(aKey, { createdAt: "2024-01-01T00:00:00.000Z", modifiedAt: "2024-01-01T00:00:00.000Z" });
        await storage.timestamps.put(bKey, { createdAt: "2024-01-01T00:00:00.000Z", modifiedAt: "2024-01-01T00:00:00.000Z" });
        await storage.valid.put(aKey, [bKey]);

        const identifiers = await storage.global.get(IDENTIFIERS_KEY);
        const lookup = makeIdentifierLookup(identifiers);

        await expect(
            assertValidFinalMergeState(storage, lookup)
        ).resolves.toBeUndefined();
    });

    test("assertValidFinalMergeState rejects materialized node without timestamps", async () => {
        const storage = makeSchemaStorage();
        await storage.global.put('graph_scheme', JSON.stringify({
            format: 1,
            nodes: [
                { head: "A", arity: 0, inputTemplates: [] },
            ],
        }));
        const aKey = toJsonKey("A");

        await storage.values.put(aKey, { type: "all_events", events: [] });
        await storage.freshness.put(aKey, "up-to-date");
        // Remove auto-added timestamp to test missing timestamp rejection
        await storage.timestamps.del(aKey);

        const identifiers = await storage.global.get(IDENTIFIERS_KEY);
        const lookup = makeIdentifierLookup(identifiers);

        await expect(
            assertValidFinalMergeState(storage, lookup)
        ).rejects.toThrow(FinalMergeStateError);
    });

    test("migration validates target and calls setCurrentReplicaPointer when validation passes", async () => {
        // A -> B, both up-to-date with correct valid flags
        // The migration keeps both nodes. buildDesiredValid() adds valid[A].has(B).
        // assertValidFinalMergeState will pass, and setCurrentReplicaPointer is called.
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const aKey = toJsonKey("A");
        const bKey = toJsonKey("B");

        await xStorage.values.put(aKey, { type: "all_events", events: [] });
        await xStorage.values.put(bKey, { type: "all_events", events: [] });
        await xStorage.values.put(aKey, { type: "all_events", events: [] });
        await xStorage.values.put(bKey, { type: "all_events", events: [] });
        await xStorage.freshness.put(aKey, "up-to-date");
        await xStorage.freshness.put(bKey, "up-to-date");
        // valid[A] already contains B — preserved through migration
        await xStorage.valid.put(aKey, [bKey]);

        const yStorage = makeSchemaStorage();
        const mock = makeRootDatabaseMock({
            prevVersion: "1.0.0",
            currentVersion: "2.0.0",
            xStorage,
            yStorage,
        });

        const nodeDefs = [
            { output: "A", inputs: [], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false },
            { output: "B", inputs: ["A"], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false },
        ];

        await seedGraphScheme(xStorage, nodeDefs);
        await runMigration(capabilities, mock.rootDatabase, nodeDefs, async (storage) => {
            await storage.keep(aKey);
            await storage.keep(bKey);
        });

        expect(mock.setCurrentReplicaPointerCalled).toBe(true);
    });

    test("migration calls assertValidFinalMergeState before activating replica; rejection blocks activation", async () => {
        // By mocking assertValidFinalMergeState to throw, we prove the
        // migration path calls it before setCurrentReplicaPointer.
        assertValidFinalMergeState.mockRejectedValueOnce(
            new FinalMergeStateError("simulated: target state invalid")
        );

        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");
        await xStorage.values.put(nodeKey, { type: "all_events", events: [] });

        const yStorage = makeSchemaStorage();
        const mock = makeRootDatabaseMock({
            prevVersion: "1.0.0",
            currentVersion: "2.0.0",
            xStorage,
            yStorage,
        });

        const nodeDefs = [{
            output: "A",
            inputs: [],
            computor: async () => ({ type: "all_events", events: [] }),
            isDeterministic: true,
            hasSideEffects: false,
        }];

        let caughtError;
        try {
            await seedGraphScheme(xStorage, nodeDefs);
            await runMigration(capabilities, mock.rootDatabase, nodeDefs, async (storage) => {
                await storage.keep(nodeKey);
            });
        } catch (e) {
            caughtError = e;
        }

        expect(assertValidFinalMergeState).toHaveBeenCalled();
        expect(isFinalMergeStateError(caughtError)).toBe(true);
        expect(mock.setCurrentReplicaPointerCalled).toBe(false);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// x.setGlobalVersion must never be called from the migration path (only on fresh DB)
// ─────────────────────────────────────────────────────────────────────────────

describe("x.setGlobalVersion not called on migration failure", () => {
    test("callback throws: x.setGlobalVersion never called", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");
        await xStorage.values.put(nodeKey, { type: "all_events", events: [] });
        await seedSingleAGraphScheme(xStorage);

        const { yStorage } = makeYDb(makeSchemaStorage());
        const mock = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage, yStorage });

        await expect(
            runMigration(capabilities, mock.rootDatabase, [{ output: "A", inputs: [], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false }],
                async () => { throw new Error("oops"); })
        ).rejects.toThrow();

        expect(mock.setGlobalVersionCalledWith).toBeUndefined();
    });

    test("UndecidedNodesError: x.setGlobalVersion never called", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");
        await xStorage.values.put(nodeKey, { type: "all_events", events: [] });
        await seedSingleAGraphScheme(xStorage);

        const { yStorage } = makeYDb(makeSchemaStorage());
        const mock = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage, yStorage });

        let caughtUndecided3;
        try {
            await runMigration(capabilities, mock.rootDatabase, [{ output: "A", inputs: [], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false }],
                async (_storage) => { /* no decision */ });
        } catch (e) { caughtUndecided3 = e; }
        expect(isUndecidedNodes(caughtUndecided3)).toBe(true);

        expect(mock.setGlobalVersionCalledWith).toBeUndefined();
    });

    test("PartialDeleteFanInError: x.setGlobalVersion never called", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const [nkA, nkB, nkC] = [toJsonKey("A"), toJsonKey("B"), toJsonKey("C")];
        await buildFanInGraph(xStorage, nkA, nkB, nkC);

        const { yStorage } = makeYDb(makeSchemaStorage());
        const mock = makeRootDatabaseMock({ prevVersion: "v1", currentVersion: "v2", xStorage, yStorage });

        await seedGraphScheme(xStorage, makeFanInNodeDefs());
        await expect(
            runMigration(capabilities, mock.rootDatabase, makeFanInNodeDefs(), async (storage) => {
                await storage.delete(nkA);
                await storage.keep(nkB);
            })
        ).rejects.toThrow();

        expect(mock.setGlobalVersionCalledWith).toBeUndefined();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Error identity: the exact thrown object propagates out of runMigration
// ─────────────────────────────────────────────────────────────────────────────

describe("error identity: exact thrown object propagates", () => {
    test("exact Error instance from callback propagates (same reference)", async () => {
        const capabilities = await getTestCapabilities();
        const { rootDatabase, nodeDefs, nodeKey, xStorage } = makeSimpleMigrationSetup();
        await xStorage.values.put(nodeKey, { type: "all_events", events: [] });

        const specificError = new Error("unique error " + Math.random());
        let caught;
        try {
            await seedGraphScheme(xStorage, nodeDefs);
            await runMigration(capabilities, rootDatabase, nodeDefs, async () => {
                throw specificError;
            });
        } catch (e) {
            caught = e;
        }

        expect(caught).toBe(specificError);
    });

    test("exact Error from checkpointMigration setup propagates", async () => {
        const capabilities = await getTestCapabilities();
        const checkpointError = new Error("pre-checkpoint failure");
        capabilities.checkpointMigration.mockRejectedValueOnce(checkpointError);

        const { rootDatabase, nodeDefs, nodeKey, xStorage } = makeSimpleMigrationSetup();
        await xStorage.values.put(nodeKey, { type: "all_events", events: [] });

        let caught;
        try {
            await seedGraphScheme(xStorage, nodeDefs);
            await runMigration(capabilities, rootDatabase, nodeDefs, async (storage) => {
                await storage.keep(nodeKey);
            });
        } catch (e) {
            caught = e;
        }

        expect(caught).toBe(checkpointError);
    });

    test("UndecidedNodesError from finalize carries the undecided node keys", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const nkA = toJsonKey("A");
        const nkB = toJsonKey("B");
        await populateNode(xStorage, nkA);
        await seedSingleAGraphScheme(xStorage);
        await populateNode(xStorage, nkB);
        await seedSingleAGraphScheme(xStorage);

        const { yStorage } = makeYDb(makeSchemaStorage());
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "v1", currentVersion: "v2", xStorage, yStorage });

        let caught;
        try {
            await seedGraphScheme(xStorage, makeTwoNodeDefs());
            await runMigration(capabilities, rootDatabase, makeTwoNodeDefs(), async (storage) => {
                await storage.keep(nkA);
                // B left undecided
            });
        } catch (e) {
            caught = e;
        }

        expect(isUndecidedNodes(caught)).toBe(true);
        // Access undecidedNodes property directly — isUndecidedNodes(caught) returning true
        // guarantees the property is present; we read it via bracket notation to avoid a cast.
        expect(caught["undecidedNodes"]).toContain(nkB);
    });

    test("PartialDeleteFanInError from finalize carries the fan-in node key", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const [nkA, nkB, nkC] = [toJsonKey("A"), toJsonKey("B"), toJsonKey("C")];
        await buildFanInGraph(xStorage, nkA, nkB, nkC);

        const { yStorage } = makeYDb(makeSchemaStorage());
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "v1", currentVersion: "v2", xStorage, yStorage });

        let caught;
        try {
            await seedGraphScheme(xStorage, makeFanInNodeDefs());
            await runMigration(capabilities, rootDatabase, makeFanInNodeDefs(), async (storage) => {
                await storage.delete(nkA);
                await storage.keep(nkB);
            });
        } catch (e) {
            caught = e;
        }

        expect(isPartialDeleteFanIn(caught)).toBe(true);
    });

    test("DecisionConflictError from callback carries correct node key", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");
        await populateNode(xStorage, nodeKey);
        await seedSingleAGraphScheme(xStorage);

        const { yStorage } = makeYDb(makeSchemaStorage());
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage, yStorage });

        let caught;
        try {
            await runMigration(capabilities, rootDatabase, [{ output: "A", inputs: [], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false }],
                async (storage) => {
                    await storage.keep(nodeKey);
                    await storage.invalidate(nodeKey);
                });
        } catch (e) {
            caught = e;
        }

        expect(isDecisionConflict(caught)).toBe(true);
        // Access nodeKey property directly — isDecisionConflict(caught) returning true
        // guarantees the property is present; we read it via bracket notation to avoid a cast.
        expect(caught["nodeKey"]).toBe(nodeKey);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Infrastructure failures (getGlobalVersion, clearStorage, checkpointMigration)
// ─────────────────────────────────────────────────────────────────────────────

describe("infrastructure failures", () => {
    test("getGlobalVersion throws: error propagates before any migration work starts", async () => {
        const capabilities = await getTestCapabilities();
        const metaError = new Error("getGlobalVersion failure");
        const xStorage = makeSchemaStorage();
            const yStorage = makeSchemaStorage();
            const callOrder = [];
            const rootDatabase = {
                version: "2.0.0",
                getVersion() { return this.version; },
                async getGlobalVersion() { throw metaError; },
                getSchemaStorage() { return xStorage; },
                currentReplicaName() { return 'x'; },
                otherReplicaName() { return 'y'; },
                schemaStorageForReplica(name) { return name === 'x' ? xStorage : yStorage; },
                async clearReplicaStorage(_name) {},
                async setCurrentReplicaPointer(name) { callOrder.push(`setCurrentReplicaPointer:${name}`); },
                async setGlobalVersion(_v) {},
                async _rawSync() {},
                getFingerprint() { return 'testmigrfinprt'; },
                getLastNodeIndex() { return 0; },
                advanceLastNodeIndex(_value) {},
            };

        let caught;
        try {
            await runMigration(capabilities, rootDatabase, [], async () => {});
        } catch (e) {
            caught = e;
        }

        expect(caught).toBe(metaError);
        expect(capabilities.checkpointMigration).not.toHaveBeenCalled();
    });

    test("unification noFlushPut throws: error propagates, callback was run, setCurrentReplicaPointer not called", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");
        await xStorage.values.put(nodeKey, { type: "all_events", events: [] });

        const unificationError = new Error("unification write failure");
        const yStorage = makeSchemaStorage();
        for (const name of ['values', 'freshness', 'global', 'valid', 'timestamps']) {
            yStorage[name].noFlushPut = async () => { throw unificationError; };
            yStorage[name].noFlushDel = async () => { throw unificationError; };
        }
        const rootDatabase = {
            version: "2",
            async getGlobalVersion() { return "1"; },
            getSchemaStorage() { return xStorage; },
            currentReplicaName() { return 'x'; },
            otherReplicaName() { return 'y'; },
            schemaStorageForReplica(name) { return name === 'x' ? xStorage : yStorage; },
            async setCurrentReplicaPointer() {},
            async setGlobalVersion() {},
            async _rawSync() {},
            getFingerprint() { return 'testmigrfinprt'; },
            getVersion() { return this.version; },
            getLastNodeIndex() { return this._computed.lastNodeIndex; },
            advanceLastNodeIndex(value) { this._computed.lastNodeIndex = Math.max(this._computed.lastNodeIndex, value); },
            _computed: { lastNodeIndex: 0 },
        };

        let callbackRan = false;
        await seedSingleAGraphScheme(xStorage);
        await expect(
            runMigration(capabilities, rootDatabase, [{ output: "A", inputs: [], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false }],
                async (storage) => { callbackRan = true; await storage.keep(nodeKey); })
        ).rejects.toMatchObject({ cause: unificationError });

        // Callback ran successfully; unification threw on commit.
        expect(callbackRan).toBe(true);
    });

    test("checkpointMigration setup throws: migration does not run, setCurrentReplicaPointer not called", async () => {
        const capabilities = await getTestCapabilities();
        const checkpointError = new Error("checkpoint failure");
        capabilities.checkpointMigration.mockRejectedValueOnce(checkpointError);

        const { nodeDefs, nodeKey, xStorage } = makeSimpleMigrationSetup();
        await xStorage.values.put(nodeKey, { type: "all_events", events: [] });

        // We need a fresh mock so we can check setCurrentReplicaPointerCalled
        const freshXStorage = makeSchemaStorage();
        await freshXStorage.values.put(nodeKey, { type: "all_events", events: [] });
        const { yStorage } = makeYDb(makeSchemaStorage());
        const freshMock = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage: freshXStorage, yStorage });

        let callbackRan = false;
        await seedGraphScheme(xStorage, nodeDefs);
        await expect(
            runMigration(capabilities, freshMock.rootDatabase, nodeDefs, async (storage) => {
                callbackRan = true;
                await storage.keep(nodeKey);
            })
        ).rejects.toBe(checkpointError);

        expect(callbackRan).toBe(false);
        expect(freshMock.setCurrentReplicaPointerCalled).toBe(false);
    });

    test("checkpointMigration setup throws: x-namespace data unchanged", async () => {
        const capabilities = await getTestCapabilities();
        const checkpointError = new Error("pre-checkpoint failure");
        capabilities.checkpointMigration.mockRejectedValueOnce(checkpointError);

        const xStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");
        await populateNode(xStorage, nodeKey);
        await seedSingleAGraphScheme(xStorage);
        const snapshotBefore = await captureStorageSnapshot(xStorage);

        const { yStorage } = makeYDb(makeSchemaStorage());
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage, yStorage });

        await expect(
            runMigration(capabilities, rootDatabase, [{ output: "A", inputs: [], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false }],
                async (storage) => { await storage.keep(nodeKey); })
        ).rejects.toBe(checkpointError);

        expect(await captureStorageSnapshot(xStorage)).toEqual(snapshotBefore);
    });

    test("post-migration commit failure from checkpointMigration leaves the migration already applied", async () => {
        const capabilities = await getTestCapabilities();
        const postError = new Error("post-checkpoint failure");

        capabilities.checkpointMigration
            .mockImplementationOnce(async (_caps, _db, _preMessage, _postMessage, callback) => {
                await callback();
                throw postError;
            });

        const { nodeDefs, nodeKey, xStorage } = makeSimpleMigrationSetup();
        await xStorage.values.put(nodeKey, { type: "all_events", events: [] });

        // Rebuild with a mock that tracks the replica switch cutover via setCurrentReplicaPointerCalled
        const freshXStorage = makeSchemaStorage();
        await freshXStorage.values.put(nodeKey, { type: "all_events", events: [] });
        const { yStorage } = makeYDb(makeSchemaStorage());
        const freshMock = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage: freshXStorage, yStorage });

        let caught;
        try {
            await seedGraphScheme(freshXStorage, nodeDefs);
            await runMigration(capabilities, freshMock.rootDatabase, nodeDefs, async (storage) => {
                await storage.keep(nodeKey);
            });
        } catch (e) {
            caught = e;
        }

        // The error came from the post-checkpoint, but the migration DID complete
        expect(caught).toBe(postError);
        expect(freshMock.setCurrentReplicaPointerCalled).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Retry: after a failure, the next call with a correct callback succeeds
// ─────────────────────────────────────────────────────────────────────────────

describe("retry after failure", () => {
    test("failed migration followed by correct migration: second call applies migration and calls setCurrentReplicaPointer", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");
        await xStorage.values.put(nodeKey, { type: "all_events", events: [] });
        await seedSingleAGraphScheme(xStorage);

        const { yStorage } = makeYDb(makeSchemaStorage());
        const mock = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage, yStorage });

        // First attempt fails
        await expect(
            runMigration(capabilities, mock.rootDatabase, [{ output: "A", inputs: [], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false }],
                async () => { throw new Error("first attempt failure"); })
        ).rejects.toThrow("first attempt failure");

        expect(mock.setCurrentReplicaPointerCalled).toBe(false);

        // Second attempt succeeds
        await runMigration(capabilities, mock.rootDatabase, [{ output: "A", inputs: [], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false }],
            async (storage) => { await storage.keep(nodeKey); });

        expect(mock.setCurrentReplicaPointerCalled).toBe(true);
    });

    test("failed migration followed by correct migration: two pre/post checkpoint pairs are recorded", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");
        await xStorage.values.put(nodeKey, { type: "all_events", events: [] });

        const { yStorage } = makeYDb(makeSchemaStorage());
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage, yStorage });

        const nodeDef = { output: "A", inputs: [], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false };

        await seedGraphScheme(xStorage, [nodeDef]);

        // First attempt: one checkpointMigration call, but it fails after the pre commit
        await expect(
            runMigration(capabilities, rootDatabase, [nodeDef], async () => { throw new Error("fail"); })
        ).rejects.toThrow();

        expect(capabilities.checkpointMigration).toHaveBeenCalledTimes(1);
        capabilities.checkpointMigration.mockClear();

        // Second (successful) attempt: one fresh checkpointMigration call
        await runMigration(capabilities, rootDatabase, [nodeDef], async (storage) => {
            await storage.keep(nodeKey);
        });

        expect(capabilities.checkpointMigration).toHaveBeenCalledTimes(1);
    });

    test("UndecidedNodes failure then correct callback: x-values reflect successful migration in y", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const nkA = toJsonKey("A");
        const nkB = toJsonKey("B");
        await buildTwoNodeGraph(xStorage, nkA, nkB);

        const { yStorage } = makeYDb(makeSchemaStorage());
        const mock = makeRootDatabaseMock({ prevVersion: "v1", currentVersion: "v2", xStorage, yStorage });

        // First attempt: only decide A, B undecided → fail
        let caughtRetry;
        try {
            await seedGraphScheme(xStorage, makeTwoNodeDefs());
            await runMigration(capabilities, mock.rootDatabase, makeTwoNodeDefs(), async (storage) => {
                await storage.keep(nkA);
                // B left undecided
            });
        } catch (e) { caughtRetry = e; }
        expect(isUndecidedNodes(caughtRetry)).toBe(true);

        expect(mock.setCurrentReplicaPointerCalled).toBe(false);

        // Second attempt: correct, decides both nodes
        await seedGraphScheme(xStorage, makeTwoNodeDefs());
        await runMigration(capabilities, mock.rootDatabase, makeTwoNodeDefs(), async (storage) => {
            await storage.keep(nkA);
            await storage.keep(nkB);
        });

        expect(mock.setCurrentReplicaPointerCalled).toBe(true);
    });
});
