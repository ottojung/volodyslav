const { runMigration } = require("../src/generators/incremental_graph/migration_runner");
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

/**
 * Build a standard in-memory rootDatabase mock.
 * @param {object} opts
 * @param {string|undefined} opts.prevVersion - what getMetaVersion returns
 * @param {string} opts.currentVersion - version field on rootDatabase
 * @param {object} opts.xStorage - the x-namespace SchemaStorage
 * @param {object} opts.yStorage - the y-namespace SchemaStorage
 * @returns {{ rootDatabase: any, switchToReplicaCalled: boolean }}
 */
function makeRootDatabaseMock({ prevVersion, currentVersion, xStorage, yStorage }) {
    let switchToReplicaCalled = false;
    let switchToReplicaCalledWith = undefined;
    let clearReplicaStorageCalledWith = undefined;
    let setMetaVersionForReplicaCalledWith = undefined;
    let setMetaVersionCalledWith = undefined;

    const rootDatabase = {
        version: currentVersion,
        async getMetaVersion() { return prevVersion; },
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
        async setMetaVersionForReplica(name, v) {
            setMetaVersionForReplicaCalledWith = { name, v };
        },
        async switchToReplica(name) {
            switchToReplicaCalled = true;
            switchToReplicaCalledWith = name;
        },
        async setMetaVersion(v) {
            setMetaVersionCalledWith = v;
        },
        async _rawSync() {},
    };

    return {
        rootDatabase,
        get switchToReplicaCalled() { return switchToReplicaCalled; },
        get switchToReplicaCalledWith() { return switchToReplicaCalledWith; },
        get clearReplicaStorageCalledWith() { return clearReplicaStorageCalledWith; },
        get setMetaVersionForReplicaCalledWith() { return setMetaVersionForReplicaCalledWith; },
        get setMetaVersionCalledWith() { return setMetaVersionCalledWith; },
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
 * Builds a minimal but representative migration scenario.
 * The xStorage has one node ("A") that the migration callback can act upon.
 */
function makeSimpleMigrationSetup({ prevVersion = "1.0.0", currentVersion = "2.0.0" } = {}) {
    const xStorage = makeSchemaStorage();
    const yStorage = makeSchemaStorage();
    const nodeKey = toJsonKey("A");
    const { rootDatabase } = makeRootDatabaseMock({
        prevVersion,
        currentVersion,
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
    return { rootDatabase, nodeDefs, nodeKey, xStorage, yStorage };
}

describe("runMigration", () => {
    test("invalidate preserves counters from previous storage", async () => {
        const capabilities = await getTestCapabilities();
        const previousStorage = makeSchemaStorage();
        const currentStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");

        await previousStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });
        await previousStorage.values.put(nodeKey, { type: "all_events", events: [] });
        await previousStorage.freshness.put(nodeKey, "up-to-date");
        await previousStorage.counters.put(nodeKey, 5);

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

        await runMigration(capabilities, rootDatabase, nodeDefs, async (storage) => {
            await storage.invalidate(nodeKey);
        });

        await expect(currentStorage.counters.get(nodeKey)).resolves.toBe(5);
        await expect(currentStorage.freshness.get(nodeKey)).resolves.toBe("potentially-outdated");
    });

    describe("fresh database (getMetaVersion returns undefined)", () => {
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

            expect(mock.switchToReplicaCalled).toBe(false);
        });

        test("records current version via setMetaVersion so future upgrades are detected", async () => {
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

            expect(mock.setMetaVersionCalledWith).toBe("1.0.0");
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

            expect(mock.switchToReplicaCalled).toBe(false);
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
            await xStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });

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

            await runMigration(capabilities, mock.rootDatabase, nodeDefs, async (storage) => {
                await storage.invalidate(nodeKey);
            });

            // y namespace is populated with the migrated node's inputs record.
            const migratedInputs = await yStorage.inputs.get(nodeKey);
            expect(migratedInputs).toBeDefined();
        });

        test("writes version to y before calling switchToReplica", async () => {
            const capabilities = await getTestCapabilities();
            const xStorage = makeSchemaStorage();
            const nodeKey = toJsonKey("A");
            await xStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });

            const callOrder = [];
            let switchToReplicaCalled = false;
            const yStorage = makeSchemaStorage();
            const rootDatabase = {
                version: "2.0.0",
                async getMetaVersion() { return "1.0.0"; },
                getSchemaStorage() { return xStorage; },
                currentReplicaName() { return 'x'; },
                otherReplicaName() { return 'y'; },
                schemaStorageForReplica(name) { return name === 'x' ? xStorage : yStorage; },
                async clearReplicaStorage(_name) {},
                async setMetaVersionForReplica(name, v) {
                    callOrder.push({ action: "setMetaVersionForReplica", name, arg: v });
                },
                async switchToReplica(name) {
                    callOrder.push({ action: "switchToReplica", name });
                    switchToReplicaCalled = true;
                },
                async setMetaVersion(_v) {},
                async _rawSync() {},
            };

            const nodeDefs = [{
                output: "A",
                inputs: [],
                computor: async () => ({ type: "all_events", events: [] }),
                isDeterministic: true,
                hasSideEffects: false,
            }];

            await runMigration(capabilities, rootDatabase, nodeDefs, async (storage) => {
                await storage.invalidate(nodeKey);
            });

            expect(switchToReplicaCalled).toBe(true);
            expect(callOrder[0]).toEqual({ action: "setMetaVersionForReplica", name: "y", arg: "2.0.0" });
            expect(callOrder[1]).toEqual({ action: "switchToReplica", name: "y" });
        });

        test("all-keep migration: setMetaVersion on active replica, no switchToReplica", async () => {
            const capabilities = await getTestCapabilities();
            const xStorage = makeSchemaStorage();
            const nodeKey = toJsonKey("A");
            await xStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });

            const callOrder = [];
            const yStorage = makeSchemaStorage();
            const rootDatabase = {
                version: "2.0.0",
                async getMetaVersion() { return "1.0.0"; },
                getSchemaStorage() { return xStorage; },
                currentReplicaName() { return 'x'; },
                otherReplicaName() { return 'y'; },
                schemaStorageForReplica(name) { return name === 'x' ? xStorage : yStorage; },
                async clearReplicaStorage(_name) {},
                async setMetaVersionForReplica(name, v) {
                    callOrder.push({ action: "setMetaVersionForReplica", name, arg: v });
                },
                async switchToReplica(name) {
                    callOrder.push({ action: "switchToReplica", name });
                },
                async setMetaVersion(v) {
                    callOrder.push({ action: "setMetaVersion", arg: v });
                },
                async _rawSync() {},
            };

            const nodeDefs = [{
                output: "A",
                inputs: [],
                computor: async () => ({ type: "all_events", events: [] }),
                isDeterministic: true,
                hasSideEffects: false,
            }];

            await runMigration(capabilities, rootDatabase, nodeDefs, async (storage) => {
                await storage.keep(nodeKey);
            });

            // All-keep: version is bumped on the active replica directly; no switch.
            expect(callOrder).toContainEqual({ action: "setMetaVersion", arg: "2.0.0" });
            expect(callOrder.every(e => e.action !== "switchToReplica")).toBe(true);
            expect(callOrder.every(e => e.action !== "setMetaVersionForReplica")).toBe(true);
        });

        test("calls switchToReplica with 'y' on successful migration", async () => {
            const capabilities = await getTestCapabilities();
            const previousStorage = makeSchemaStorage();
            const nodeKey = toJsonKey("A");
            await previousStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });
            await previousStorage.values.put(nodeKey, { type: "all_events", events: [] });
            await previousStorage.freshness.put(nodeKey, "up-to-date");
            await previousStorage.counters.put(nodeKey, 2);

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

            await runMigration(capabilities, mock.rootDatabase, nodeDefs, async (storage) => {
                await storage.invalidate(nodeKey);
            });

            expect(mock.switchToReplicaCalled).toBe(true);
        });

        test("calls checkpointMigration once for the whole migration", async () => {
            const capabilities = await getTestCapabilities();
            const { rootDatabase, nodeDefs, nodeKey, xStorage } = makeSimpleMigrationSetup();
            await xStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });

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
            await xStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });

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
            await xStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });

            await runMigration(capabilities, rootDatabase, nodeDefs, async (storage) => {
                await storage.keep(nodeKey);
            });

            const postMessage = capabilities.checkpointMigration.mock.calls[0][3];
            expect(postMessage).toContain("post-migration:");
            expect(postMessage).toContain("2.0.0");
        });

        test("pre-migration commit happens before switchToReplica inside the checkpointMigration", async () => {
            const capabilities = await getTestCapabilities();
            const callOrder = [];
            capabilities.checkpointMigration.mockImplementation(async (_caps, _db, preMessage, postMessage, callback) => {
                callOrder.push(`checkpoint:${preMessage}`);
                await callback();
                callOrder.push(`checkpoint:${postMessage}`);
            });

            const xStorage = makeSchemaStorage();
            const nodeKey = toJsonKey("A");
            await xStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });

            const yStorage = makeSchemaStorage();
            const rootDatabase = {
                version: "2.0.0",
                async getMetaVersion() { return "1.0.0"; },
                getSchemaStorage() { return xStorage; },
                currentReplicaName() { return 'x'; },
                otherReplicaName() { return 'y'; },
                schemaStorageForReplica(name) { return name === 'x' ? xStorage : yStorage; },
                async clearReplicaStorage(_name) {},
                async setMetaVersionForReplica(_name, _v) {},
                async switchToReplica(name) { callOrder.push(`switchToReplica:${name}`); },
                async setMetaVersion(_v) {},
                async _rawSync() {},
            };
            const nodeDefs = [{
                output: "A",
                inputs: [],
                computor: async () => ({ type: "all_events", events: [] }),
                isDeterministic: true,
                hasSideEffects: false,
            }];

            await runMigration(capabilities, rootDatabase, nodeDefs, async (storage) => {
                await storage.invalidate(nodeKey);
            });

            const preIdx = callOrder.findIndex((e) => typeof e === "string" && e.startsWith("checkpoint:pre-migration"));
            const switchIdx = callOrder.findIndex((e) => typeof e === "string" && e.startsWith("switchToReplica:"));
            expect(preIdx).toBeGreaterThanOrEqual(0);
            expect(switchIdx).toBeGreaterThan(preIdx);
        });

        test("post-migration commit happens after switchToReplica inside the checkpointMigration", async () => {
            const capabilities = await getTestCapabilities();
            const callOrder = [];
            capabilities.checkpointMigration.mockImplementation(async (_caps, _db, preMessage, postMessage, callback) => {
                callOrder.push(`checkpoint:${preMessage}`);
                await callback();
                callOrder.push(`checkpoint:${postMessage}`);
            });

            const xStorage = makeSchemaStorage();
            const nodeKey = toJsonKey("A");
            await xStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });

            const yStorage = makeSchemaStorage();
            const rootDatabase = {
                version: "2.0.0",
                async getMetaVersion() { return "1.0.0"; },
                getSchemaStorage() { return xStorage; },
                currentReplicaName() { return 'x'; },
                otherReplicaName() { return 'y'; },
                schemaStorageForReplica(name) { return name === 'x' ? xStorage : yStorage; },
                async clearReplicaStorage(_name) {},
                async setMetaVersionForReplica(_name, _v) {},
                async switchToReplica(name) { callOrder.push(`switchToReplica:${name}`); },
                async setMetaVersion(_v) {},
                async _rawSync() {},
            };
            const nodeDefs = [{
                output: "A",
                inputs: [],
                computor: async () => ({ type: "all_events", events: [] }),
                isDeterministic: true,
                hasSideEffects: false,
            }];

            await runMigration(capabilities, rootDatabase, nodeDefs, async (storage) => {
                await storage.keep(nodeKey);
            });

            const postIdx = callOrder.findIndex((e) => typeof e === "string" && e.startsWith("checkpoint:post-migration"));
            const switchIdx = callOrder.findIndex((e) => typeof e === "string" && e.startsWith("switchToReplica:"));
            expect(postIdx).toBeGreaterThan(switchIdx);
        });
    });

    describe("failure cases", () => {
        test("callback throws: switchToReplica is NOT called and error propagates", async () => {
            const capabilities = await getTestCapabilities();
            const xStorage = makeSchemaStorage();
            const nodeKey = toJsonKey("A");
            await xStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });

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
            await expect(
                runMigration(capabilities, mock.rootDatabase, nodeDefs, async (_storage) => {
                    throw callbackError;
                })
            ).rejects.toBe(callbackError);

            expect(mock.switchToReplicaCalled).toBe(false);
        });

        test("finalize throws UndecidedNodesError when a node has no decision: switchToReplica is NOT called", async () => {
            const capabilities = await getTestCapabilities();
            const xStorage = makeSchemaStorage();
            const nodeKey = toJsonKey("A");
            await xStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });

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
                await runMigration(capabilities, mock.rootDatabase, nodeDefs, async (_storage) => {
                    // intentionally leave A undecided
                });
            } catch (err) {
                caughtError = err;
            }

            expect(isUndecidedNodes(caughtError)).toBe(true);
            expect(mock.switchToReplicaCalled).toBe(false);
        });

        test("callback throws: unification is not attempted and error propagates", async () => {
            const capabilities = await getTestCapabilities();
            const xStorage = makeSchemaStorage();
            const nodeKey = toJsonKey("A");
            await xStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });

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

            await expect(
                runMigration(capabilities, mock.rootDatabase, nodeDefs, async () => {
                    throw new Error("intentional failure");
                })
            ).rejects.toThrow("intentional failure");

            // unification was never attempted so y namespace is still empty
            expect(mock.switchToReplicaCalled).toBe(false);
        });

        test("callback throws: checkpointMigration attempts the pre-migration commit step before failing", async () => {
            const capabilities = await getTestCapabilities();
            const { rootDatabase, nodeDefs, nodeKey, xStorage } = makeSimpleMigrationSetup();
            await xStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });
            const callOrder = [];
            capabilities.checkpointMigration.mockImplementation(async (_caps, _db, preMessage, postMessage, callback) => {
                callOrder.push(`checkpoint:${preMessage}`);
                await callback();
                callOrder.push(`checkpoint:${postMessage}`);
            });

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
            await xStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });
            const callOrder = [];
            capabilities.checkpointMigration.mockImplementation(async (_caps, _db, preMessage, postMessage, callback) => {
                callOrder.push(`checkpoint:${preMessage}`);
                await callback();
                callOrder.push(`checkpoint:${postMessage}`);
            });

            // Callback runs but assigns no decision → finalize throws UndecidedNodesError
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
    for await (const key of storage.inputs.keys()) {
        snapshot[`inputs:${key}`] = await storage.inputs.get(key);
    }
    for await (const key of storage.counters.keys()) {
        snapshot[`counters:${key}`] = await storage.counters.get(key);
    }
    for await (const key of storage.revdeps.keys()) {
        snapshot[`revdeps:${key}`] = await storage.revdeps.get(key);
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
    inputs = [],
    inputCounters = [],
    counter = 1,
    timestamps = undefined,
} = {}) {
    await storage.values.put(nodeKey, value);
    await storage.freshness.put(nodeKey, freshness);
    await storage.inputs.put(nodeKey, { inputs, inputCounters });
    await storage.counters.put(nodeKey, counter);
    if (timestamps !== undefined) {
        await storage.timestamps.put(nodeKey, timestamps);
    }
}

