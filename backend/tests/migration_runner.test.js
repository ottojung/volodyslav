const { runMigration } = require("../src/generators/incremental_graph/migration_runner");
const {
    isUndecidedNodes,
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
};

describe("runMigration", () => {
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
            migrations: {},
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
                migrations: {},
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
                migrations: {},
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
                migrations: {},
            }];

            await runMigration(capabilities, mock.rootDatabase, nodeDefs, async (storage) => {
                await storage.keep(nodeKey);
            });

            expect(mock.replaceContentsFromCalled).toBe(true);
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
                migrations: {},
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
                migrations: {},
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
                migrations: {},
            }];

            await expect(
                runMigration(capabilities, mock.rootDatabase, nodeDefs, async () => {
                    throw new Error("intentional failure");
                })
            ).rejects.toThrow("intentional failure");

            // y was still cleared before the callback ran
            expect(yMock.clearStorageCalled).toBe(true);
        });
    });
});
