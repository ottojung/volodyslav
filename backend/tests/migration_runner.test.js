const { runMigration } = require("../src/generators/incremental_graph/migration_runner");
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

describe("runMigration", () => {
    test("invalidate preserves counters from previous storage", async () => {
        const previousStorage = makeSchemaStorage();
        const currentStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");

        await previousStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });
        await previousStorage.values.put(nodeKey, { type: "all_events", events: [] });
        await previousStorage.freshness.put(nodeKey, "up-to-date");
        await previousStorage.counters.put(nodeKey, 5);

        const prevVersionStr = "previous";
        const currentVersionStr = "current";

        /** @type {any} */
        const rootDatabase = {
            version: currentVersionStr,
            async getMetaVersion() { return prevVersionStr; },
            getSchemaStorage() { return previousStorage; },
            withNamespace(_ns) {
                return {
                    getSchemaStorage() { return currentStorage; },
                    async clearStorage() {},
                    async setMetaVersion(_version) {},
                };
            },
            async replaceContentsFrom(_sourceDb) {},
        };

        const nodeDefs = [{
            output: "A",
            inputs: [],
            computor: async () => ({ type: "all_events", events: [] }),
            isDeterministic: true,
            hasSideEffects: false,
            migrations: {},
        }];

        const capabilities = {
            sleeper: {
                withMutex: async (_name, procedure) => procedure(),
            },
        };

        await runMigration(capabilities, rootDatabase, nodeDefs, async (storage) => {
            await storage.invalidate(nodeKey);
        });

        await expect(currentStorage.counters.get(nodeKey)).resolves.toBe(5);
        await expect(currentStorage.freshness.get(nodeKey)).resolves.toBe("potentially-outdated");
    });

    test("skips migration when getMetaVersion returns undefined (fresh database)", async () => {
        const previousStorage = makeSchemaStorage();
        const currentStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");

        await previousStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });
        await previousStorage.counters.put(nodeKey, 3);

        let replaceContentsFromCalled = false;

        /** @type {any} */
        const rootDatabase = {
            version: "current",
            async getMetaVersion() { return undefined; },
            getSchemaStorage() { return previousStorage; },
            withNamespace(_ns) {
                return {
                    getSchemaStorage() { return currentStorage; },
                    async clearStorage() {},
                    async setMetaVersion(_version) {},
                };
            },
            async replaceContentsFrom(_sourceDb) {
                replaceContentsFromCalled = true;
            },
        };

        const nodeDefs = [{
            output: "A",
            inputs: [],
            computor: async () => ({ type: "all_events", events: [] }),
            isDeterministic: true,
            hasSideEffects: false,
            migrations: {},
        }];

        const capabilities = {
            sleeper: {
                withMutex: async (_name, procedure) => procedure(),
            },
        };

        await runMigration(capabilities, rootDatabase, nodeDefs, async (_storage) => {
            throw new Error("callback should not be called for a fresh database");
        });

        expect(replaceContentsFromCalled).toBe(false);
        // currentStorage should be untouched
        expect(await currentStorage.counters.get(nodeKey)).toBeUndefined();
    });

    test("skips migration when version already matches", async () => {
        const previousStorage = makeSchemaStorage();
        const currentStorage = makeSchemaStorage();

        let replaceContentsFromCalled = false;

        /** @type {any} */
        const rootDatabase = {
            version: "1.0.0",
            async getMetaVersion() { return "1.0.0"; },
            getSchemaStorage() { return previousStorage; },
            withNamespace(_ns) {
                return {
                    getSchemaStorage() { return currentStorage; },
                    async clearStorage() {},
                    async setMetaVersion(_version) {},
                };
            },
            async replaceContentsFrom(_sourceDb) {
                replaceContentsFromCalled = true;
            },
        };

        const nodeDefs = [];
        const capabilities = {
            sleeper: {
                withMutex: async (_name, procedure) => procedure(),
            },
        };

        await runMigration(capabilities, rootDatabase, nodeDefs, async (_storage) => {
            throw new Error("callback should not be called when version matches");
        });

        expect(replaceContentsFromCalled).toBe(false);
    });

    test("calls replaceContentsFrom after successful migration", async () => {
        const previousStorage = makeSchemaStorage();
        const currentStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");

        await previousStorage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });
        await previousStorage.values.put(nodeKey, { type: "all_events", events: [] });
        await previousStorage.freshness.put(nodeKey, "up-to-date");
        await previousStorage.counters.put(nodeKey, 2);

        let replaceContentsFromCalled = false;
        let capturedSourceDb = null;

        const yDb = {
            getSchemaStorage() { return currentStorage; },
            async clearStorage() {},
            async setMetaVersion(_version) {},
        };

        /** @type {any} */
        const rootDatabase = {
            version: "2.0.0",
            async getMetaVersion() { return "1.0.0"; },
            getSchemaStorage() { return previousStorage; },
            withNamespace(_ns) { return yDb; },
            async replaceContentsFrom(sourceDb) {
                replaceContentsFromCalled = true;
                capturedSourceDb = sourceDb;
            },
        };

        const nodeDefs = [{
            output: "A",
            inputs: [],
            computor: async () => ({ type: "all_events", events: [] }),
            isDeterministic: true,
            hasSideEffects: false,
            migrations: {},
        }];

        const capabilities = {
            sleeper: {
                withMutex: async (_name, procedure) => procedure(),
            },
        };

        await runMigration(capabilities, rootDatabase, nodeDefs, async (storage) => {
            await storage.keep(nodeKey);
        });

        expect(replaceContentsFromCalled).toBe(true);
        expect(capturedSourceDb).toBe(yDb);
    });
});
