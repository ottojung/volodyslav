const { runMigration } = require("../src/generators/incremental_graph/migration_runner");
const {
    isUndecidedNodes,
    isPartialDeleteFanIn,
    isDecisionConflict,
} = require("../src/generators/incremental_graph");
const { toJsonKey } = require("./test_json_key_helper");

function makeInMemoryDb(table) {
    const store = new Map();
    return {
        async get(key) { return store.get(key); },
        async put(key, value) { store.set(key, value); },
        putOp(key, value) { return { type: "put", table, key, value }; },
        async *keys() { for (const key of store.keys()) yield key; },
        apply(operation) {
            if (operation.type === "put" && operation.table === table) {
                store.set(operation.key, operation.value);
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

    return {
        values,
        freshness,
        inputs,
        revdeps,
        counters,
        async batch(operations) {
            for (const operation of operations) {
                values.apply(operation);
                freshness.apply(operation);
                inputs.apply(operation);
                revdeps.apply(operation);
                counters.apply(operation);
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
 * @param {object} opts.yDb - what withNamespace("y") returns
 * @returns {{ rootDatabase: any, replaceContentsFromCalled: boolean }}
 */
function makeRootDatabaseMock({ prevVersion, currentVersion, xStorage, yDb }) {
    let replaceContentsFromCalled = false;
    let setMetaVersionCalledWith = undefined;

    const rootDatabase = {
        version: currentVersion,
        async getMetaVersion() { return prevVersion; },
        getSchemaStorage() { return xStorage; },
        withNamespace(_ns) { return yDb; },
        async replaceContentsFrom(_sourceDb) {
            replaceContentsFromCalled = true;
        },
        async setMetaVersion(v) {
            setMetaVersionCalledWith = v;
        },
    };

    return {
        rootDatabase,
        get replaceContentsFromCalled() { return replaceContentsFromCalled; },
        get setMetaVersionCalledWith() { return setMetaVersionCalledWith; },
    };
}

function makeYDb(storage) {
    let clearStorageCalled = false;
    let setMetaVersionCalledWith = undefined;

    const yDb = {
        getSchemaStorage() { return storage; },
        async clearStorage() { clearStorageCalled = true; },
        async setMetaVersion(v) { setMetaVersionCalledWith = v; },
    };

    return {
        yDb,
        get clearStorageCalled() { return clearStorageCalled; },
        get setMetaVersionCalledWith() { return setMetaVersionCalledWith; },
    };
}

const capabilities = {
    sleeper: { withMutex: async (_name, procedure) => procedure() },
    checkpointDatabase: jest.fn().mockResolvedValue(undefined),
};

/**
 * Builds a minimal but representative migration scenario.
 * The xStorage has one node ("A") that the migration callback can act upon.
 */
function makeSimpleMigrationSetup({ prevVersion = "1.0.0", currentVersion = "2.0.0" } = {}) {
    const xStorage = makeSchemaStorage();
    const yStorage = makeSchemaStorage();
    const nodeKey = toJsonKey("A");
    const { yDb } = makeYDb(yStorage);
    const { rootDatabase } = makeRootDatabaseMock({
        prevVersion,
        currentVersion,
        xStorage,
        yDb,
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
    beforeEach(() => {
        capabilities.checkpointDatabase.mockClear();
    });

    test("invalidate preserves counters from previous storage", async () => {
        const previousStorage = makeSchemaStorage();
        const currentStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");

        await previousStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });
        await previousStorage.values.put(nodeKey, { type: "all_events", events: [] });
        await previousStorage.freshness.put(nodeKey, "up-to-date");
        await previousStorage.counters.put(nodeKey, 5);

        const { yDb } = makeYDb(currentStorage);
        const { rootDatabase } = makeRootDatabaseMock({
            prevVersion: "previous",
            currentVersion: "current",
            xStorage: previousStorage,
            yDb,
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
        test("skips migration and does not call replaceContentsFrom", async () => {
            const previousStorage = makeSchemaStorage();
            const currentStorage = makeSchemaStorage();
            const { yDb } = makeYDb(currentStorage);
            const mock = makeRootDatabaseMock({
                prevVersion: undefined,
                currentVersion: "1.0.0",
                xStorage: previousStorage,
                yDb,
            });

            await runMigration(capabilities, mock.rootDatabase, [], async (_storage) => {
                throw new Error("callback must not be called for a fresh database");
            });

            expect(mock.replaceContentsFromCalled).toBe(false);
        });

        test("records current version via setMetaVersion so future upgrades are detected", async () => {
            const xStorage = makeSchemaStorage();
            const { yDb } = makeYDb(makeSchemaStorage());
            const mock = makeRootDatabaseMock({
                prevVersion: undefined,
                currentVersion: "1.0.0",
                xStorage,
                yDb,
            });

            await runMigration(capabilities, mock.rootDatabase, [], async () => {});

            expect(mock.setMetaVersionCalledWith).toBe("1.0.0");
        });

        test("does not call checkpointDatabase", async () => {
            const xStorage = makeSchemaStorage();
            const { yDb } = makeYDb(makeSchemaStorage());
            const mock = makeRootDatabaseMock({
                prevVersion: undefined,
                currentVersion: "1.0.0",
                xStorage,
                yDb,
            });

            await runMigration(capabilities, mock.rootDatabase, [], async () => {});

            expect(capabilities.checkpointDatabase).not.toHaveBeenCalled();
        });
    });

    describe("no migration needed (version already matches)", () => {
        test("skips migration and does not call replaceContentsFrom", async () => {
            const xStorage = makeSchemaStorage();
            const { yDb } = makeYDb(makeSchemaStorage());
            const mock = makeRootDatabaseMock({
                prevVersion: "1.0.0",
                currentVersion: "1.0.0",
                xStorage,
                yDb,
            });

            await runMigration(capabilities, mock.rootDatabase, [], async (_storage) => {
                throw new Error("callback must not be called when version matches");
            });

            expect(mock.replaceContentsFromCalled).toBe(false);
        });

        test("does not call checkpointDatabase", async () => {
            const xStorage = makeSchemaStorage();
            const { yDb } = makeYDb(makeSchemaStorage());
            const mock = makeRootDatabaseMock({
                prevVersion: "1.0.0",
                currentVersion: "1.0.0",
                xStorage,
                yDb,
            });

            await runMigration(capabilities, mock.rootDatabase, [], async () => {});

            expect(capabilities.checkpointDatabase).not.toHaveBeenCalled();
        });
    });

    describe("successful migration", () => {
        test("clears y namespace before running the callback", async () => {
            const xStorage = makeSchemaStorage();
            const nodeKey = toJsonKey("A");
            await xStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });

            const yStorage = makeSchemaStorage();
            const yMock = makeYDb(yStorage);
            const mock = makeRootDatabaseMock({
                prevVersion: "1.0.0",
                currentVersion: "2.0.0",
                xStorage,
                yDb: yMock.yDb,
            });

            const nodeDefs = [{
                output: "A",
                inputs: [],
                computor: async () => ({ type: "all_events", events: [] }),
                isDeterministic: true,
                hasSideEffects: false,
            }];

            await runMigration(capabilities, mock.rootDatabase, nodeDefs, async (storage) => {
                await storage.keep(nodeKey);
            });

            expect(yMock.clearStorageCalled).toBe(true);
        });

        test("writes version to y before calling replaceContentsFrom", async () => {
            const xStorage = makeSchemaStorage();
            const nodeKey = toJsonKey("A");
            await xStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });

            const yStorage = makeSchemaStorage();
            const yMock = makeYDb(yStorage);

            const callOrder = [];
            const yDb = {
                ...yMock.yDb,
                async setMetaVersion(v) {
                    callOrder.push({ action: "setMetaVersion", arg: v });
                },
            };

            let replaceContentsFromCalled = false;
            const rootDatabase = {
                version: "2.0.0",
                async getMetaVersion() { return "1.0.0"; },
                getSchemaStorage() { return xStorage; },
                withNamespace(_ns) { return yDb; },
                async replaceContentsFrom(_sourceDb) {
                    callOrder.push({ action: "replaceContentsFrom" });
                    replaceContentsFromCalled = true;
                },
                async setMetaVersion(_v) {},
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

            expect(replaceContentsFromCalled).toBe(true);
            expect(callOrder[0]).toEqual({ action: "setMetaVersion", arg: "2.0.0" });
            expect(callOrder[1]).toEqual({ action: "replaceContentsFrom" });
        });

        test("calls replaceContentsFrom with the y database", async () => {
            const previousStorage = makeSchemaStorage();
            const nodeKey = toJsonKey("A");
            await previousStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });
            await previousStorage.values.put(nodeKey, { type: "all_events", events: [] });
            await previousStorage.freshness.put(nodeKey, "up-to-date");
            await previousStorage.counters.put(nodeKey, 2);

            const yStorage = makeSchemaStorage();
            const yMock = makeYDb(yStorage);
            const mock = makeRootDatabaseMock({
                prevVersion: "1.0.0",
                currentVersion: "2.0.0",
                xStorage: previousStorage,
                yDb: yMock.yDb,
            });

            const nodeDefs = [{
                output: "A",
                inputs: [],
                computor: async () => ({ type: "all_events", events: [] }),
                isDeterministic: true,
                hasSideEffects: false,
            }];

            await runMigration(capabilities, mock.rootDatabase, nodeDefs, async (storage) => {
                await storage.keep(nodeKey);
            });

            expect(mock.replaceContentsFromCalled).toBe(true);
        });

        test("calls checkpointDatabase exactly twice: once before and once after migration", async () => {
            const { rootDatabase, nodeDefs, nodeKey, xStorage } = makeSimpleMigrationSetup();
            await xStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });

            await runMigration(capabilities, rootDatabase, nodeDefs, async (storage) => {
                await storage.keep(nodeKey);
            });

            expect(capabilities.checkpointDatabase).toHaveBeenCalledTimes(2);
        });

        test("pre-migration checkpoint message contains both the old and new version", async () => {
            const { rootDatabase, nodeDefs, nodeKey, xStorage } = makeSimpleMigrationSetup({
                prevVersion: "1.0.0",
                currentVersion: "2.0.0",
            });
            await xStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });

            await runMigration(capabilities, rootDatabase, nodeDefs, async (storage) => {
                await storage.keep(nodeKey);
            });

            const firstCall = capabilities.checkpointDatabase.mock.calls[0][0];
            expect(firstCall).toContain("pre-migration:");
            expect(firstCall).toContain("1.0.0");
            expect(firstCall).toContain("2.0.0");
        });

        test("post-migration checkpoint message contains the new version", async () => {
            const { rootDatabase, nodeDefs, nodeKey, xStorage } = makeSimpleMigrationSetup({
                prevVersion: "1.0.0",
                currentVersion: "2.0.0",
            });
            await xStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });

            await runMigration(capabilities, rootDatabase, nodeDefs, async (storage) => {
                await storage.keep(nodeKey);
            });

            const secondCall = capabilities.checkpointDatabase.mock.calls[1][0];
            expect(secondCall).toContain("post-migration:");
            expect(secondCall).toContain("2.0.0");
        });

        test("pre-migration checkpoint is called before replaceContentsFrom", async () => {
            const callOrder = [];
            capabilities.checkpointDatabase.mockImplementation(async (msg) => {
                callOrder.push(`checkpoint:${msg}`);
            });

            const xStorage = makeSchemaStorage();
            const nodeKey = toJsonKey("A");
            await xStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });

            const yStorage = makeSchemaStorage();
            const { yDb } = makeYDb(yStorage);
            const rootDatabase = {
                version: "2.0.0",
                async getMetaVersion() { return "1.0.0"; },
                getSchemaStorage() { return xStorage; },
                withNamespace(_ns) { return yDb; },
                async replaceContentsFrom(_source) { callOrder.push("replaceContentsFrom"); },
                async setMetaVersion(_v) {},
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

            const preIdx = callOrder.findIndex((e) => typeof e === "string" && e.startsWith("checkpoint:pre-migration"));
            const replaceIdx = callOrder.indexOf("replaceContentsFrom");
            expect(preIdx).toBeGreaterThanOrEqual(0);
            expect(replaceIdx).toBeGreaterThan(preIdx);
        });

        test("post-migration checkpoint is called after replaceContentsFrom", async () => {
            const callOrder = [];
            capabilities.checkpointDatabase.mockImplementation(async (msg) => {
                callOrder.push(`checkpoint:${msg}`);
            });

            const xStorage = makeSchemaStorage();
            const nodeKey = toJsonKey("A");
            await xStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });

            const yStorage = makeSchemaStorage();
            const { yDb } = makeYDb(yStorage);
            const rootDatabase = {
                version: "2.0.0",
                async getMetaVersion() { return "1.0.0"; },
                getSchemaStorage() { return xStorage; },
                withNamespace(_ns) { return yDb; },
                async replaceContentsFrom(_source) { callOrder.push("replaceContentsFrom"); },
                async setMetaVersion(_v) {},
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
            const replaceIdx = callOrder.indexOf("replaceContentsFrom");
            expect(postIdx).toBeGreaterThan(replaceIdx);
        });
    });

    describe("failure cases", () => {
        test("callback throws: replaceContentsFrom is NOT called and error propagates", async () => {
            const xStorage = makeSchemaStorage();
            const nodeKey = toJsonKey("A");
            await xStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });

            const yMock = makeYDb(makeSchemaStorage());
            const mock = makeRootDatabaseMock({
                prevVersion: "1.0.0",
                currentVersion: "2.0.0",
                xStorage,
                yDb: yMock.yDb,
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

            expect(mock.replaceContentsFromCalled).toBe(false);
        });

        test("finalize throws UndecidedNodesError when a node has no decision: replaceContentsFrom NOT called", async () => {
            const xStorage = makeSchemaStorage();
            const nodeKey = toJsonKey("A");
            await xStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });

            const yMock = makeYDb(makeSchemaStorage());
            const mock = makeRootDatabaseMock({
                prevVersion: "1.0.0",
                currentVersion: "2.0.0",
                xStorage,
                yDb: yMock.yDb,
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
            expect(mock.replaceContentsFromCalled).toBe(false);
        });

        test("callback throws: y namespace is already cleared (clearStorage was called)", async () => {
            const xStorage = makeSchemaStorage();
            const nodeKey = toJsonKey("A");
            await xStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });

            const yMock = makeYDb(makeSchemaStorage());
            const mock = makeRootDatabaseMock({
                prevVersion: "1.0.0",
                currentVersion: "2.0.0",
                xStorage,
                yDb: yMock.yDb,
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

            // y was still cleared before the callback ran
            expect(yMock.clearStorageCalled).toBe(true);
        });

        test("callback throws: pre-migration checkpoint is called but post-migration is not", async () => {
            const { rootDatabase, nodeDefs, nodeKey, xStorage } = makeSimpleMigrationSetup();
            await xStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });

            await expect(
                runMigration(capabilities, rootDatabase, nodeDefs, async () => {
                    throw new Error("intentional failure");
                })
            ).rejects.toThrow("intentional failure");

            expect(capabilities.checkpointDatabase).toHaveBeenCalledTimes(1);
            const firstCall = capabilities.checkpointDatabase.mock.calls[0][0];
            expect(firstCall).toContain("pre-migration:");
        });

        test("finalize throws: pre-migration checkpoint is called but post-migration is not", async () => {
            const { rootDatabase, nodeDefs, nodeKey, xStorage } = makeSimpleMigrationSetup();
            await xStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });

            // Callback runs but assigns no decision → finalize throws UndecidedNodesError
            await expect(
                runMigration(capabilities, rootDatabase, nodeDefs, async (_storage) => {
                    // intentionally leave the node undecided
                })
            ).rejects.toThrow();

            expect(capabilities.checkpointDatabase).toHaveBeenCalledTimes(1);
            const firstCall = capabilities.checkpointDatabase.mock.calls[0][0];
            expect(firstCall).toContain("pre-migration:");
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
    return snapshot;
}

