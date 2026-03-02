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

        const rootDatabase = {
            async lastSchema() { return "previous"; },
            getSchemaStorageForVersion() { return previousStorage; },
            getSchemaStorage() { return currentStorage; },
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
});