/** Build a two-node graph where B depends on A (A → B). */
async function buildTwoNodeGraph(storage, nodeKeyA, nodeKeyB, {
    timestampA = undefined,
    timestampB = undefined,
} = {}) {
    await populateNode(storage, nodeKeyA, { counter: 3, timestamps: timestampA });
    await populateNode(storage, nodeKeyB, {
        inputs: [nodeKeyA],
        inputCounters: [3],
        counter: 7,
        freshness: "potentially-outdated",
        timestamps: timestampB,
    });
    await storage.revdeps.put(nodeKeyA, [nodeKeyB]);
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
    await populateNode(storage, nkA, { counter: 1 });
    await populateNode(storage, nkB, { counter: 2 });
    await populateNode(storage, nkC, {
        inputs: [nkA, nkB],
        inputCounters: [1, 2],
        counter: 1,
    });
    await storage.revdeps.put(nkA, [nkC]);
    await storage.revdeps.put(nkB, [nkC]);
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
        await populateNode(xStorage, nodeKey, { counter: 42, freshness: "up-to-date" });

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
        await populateNode(xStorage, nodeKey, { counter: 11 });

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
        await populateNode(xStorage, nkA, { counter: 5 });
        await populateNode(xStorage, nkB, { counter: 9, freshness: "potentially-outdated" });

        const { yStorage } = makeYDb(makeSchemaStorage());
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "v1", currentVersion: "v2", xStorage, yStorage });
        const snapshotBefore = await captureStorageSnapshot(xStorage);

        // Callback only decides A, leaves B undecided → UndecidedNodesError
        let caughtUndecided;
        try {
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
        await populateNode(xStorage, nodeKey, { counter: 3 });

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

    test("rawPut() throws during unification into y: x-namespace data unchanged, switchToReplica not called", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");
        await populateNode(xStorage, nodeKey, { counter: 99 });
        const snapshotBefore = await captureStorageSnapshot(xStorage);

        // Build a yStorage whose rawPut throws on all sublevels
        const yStorage = makeSchemaStorage();
        const writeError = new Error("write failure");
        for (const name of ['values', 'freshness', 'inputs', 'revdeps', 'counters', 'timestamps']) {
            yStorage[name].rawPut = async () => { throw writeError; };
            yStorage[name].rawDel = async () => { throw writeError; };
        }

        const mock = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage, yStorage });

        await expect(
            runMigration(capabilities, mock.rootDatabase, [{ output: "A", inputs: [], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false }],
                async (storage) => { await storage.invalidate(nodeKey); })
        ).rejects.toMatchObject({ cause: writeError });

        expect(mock.switchToReplicaCalled).toBe(false);
        expect(await captureStorageSnapshot(xStorage)).toEqual(snapshotBefore);
    });

    test("setMetaVersionForReplica throws: x-namespace data unchanged, switchToReplica not called", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");
        await populateNode(xStorage, nodeKey, { counter: 7 });
        const snapshotBefore = await captureStorageSnapshot(xStorage);

        const metaError = new Error("setMetaVersionForReplica failure");
        const yStorage = makeSchemaStorage();
        const rootDatabase = {
            version: "2",
            async getMetaVersion() { return "1"; },
            getSchemaStorage() { return xStorage; },
            currentReplicaName() { return 'x'; },
            otherReplicaName() { return 'y'; },
            schemaStorageForReplica(name) { return name === 'x' ? xStorage : yStorage; },
            async clearReplicaStorage(_name) {},
            async setMetaVersionForReplica() { throw metaError; },
            async switchToReplica() {},
            async setMetaVersion(_v) {},
            async _rawSync() {},
        };

        await expect(
            runMigration(capabilities, rootDatabase, [{ output: "A", inputs: [], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false }],
                async (storage) => { await storage.invalidate(nodeKey); })
        ).rejects.toBe(metaError);

        expect(await captureStorageSnapshot(xStorage)).toEqual(snapshotBefore);
    });

    test("switchToReplica throws: error propagates and x had not been modified before the throw", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");
        await populateNode(xStorage, nodeKey, { counter: 2 });
        const snapshotBefore = await captureStorageSnapshot(xStorage);

        const swapError = new Error("swap failed");
        const yStorage = makeSchemaStorage();
        // Override switchToReplica to throw without touching xStorage
        const rootDatabase = {
            version: "2",
            async getMetaVersion() { return "1"; },
            getSchemaStorage() { return xStorage; },
            currentReplicaName() { return 'x'; },
            otherReplicaName() { return 'y'; },
            schemaStorageForReplica(name) { return name === 'x' ? xStorage : yStorage; },
            async clearReplicaStorage(_name) {},
            async setMetaVersionForReplica(_name, _v) {},
            async switchToReplica() { throw swapError; },
            async setMetaVersion() {},
            async _rawSync() {},
        };

        await expect(
            runMigration(capabilities, rootDatabase, [{ output: "A", inputs: [], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false }],
                async (storage) => { await storage.invalidate(nodeKey); })
        ).rejects.toBe(swapError);

        // x was never modified by migration code — only switchToReplica would do that
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
            await runMigration(capabilities, rootDatabase, makeTwoNodeDefs(), async (storage) => {
                await storage.keep(nkA);
            });
        } catch (e) { caughtUndecided2 = e; }
        expect(isUndecidedNodes(caughtUndecided2)).toBe(true);

        expect(await captureStorageSnapshot(xStorage)).toEqual(snapshotBefore);
    });

    test("multi-node graph: counter, freshness, inputs all preserved after callback error", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const nkA = toJsonKey("A");
        const nkB = toJsonKey("B");
        await buildTwoNodeGraph(xStorage, nkA, nkB);

        const { yStorage } = makeYDb(makeSchemaStorage());
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "v1", currentVersion: "v2", xStorage, yStorage });

        await expect(
            runMigration(capabilities, rootDatabase, makeTwoNodeDefs(), async (storage) => {
                await storage.keep(nkA);
                throw new Error("halfway failure");
            })
        ).rejects.toThrow("halfway failure");

        // Verify each sublevel individually for clarity
        await expect(xStorage.counters.get(nkA)).resolves.toBe(3);
        await expect(xStorage.counters.get(nkB)).resolves.toBe(7);
        await expect(xStorage.freshness.get(nkA)).resolves.toBe("up-to-date");
        await expect(xStorage.freshness.get(nkB)).resolves.toBe("potentially-outdated");
        await expect(xStorage.inputs.get(nkB)).resolves.toEqual({ inputs: [nkA], inputCounters: [3] });
    });

    test("three-node fan-in partially deleted: all three x-values preserved after PartialDeleteFanInError", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const [nkA, nkB, nkC] = [toJsonKey("A"), toJsonKey("B"), toJsonKey("C")];
        await buildFanInGraph(xStorage, nkA, nkB, nkC);
        const snapshotBefore = await captureStorageSnapshot(xStorage);

        const { yStorage } = makeYDb(makeSchemaStorage());
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "v1", currentVersion: "v2", xStorage, yStorage });

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
// x.setMetaVersion must never be called from the migration path (only on fresh DB)
// ─────────────────────────────────────────────────────────────────────────────