/** Populate xStorage with realistic data for node "A". */
async function populateNode(storage, nodeKey, {
    value = { type: "all_events", events: [] },
    freshness = "up-to-date",
    inputs = [],
    inputCounters = [],
    counter = 1,
} = {}) {
    await storage.values.put(nodeKey, value);
    await storage.freshness.put(nodeKey, freshness);
    await storage.inputs.put(nodeKey, { inputs, inputCounters });
    await storage.counters.put(nodeKey, counter);
}

/** Build a two-node graph where B depends on A (A → B). */
async function buildTwoNodeGraph(storage, nodeKeyA, nodeKeyB) {
    await populateNode(storage, nodeKeyA, { counter: 3 });
    await populateNode(storage, nodeKeyB, {
        inputs: [nodeKeyA],
        inputCounters: [3],
        counter: 7,
        freshness: "potentially-outdated",
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
    beforeEach(() => {
        capabilities.checkpointDatabase.mockClear();
    });

    test("callback throws synchronously: every x-sublevel entry is identical to before", async () => {
        const xStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");
        await populateNode(xStorage, nodeKey, { counter: 42, freshness: "up-to-date" });

        const { yDb } = makeYDb(makeSchemaStorage());
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage, yDb });
        const snapshotBefore = await captureStorageSnapshot(xStorage);

        await expect(
            runMigration(capabilities, rootDatabase, [{ output: "A", inputs: [], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false }],
                async () => { throw new Error("boom"); })
        ).rejects.toThrow("boom");

        expect(await captureStorageSnapshot(xStorage)).toEqual(snapshotBefore);
    });

    test("callback returns rejected promise: every x-sublevel entry is identical to before", async () => {
        const xStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");
        await populateNode(xStorage, nodeKey, { counter: 11 });

        const { yDb } = makeYDb(makeSchemaStorage());
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage, yDb });
        const snapshotBefore = await captureStorageSnapshot(xStorage);

        const rejection = new Error("async rejection");
        await expect(
            runMigration(capabilities, rootDatabase, [{ output: "A", inputs: [], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false }],
                () => Promise.reject(rejection))
        ).rejects.toBe(rejection);

        expect(await captureStorageSnapshot(xStorage)).toEqual(snapshotBefore);
    });

    test("UndecidedNodesError from finalize: x-namespace data unchanged", async () => {
        const xStorage = makeSchemaStorage();
        const nkA = toJsonKey("A");
        const nkB = toJsonKey("B");
        await populateNode(xStorage, nkA, { counter: 5 });
        await populateNode(xStorage, nkB, { counter: 9, freshness: "potentially-outdated" });

        const { yDb } = makeYDb(makeSchemaStorage());
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "v1", currentVersion: "v2", xStorage, yDb });
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
        const xStorage = makeSchemaStorage();
        const [nkA, nkB, nkC] = [toJsonKey("A"), toJsonKey("B"), toJsonKey("C")];
        await buildFanInGraph(xStorage, nkA, nkB, nkC);

        const { yDb } = makeYDb(makeSchemaStorage());
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "v1", currentVersion: "v2", xStorage, yDb });
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
        const xStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");
        await populateNode(xStorage, nodeKey, { counter: 3 });

        const { yDb } = makeYDb(makeSchemaStorage());
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage, yDb });
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

    test("batch() throws in applyDecisions: x-namespace data unchanged, replaceContentsFrom not called", async () => {
        const xStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");
        await populateNode(xStorage, nodeKey, { counter: 99 });
        const snapshotBefore = await captureStorageSnapshot(xStorage);

        // Build a yStorage whose batch function throws
        const yStorage = makeSchemaStorage();
        const batchError = new Error("batch write failure");
        yStorage.batch = async () => { throw batchError; };

        const { yDb } = makeYDb(yStorage);
        const mock = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage, yDb });

        await expect(
            runMigration(capabilities, mock.rootDatabase, [{ output: "A", inputs: [], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false }],
                async (storage) => { await storage.keep(nodeKey); })
        ).rejects.toBe(batchError);

        expect(mock.replaceContentsFromCalled).toBe(false);
        expect(await captureStorageSnapshot(xStorage)).toEqual(snapshotBefore);
    });

    test("y.setMetaVersion throws: x-namespace data unchanged, replaceContentsFrom not called", async () => {
        const xStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");
        await populateNode(xStorage, nodeKey, { counter: 7 });
        const snapshotBefore = await captureStorageSnapshot(xStorage);

        const metaError = new Error("setMetaVersion failure");
        const yStorage = makeSchemaStorage();
        const yDb = {
            getSchemaStorage: () => yStorage,
            async clearStorage() {},
            async setMetaVersion() { throw metaError; },
        };
        const mock = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage, yDb });

        await expect(
            runMigration(capabilities, mock.rootDatabase, [{ output: "A", inputs: [], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false }],
                async (storage) => { await storage.keep(nodeKey); })
        ).rejects.toBe(metaError);

        expect(mock.replaceContentsFromCalled).toBe(false);
        expect(await captureStorageSnapshot(xStorage)).toEqual(snapshotBefore);
    });

    test("replaceContentsFrom throws: error propagates and x had not been modified before the throw", async () => {
        const xStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");
        await populateNode(xStorage, nodeKey, { counter: 2 });
        const snapshotBefore = await captureStorageSnapshot(xStorage);

        const swapError = new Error("swap failed");
        const yStorage = makeSchemaStorage();
        const yDb = {
            getSchemaStorage: () => yStorage,
            async clearStorage() {},
            async setMetaVersion() {},
        };
        // Override replaceContentsFrom to throw without touching xStorage
        const rootDatabase = {
            version: "2",
            async getMetaVersion() { return "1"; },
            getSchemaStorage() { return xStorage; },
            withNamespace(_ns) { return yDb; },
            async replaceContentsFrom() { throw swapError; },
            async setMetaVersion() {},
        };

        await expect(
            runMigration(capabilities, rootDatabase, [{ output: "A", inputs: [], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false }],
                async (storage) => { await storage.keep(nodeKey); })
        ).rejects.toBe(swapError);

        // x was never modified by migration code — only replaceContentsFrom would do that
        expect(await captureStorageSnapshot(xStorage)).toEqual(snapshotBefore);
    });

    test("multi-node graph: all x-values intact after UndecidedNodesError", async () => {
        const xStorage = makeSchemaStorage();
        const nkA = toJsonKey("A");
        const nkB = toJsonKey("B");
        await buildTwoNodeGraph(xStorage, nkA, nkB);

        const { yDb } = makeYDb(makeSchemaStorage());
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "v1", currentVersion: "v2", xStorage, yDb });
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
        const xStorage = makeSchemaStorage();
        const nkA = toJsonKey("A");
        const nkB = toJsonKey("B");
        await buildTwoNodeGraph(xStorage, nkA, nkB);

        const { yDb } = makeYDb(makeSchemaStorage());
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "v1", currentVersion: "v2", xStorage, yDb });

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
        const xStorage = makeSchemaStorage();
        const [nkA, nkB, nkC] = [toJsonKey("A"), toJsonKey("B"), toJsonKey("C")];
        await buildFanInGraph(xStorage, nkA, nkB, nkC);
        const snapshotBefore = await captureStorageSnapshot(xStorage);

        const { yDb } = makeYDb(makeSchemaStorage());
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "v1", currentVersion: "v2", xStorage, yDb });

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
    beforeEach(() => {
        capabilities.checkpointDatabase.mockClear();
    });

    test("callback throws: x.setMetaVersion never called", async () => {
        const xStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");
        await xStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });

        const { yDb } = makeYDb(makeSchemaStorage());
        const mock = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage, yDb });

        await expect(
            runMigration(capabilities, mock.rootDatabase, [{ output: "A", inputs: [], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false }],
                async () => { throw new Error("oops"); })
        ).rejects.toThrow();

        expect(mock.setMetaVersionCalledWith).toBeUndefined();
    });

    test("UndecidedNodesError: x.setMetaVersion never called", async () => {
        const xStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");
        await xStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });

        const { yDb } = makeYDb(makeSchemaStorage());
        const mock = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage, yDb });

        let caughtUndecided3;
        try {
            await runMigration(capabilities, mock.rootDatabase, [{ output: "A", inputs: [], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false }],
                async (_storage) => { /* no decision */ });
        } catch (e) { caughtUndecided3 = e; }
        expect(isUndecidedNodes(caughtUndecided3)).toBe(true);

        expect(mock.setMetaVersionCalledWith).toBeUndefined();
    });

    test("PartialDeleteFanInError: x.setMetaVersion never called", async () => {
        const xStorage = makeSchemaStorage();
        const [nkA, nkB, nkC] = [toJsonKey("A"), toJsonKey("B"), toJsonKey("C")];
        await buildFanInGraph(xStorage, nkA, nkB, nkC);

        const { yDb } = makeYDb(makeSchemaStorage());
        const mock = makeRootDatabaseMock({ prevVersion: "v1", currentVersion: "v2", xStorage, yDb });

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
    beforeEach(() => {
        capabilities.checkpointDatabase.mockClear();
    });

    test("exact Error instance from callback propagates (same reference)", async () => {
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

    test("exact Error from pre-migration checkpointDatabase propagates", async () => {
        const checkpointError = new Error("pre-checkpoint failure");
        capabilities.checkpointDatabase.mockRejectedValueOnce(checkpointError);

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
        const xStorage = makeSchemaStorage();
        const nkA = toJsonKey("A");
        const nkB = toJsonKey("B");
        await populateNode(xStorage, nkA);
        await populateNode(xStorage, nkB);

        const { yDb } = makeYDb(makeSchemaStorage());
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "v1", currentVersion: "v2", xStorage, yDb });

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
        const xStorage = makeSchemaStorage();
        const [nkA, nkB, nkC] = [toJsonKey("A"), toJsonKey("B"), toJsonKey("C")];
        await buildFanInGraph(xStorage, nkA, nkB, nkC);

        const { yDb } = makeYDb(makeSchemaStorage());
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "v1", currentVersion: "v2", xStorage, yDb });

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
        const xStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");
        await populateNode(xStorage, nodeKey);

        const { yDb } = makeYDb(makeSchemaStorage());
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage, yDb });

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
// Infrastructure failures (getMetaVersion, clearStorage, checkpointDatabase)
// ─────────────────────────────────────────────────────────────────────────────

