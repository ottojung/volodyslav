/**
 * The retained summary is physically sharded, collision-checked and atomically
 * maintained. The ordinary publication's shard write count depends on its
 * affected closure rather than on unrelated stored nodes.
 */
const { makeInterface } = require("../src/generators/interface");
const { readRetainedReplayState } =
    require("../src/generators/incremental_graph/journal_store");
const { makeJournalAuthor } =
    require("../src/generators/incremental_graph/journal");
const eventId = require("../src/event/id");
const { fromISOString } = require("../src/datetime");
const { getMockedRootCapabilities } = require("./spies");
const {
    stubLogger, stubEnvironment, stubDatetime, stubRandomSeed,
    ensureLiveDatabaseDirectory,
} = require("./stubs");
const { stubIncrementalDatabaseRemote } = require("./stub_incremental_database_remote");

const CREATOR = {
    name: "tester", uuid: "0f6c1a1e-0000-4000-8000-000000000000",
    version: "1.0.0", hostname: "host.example",
};

function capabilities() {
    const caps = getMockedRootCapabilities();
    stubLogger(caps); stubEnvironment(caps); stubDatetime(caps);
    stubRandomSeed(caps); ensureLiveDatabaseDirectory(caps);
    stubIncrementalDatabaseRemote(caps);
    return caps;
}

function event(index) {
    return {
        id: eventId.fromString("aaaaaaaaa:" + (100 + index)),
        date: fromISOString("2020-03-01T09:00:00.000Z"),
        original: "independent event " + index,
        input: "independent event " + index,
        creator: CREATOR,
    };
}

async function withGraph(count, fn) {
    const iface = makeInterface(() => capabilities());
    // The interface captures its capabilities at construction, so it is
    // enough to initialize once before producing a test graph.
    await iface.ensureInitialized();
    try {
        const graph = iface._requireInitializedGraph();
        await graph.pull("config");
        for (let i = 0; i < count; i++) await iface.update([event(i)]);
        return await fn(iface, graph);
    } finally {
        await iface._database.close();
    }
}

async function shardKeys(journal) {
    const keys = [];
    for await (const key of journal.keys({
        gte: "retained_state|node|",
        lt: "retained_state|node}",
    })) {
        if (String(key).startsWith("retained_state|node|")) keys.push(key);
    }
    return keys;
}

test("head shard stores a record ID, not a duplicated payload", async () => {
    await withGraph(3, async (iface) => {
        const journal = iface._database.getSchemaStorage().journal;
        const keys = await shardKeys(journal);
        expect(keys.length).toBeGreaterThan(0);
        const metadata = JSON.parse(await journal.get("retained_state"));
        expect(metadata.nodeCount).toBe(keys.length);
        for (const key of keys) {
            const row = JSON.parse(await journal.get(key));
            expect(Object.keys(row)).toContain("headId");
            expect(row.headId === null || /^[a-z]{9,}:[0-9]+$/.test(row.headId))
                .toBe(true);
            expect(row).not.toHaveProperty("payload");
        }
    });
});

test("missing per-node shard is refused rather than silently changing replay", async () => {
    await withGraph(1, async (iface) => {
        const db = iface._database;
        const journal = db.getSchemaStorage().journal;
        const [key] = await shardKeys(journal);
        expect(key).toBeDefined();
        await journal.del(key);
        const author = makeJournalAuthor(db.getFingerprint());
        const source = await readRetainedReplayState(journal, {
            localWriter: author, currentInputKeysOfNode: () => [],
        });
        expect(source).toBeInstanceOf(Error);
        expect(String(source)).toMatch(/shard/);
    });
});

test("mutated shard content fails integrity before replay can change", async () => {
    await withGraph(1, async (iface) => {
        const db = iface._database;
        const journal = db.getSchemaStorage().journal;
        const [key] = await shardKeys(journal);
        expect(key).toBeDefined();
        const shard = JSON.parse(await journal.get(key));
        shard.selected = [];
        shard.proofs.nodeScoped = [["forged", [["aaaaaaaaa", "1"]]]];
        await journal.put(key, JSON.stringify(shard));
        const result = await readRetainedReplayState(journal, {
            localWriter: makeJournalAuthor(db.getFingerprint()),
            currentInputKeysOfNode: () => [],
        });
        expect(result).toBeInstanceOf(Error);
        expect(String(result)).toMatch(/shard|invalid/);
    });
});

test("injected uncommitted node shard cannot extend the retained state", async () => {
    await withGraph(2, async (iface) => {
        const db = iface._database;
        const journal = db.getSchemaStorage().journal;
        const [key] = await shardKeys(journal);
        expect(key).toBeDefined();
        const row = JSON.parse(await journal.get(key));
        await journal.put("retained_state|node|" + "a".repeat(64), JSON.stringify(row));
        const result = await readRetainedReplayState(journal, {
            localWriter: makeJournalAuthor(db.getFingerprint()),
            currentInputKeysOfNode: () => [],
        });
        expect(result).toBeInstanceOf(Error);
        expect(String(result)).toMatch(/shard/);
    });
});

async function countedShards(unrelated) {
    return withGraph(unrelated, async (iface, graph) => {
        const storage = iface._database.getSchemaStorage();
        const originalBatch = storage.batch;
        const counts = [];
        storage.batch = async (operations) => {
            counts.push(operations.filter(op =>
                op.type === "put" && String(op.key).startsWith("retained_state|node|")
            ).length);
            return originalBatch(operations);
        };
        try {
            await graph.invalidate("config");
            await graph.pull("config");
        } finally {
            storage.batch = originalBatch;
        }
        return counts;
    });
}

test("one-node invalidation/re-pull writes constant shard count across unrelated nodes", async () => {
    const few = await countedShards(0);
    const many = await countedShards(30);
    expect(few.length).toBeGreaterThan(0);
    expect(many).toEqual(few);
    expect(few.every(count => count <= 4)).toBe(true);
});

test("a failed atomic publication leaves every shard unchanged and retry succeeds", async () => {
    await withGraph(3, async (iface, graph) => {
        const db = iface._database;
        const storage = db.getSchemaStorage();
        const journal = storage.journal;
        const keys = await shardKeys(journal);
        const previous = await Promise.all(keys.map(key => journal.get(key)));
        const metadata = await journal.get("retained_state");
        const originalBatch = storage.batch;
        let attempted = false;
        storage.batch = async (operations) => {
            if (operations.some(op => String(op.key).startsWith("retained_state|node|"))) {
                attempted = true;
                throw new Error("injected atomic batch failure");
            }
            return originalBatch(operations);
        };
        let error;
        try {
            await graph.invalidate("config");
        } catch (failure) {
            error = failure;
        } finally {
            storage.batch = originalBatch;
        }
        expect(attempted).toBe(true);
        expect(error).toBeInstanceOf(Error);
        expect(await journal.get("retained_state")).toBe(metadata);
        expect(await shardKeys(journal)).toEqual(keys);
        expect(await Promise.all(keys.map(key => journal.get(key)))).toEqual(previous);
        await graph.invalidate("config");
        await graph.pull("config");
        const verified = await readRetainedReplayState(journal, {
            localWriter: makeJournalAuthor(db.getFingerprint()),
            currentInputKeysOfNode: () => [],
        });
        expect(verified).toBeDefined();
        expect(verified).not.toBeInstanceOf(Error);
    });
});