describe("x.setMetaVersion not called on migration failure", () => {
    test("callback throws: x.setMetaVersion never called", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");
        await xStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });

        const { yStorage } = makeYDb(makeSchemaStorage());
        const mock = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage, yStorage });

        await expect(
            runMigration(capabilities, mock.rootDatabase, [{ output: "A", inputs: [], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false }],
                async () => { throw new Error("oops"); })
        ).rejects.toThrow();

        expect(mock.setMetaVersionCalledWith).toBeUndefined();
    });

    test("UndecidedNodesError: x.setMetaVersion never called", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");
        await xStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });

        const { yStorage } = makeYDb(makeSchemaStorage());
        const mock = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage, yStorage });

        let caughtUndecided3;
        try {
            await runMigration(capabilities, mock.rootDatabase, [{ output: "A", inputs: [], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false }],
                async (_storage) => { /* no decision */ });
        } catch (e) { caughtUndecided3 = e; }
        expect(isUndecidedNodes(caughtUndecided3)).toBe(true);

        expect(mock.setMetaVersionCalledWith).toBeUndefined();
    });

    test("PartialDeleteFanInError: x.setMetaVersion never called", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const [nkA, nkB, nkC] = [toJsonKey("A"), toJsonKey("B"), toJsonKey("C")];
        await buildFanInGraph(xStorage, nkA, nkB, nkC);

        const { yStorage } = makeYDb(makeSchemaStorage());
        const mock = makeRootDatabaseMock({ prevVersion: "v1", currentVersion: "v2", xStorage, yStorage });

        await expect(
            runMigration(capabilities, mock.rootDatabase, makeFanInNodeDefs(), async (storage) => {
                await storage.delete(nkA);
                await storage.keep(nkB);
            })
        ).rejects.toThrow();

        expect(mock.setMetaVersionCalledWith).toBeUndefined();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Error identity: the exact thrown object propagates out of runMigration
// ─────────────────────────────────────────────────────────────────────────────

describe("error identity: exact thrown object propagates", () => {
    test("exact Error instance from callback propagates (same reference)", async () => {
        const capabilities = await getTestCapabilities();
        const { rootDatabase, nodeDefs, nodeKey, xStorage } = makeSimpleMigrationSetup();
        await xStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });

        const specificError = new Error("unique error " + Math.random());
        let caught;
        try {
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
        await xStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });

        let caught;
        try {
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
        await populateNode(xStorage, nkB);

        const { yStorage } = makeYDb(makeSchemaStorage());
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "v1", currentVersion: "v2", xStorage, yStorage });

        let caught;
        try {
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
// Infrastructure failures (getMetaVersion, clearStorage, checkpointMigration)
// ─────────────────────────────────────────────────────────────────────────────

describe("infrastructure failures", () => {
    test("getMetaVersion throws: error propagates before any migration work starts", async () => {
        const capabilities = await getTestCapabilities();
        const metaError = new Error("getMetaVersion failure");
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const rootDatabase = {
            version: "2",
            async getMetaVersion() { throw metaError; },
            getSchemaStorage() { return xStorage; },
            currentReplicaName() { return 'x'; },
            otherReplicaName() { return 'y'; },
            schemaStorageForReplica(name) { return name === 'x' ? xStorage : yStorage; },
            async clearReplicaStorage(_name) {},
            async setMetaVersionForReplica(_name, _v) {},
            async switchToReplica() {},
            async setMetaVersion() {},
            async _rawSync() {},
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

    test("unification rawPut throws: error propagates, callback was run, switchToReplica not called", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");
        await xStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });

        const unificationError = new Error("unification write failure");
        const yStorage = makeSchemaStorage();
        for (const name of ['values', 'freshness', 'inputs', 'revdeps', 'counters', 'timestamps']) {
            yStorage[name].rawPut = async () => { throw unificationError; };
            yStorage[name].rawDel = async () => { throw unificationError; };
        }
        const rootDatabase = {
            version: "2",
            async getMetaVersion() { return "1"; },
            getSchemaStorage() { return xStorage; },
            currentReplicaName() { return 'x'; },
            otherReplicaName() { return 'y'; },
            schemaStorageForReplica(name) { return name === 'x' ? xStorage : yStorage; },
            async setMetaVersionForReplica(_name, _v) {},
            async switchToReplica() {},
            async setMetaVersion() {},
            async _rawSync() {},
        };

        let callbackRan = false;
        await expect(
            runMigration(capabilities, rootDatabase, [{ output: "A", inputs: [], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false }],
                async (storage) => { callbackRan = true; await storage.keep(nodeKey); })
        ).rejects.toMatchObject({ cause: unificationError });

        // Callback ran successfully; unification threw on commit.
        expect(callbackRan).toBe(true);
    });

    test("checkpointMigration setup throws: migration does not run, switchToReplica not called", async () => {
        const capabilities = await getTestCapabilities();
        const checkpointError = new Error("checkpoint failure");
        capabilities.checkpointMigration.mockRejectedValueOnce(checkpointError);

        const { nodeDefs, nodeKey, xStorage } = makeSimpleMigrationSetup();
        await xStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });

        // We need a fresh mock so we can check switchToReplicaCalled
        const freshXStorage = makeSchemaStorage();
        await freshXStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });
        const { yStorage } = makeYDb(makeSchemaStorage());
        const freshMock = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage: freshXStorage, yStorage });

        let callbackRan = false;
        await expect(
            runMigration(capabilities, freshMock.rootDatabase, nodeDefs, async (storage) => {
                callbackRan = true;
                await storage.keep(nodeKey);
            })
        ).rejects.toBe(checkpointError);

        expect(callbackRan).toBe(false);
        expect(freshMock.switchToReplicaCalled).toBe(false);
    });

    test("checkpointMigration setup throws: x-namespace data unchanged", async () => {
        const capabilities = await getTestCapabilities();
        const checkpointError = new Error("pre-checkpoint failure");
        capabilities.checkpointMigration.mockRejectedValueOnce(checkpointError);

        const xStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");
        await populateNode(xStorage, nodeKey, { counter: 55 });
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
        await xStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });

        // Rebuild with a mock that tracks the replica switch cutover via switchToReplicaCalled
        const freshXStorage = makeSchemaStorage();
        await freshXStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });
        const { yStorage } = makeYDb(makeSchemaStorage());
        const freshMock = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage: freshXStorage, yStorage });

        let caught;
        try {
            await runMigration(capabilities, freshMock.rootDatabase, nodeDefs, async (storage) => {
                await storage.keep(nodeKey);
            });
        } catch (e) {
            caught = e;
        }

        // The error came from the post-checkpoint, but the migration DID complete
        expect(caught).toBe(postError);
        expect(freshMock.switchToReplicaCalled).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Retry: after a failure, the next call with a correct callback succeeds