describe("infrastructure failures", () => {
    beforeEach(() => {
        capabilities.checkpointDatabase.mockClear();
    });

    test("getMetaVersion throws: error propagates before any migration work starts", async () => {
        const metaError = new Error("getMetaVersion failure");
        const rootDatabase = {
            version: "2",
            async getMetaVersion() { throw metaError; },
            getSchemaStorage() { return makeSchemaStorage(); },
            withNamespace(_ns) { return makeYDb(makeSchemaStorage()).yDb; },
            async replaceContentsFrom() {},
            async setMetaVersion() {},
        };

        let caught;
        try {
            await runMigration(capabilities, rootDatabase, [], async () => {});
        } catch (e) {
            caught = e;
        }

        expect(caught).toBe(metaError);
        expect(capabilities.checkpointDatabase).not.toHaveBeenCalled();
    });

    test("clearStorage throws: error propagates, callback never runs", async () => {
        const xStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");
        await xStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });

        const clearError = new Error("clearStorage failure");
        const yDb = {
            getSchemaStorage() { return makeSchemaStorage(); },
            async clearStorage() { throw clearError; },
            async setMetaVersion() {},
        };
        const mock = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage, yDb });

        let callbackRan = false;
        await expect(
            runMigration(capabilities, mock.rootDatabase, [{ output: "A", inputs: [], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false }],
                async () => { callbackRan = true; })
        ).rejects.toBe(clearError);

        expect(callbackRan).toBe(false);
        expect(mock.replaceContentsFromCalled).toBe(false);
    });

    test("pre-migration checkpointDatabase throws: migration does not run, replaceContentsFrom not called", async () => {
        const checkpointError = new Error("checkpoint failure");
        capabilities.checkpointDatabase.mockRejectedValueOnce(checkpointError);

        const { nodeDefs, nodeKey, xStorage } = makeSimpleMigrationSetup();
        await xStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });

        // We need a fresh mock so we can check replaceContentsFromCalled
        const freshXStorage = makeSchemaStorage();
        await freshXStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });
        const { yDb } = makeYDb(makeSchemaStorage());
        const freshMock = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage: freshXStorage, yDb });

        let callbackRan = false;
        await expect(
            runMigration(capabilities, freshMock.rootDatabase, nodeDefs, async (storage) => {
                callbackRan = true;
                await storage.keep(nodeKey);
            })
        ).rejects.toBe(checkpointError);

        expect(callbackRan).toBe(false);
        expect(freshMock.replaceContentsFromCalled).toBe(false);
    });

    test("pre-migration checkpointDatabase throws: x-namespace data unchanged", async () => {
        const checkpointError = new Error("pre-checkpoint failure");
        capabilities.checkpointDatabase.mockRejectedValueOnce(checkpointError);

        const xStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");
        await populateNode(xStorage, nodeKey, { counter: 55 });
        const snapshotBefore = await captureStorageSnapshot(xStorage);

        const { yDb } = makeYDb(makeSchemaStorage());
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage, yDb });

        await expect(
            runMigration(capabilities, rootDatabase, [{ output: "A", inputs: [], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false }],
                async (storage) => { await storage.keep(nodeKey); })
        ).rejects.toBe(checkpointError);

        expect(await captureStorageSnapshot(xStorage)).toEqual(snapshotBefore);
    });

    test("post-migration checkpointDatabase throws: migration was already applied (replaceContentsFrom WAS called)", async () => {
        const postError = new Error("post-checkpoint failure");

        // First call (pre) succeeds; second call (post) rejects
        capabilities.checkpointDatabase
            .mockResolvedValueOnce(undefined) // pre
            .mockRejectedValueOnce(postError); // post

        const { nodeDefs, nodeKey, xStorage } = makeSimpleMigrationSetup();
        await xStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });

        // Rebuild with a spy on replaceContentsFrom
        const freshXStorage = makeSchemaStorage();
        await freshXStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });
        const { yDb } = makeYDb(makeSchemaStorage());
        const freshMock = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage: freshXStorage, yDb });

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
        expect(freshMock.replaceContentsFromCalled).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Retry: after a failure, the next call with a correct callback succeeds
// ─────────────────────────────────────────────────────────────────────────────

describe("retry after failure", () => {
    beforeEach(() => {
        capabilities.checkpointDatabase.mockClear();
    });

    test("failed migration followed by correct migration: second call applies migration and calls replaceContentsFrom", async () => {
        const xStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");
        await xStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });

        const { yDb } = makeYDb(makeSchemaStorage());
        const mock = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage, yDb });

        // First attempt fails
        await expect(
            runMigration(capabilities, mock.rootDatabase, [{ output: "A", inputs: [], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false }],
                async () => { throw new Error("first attempt failure"); })
        ).rejects.toThrow("first attempt failure");

        expect(mock.replaceContentsFromCalled).toBe(false);

        // Second attempt succeeds
        await runMigration(capabilities, mock.rootDatabase, [{ output: "A", inputs: [], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false }],
            async (storage) => { await storage.keep(nodeKey); });

        expect(mock.replaceContentsFromCalled).toBe(true);
    });

    test("failed migration followed by correct migration: two pre/post checkpoint pairs are recorded", async () => {
        const xStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");
        await xStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });

        const { yDb } = makeYDb(makeSchemaStorage());
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage, yDb });

        const nodeDef = { output: "A", inputs: [], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false };

        // First attempt: only pre-checkpoint fires
        await expect(
            runMigration(capabilities, rootDatabase, [nodeDef], async () => { throw new Error("fail"); })
        ).rejects.toThrow();

        expect(capabilities.checkpointDatabase).toHaveBeenCalledTimes(1);
        capabilities.checkpointDatabase.mockClear();

        // Second (successful) attempt: both pre and post fire
        await runMigration(capabilities, rootDatabase, [nodeDef], async (storage) => {
            await storage.keep(nodeKey);
        });

        expect(capabilities.checkpointDatabase).toHaveBeenCalledTimes(2);
    });

    test("UndecidedNodes failure then correct callback: x-values reflect successful migration in y", async () => {
        const xStorage = makeSchemaStorage();
        const nkA = toJsonKey("A");
        const nkB = toJsonKey("B");
        await buildTwoNodeGraph(xStorage, nkA, nkB);

        const { yDb } = makeYDb(makeSchemaStorage());
        const mock = makeRootDatabaseMock({ prevVersion: "v1", currentVersion: "v2", xStorage, yDb });

        // First attempt: only decide A, B undecided → fail
        let caughtRetry;
        try {
            await runMigration(capabilities, mock.rootDatabase, makeTwoNodeDefs(), async (storage) => {
                await storage.keep(nkA);
                // B left undecided
            });
        } catch (e) { caughtRetry = e; }
        expect(isUndecidedNodes(caughtRetry)).toBe(true);

        expect(mock.replaceContentsFromCalled).toBe(false);

        // Second attempt: correct, decides both nodes
        await runMigration(capabilities, mock.rootDatabase, makeTwoNodeDefs(), async (storage) => {
            await storage.keep(nkA);
            await storage.keep(nkB);
        });

        expect(mock.replaceContentsFromCalled).toBe(true);
    });
});