// ─────────────────────────────────────────────────────────────────────────────

describe("retry after failure", () => {
    test("failed migration followed by correct migration: second call applies migration and calls switchToReplica", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");
        await xStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });

        const { yStorage } = makeYDb(makeSchemaStorage());
        const mock = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage, yStorage });

        // First attempt fails
        await expect(
            runMigration(capabilities, mock.rootDatabase, [{ output: "A", inputs: [], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false }],
                async () => { throw new Error("first attempt failure"); })
        ).rejects.toThrow("first attempt failure");

        expect(mock.switchToReplicaCalled).toBe(false);

        // Second attempt succeeds
        await runMigration(capabilities, mock.rootDatabase, [{ output: "A", inputs: [], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false }],
            async (storage) => { await storage.keep(nodeKey); });

        expect(mock.switchToReplicaCalled).toBe(true);
    });

    test("failed migration followed by correct migration: two pre/post checkpoint pairs are recorded", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");
        await xStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });

        const { yStorage } = makeYDb(makeSchemaStorage());
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage, yStorage });

        const nodeDef = { output: "A", inputs: [], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false };

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
            await runMigration(capabilities, mock.rootDatabase, makeTwoNodeDefs(), async (storage) => {
                await storage.keep(nkA);
                // B left undecided
            });
        } catch (e) { caughtRetry = e; }
        expect(isUndecidedNodes(caughtRetry)).toBe(true);

        expect(mock.switchToReplicaCalled).toBe(false);

        // Second attempt: correct, decides both nodes
        await runMigration(capabilities, mock.rootDatabase, makeTwoNodeDefs(), async (storage) => {
            await storage.keep(nkA);
            await storage.keep(nkB);
        });

        expect(mock.switchToReplicaCalled).toBe(true);
    });
});
