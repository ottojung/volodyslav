const fs = require("fs");
const os = require("os");
const path = require("path");
const { migrateSnapshot } = require("../../scripts/migrate-snapshot-to-flag-validity");
const { createIncrementalGraph } = require("../src/generators/incremental_graph");
const { createDefaultGraphDefinition } = require("../src/generators/interface/default_graph");
const allEvents = require("../src/generators/individual/all_events/wrapper");
const { getMockedRootCapabilities } = require("./spies");
const {
    makeIdentifierLookup,
    serializeNodeKey,
    stringToNodeName,
    nodeIdToKeyFromLookup,
    nodeKeyToIdFromLookup,
    nodeIdentifierFromString,
} = require("../src/generators/incremental_graph/database");

function nodeKey(head, args = []) {
    return serializeNodeKey({ head: stringToNodeName(head), args });
}

function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function makeSnapshot({ parentFreshness = "up-to-date", counter = 1, includeCounter = true, lastNodeIndex = 1 } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "volodyslav-migration-"));
    const r = path.join(root, "rendered", "r");
    writeJson(path.join(r, "global", "identifiers_keys_map"), [
        ["a", nodeKey("all_events")],
        ["b", nodeKey("events_count")],
    ]);
    writeJson(path.join(r, "global", "fingerprint"), "testfingerprint");
    writeJson(path.join(r, "global", "last_node_index"), lastNodeIndex);
    writeJson(path.join(r, "global", "version"), "0.0.0-dev");
    writeJson(path.join(r, "values", "a"), { type: "all_events", events: [] });
    writeJson(path.join(r, "values", "b"), { type: "events_count", count: 0 });
    writeJson(path.join(r, "freshness", "a"), "up-to-date");
    writeJson(path.join(r, "freshness", "b"), parentFreshness);
    fs.mkdirSync(path.join(r, "inputs"), { recursive: true });
    fs.mkdirSync(path.join(r, "revdeps"), { recursive: true });
    writeJson(path.join(r, "revdeps", "a"), ["b"]);
    if (includeCounter) writeJson(path.join(r, "counters", "a"), counter);
    return root;
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
}

class MigratedSnapshotDatabase {
    constructor(snapshotRoot) {
        const replica = path.join(snapshotRoot, "rendered", "r");
        this.schemaMap = new Map();
        this.version = readJson(path.join(replica, "global", "version"));
        this.fingerprint = readJson(path.join(replica, "global", "fingerprint"));
        this.lastNodeIndex = readJson(path.join(replica, "global", "last_node_index"));
        this.identifierLookup = makeIdentifierLookup(readJson(path.join(replica, "global", "identifiers_keys_map")));
        this.nextId = this.lastNodeIndex;
        for (const sublevel of ["values", "freshness", "valid", "timestamps", "global"]) {
            const directory = path.join(replica, sublevel);
            if (!fs.existsSync(directory)) continue;
            for (const key of fs.readdirSync(directory)) {
                this.schemaMap.set(`${sublevel}:${key}`, readJson(path.join(directory, key)));
            }
        }
    }

    currentReplicaName() { return "r"; }

    getVersion() { return this.version; }

    getFingerprint() { return this.fingerprint; }

    getLastNodeIndex() { return this.lastNodeIndex; }

    advanceLastNodeIndex(value) { this.lastNodeIndex = Math.max(this.lastNodeIndex, value); }

    getActiveIdentifierLookup() { return this.identifierLookup; }

    cloneActiveIdentifierLookup() { return makeIdentifierLookup(this.identifierLookup.serialized); }

    replaceActiveIdentifierLookup(lookup) { this.identifierLookup = lookup; }

    nodeIdToKey(nodeIdentifier) { return nodeIdToKeyFromLookup(this.identifierLookup, nodeIdentifier); }

    nodeKeyToId(nodeKeyString) { return nodeKeyToIdFromLookup(this.identifierLookup, nodeKeyString); }

    getCurrentAllocationWatermark() { return this.nextId; }

    generateNodeIdentifier() {
        this.nextId += 1;
        return nodeIdentifierFromString(`${this.nextId.toString(36)}-${this.fingerprint}`);
    }

    releaseIdentifierReservations() {}

    getSchemaStorage() {
        const createSublevel = (name) => {
            const prefix = `${name}:`;
            return {
                get: async (key) => {
                    const value = this.schemaMap.get(prefix + String(key));
                    return value === undefined ? undefined : deepClone(value);
                },
                put: async (key, value) => {
                    this.schemaMap.set(prefix + String(key), deepClone(value));
                },
                del: async (key) => {
                    this.schemaMap.delete(prefix + String(key));
                },
                putOp: (key, value) => ({ type: "put", sublevel: createSublevel(name), key, value }),
                delOp: (key) => ({ type: "del", sublevel: createSublevel(name), key }),
                keys: async function* () {
                    for (const storedKey of this.schemaMap.keys()) {
                        if (storedKey.startsWith(prefix)) yield storedKey.substring(prefix.length);
                    }
                }.bind(this),
                clear: async () => {
                    for (const storedKey of [...this.schemaMap.keys()]) {
                        if (storedKey.startsWith(prefix)) this.schemaMap.delete(storedKey);
                    }
                },
            };
        };
        return {
            values: createSublevel("values"),
            freshness: createSublevel("freshness"),
            valid: createSublevel("valid"),
            timestamps: createSublevel("timestamps"),
            global: createSublevel("global"),
            batch: async (operations) => {
                for (const operation of operations) {
                    if (operation.type === "put") await operation.sublevel.put(operation.key, operation.value);
                    else if (operation.type === "del") await operation.sublevel.del(operation.key);
                }
            },
        };
    }
}

function graphDefinitionsWithCountedEventsCount(capabilities) {
    let calls = 0;
    const nodeDefs = createDefaultGraphDefinition(capabilities, undefined, allEvents.makeBox()).map((nodeDef) => {
        if (nodeDef.output !== "events_count") return nodeDef;
        return {
            ...nodeDef,
            computor: async (inputs, oldValue, bindings) => {
                calls += 1;
                return await nodeDef.computor(inputs, oldValue, bindings);
            },
        };
    });
    return { nodeDefs, eventsCountCalls: () => calls };
}

describe("migrate-snapshot-to-flag-validity", () => {
    test("cached non-source node is marked potentially-outdated without minted validity flags", () => {
        const root = makeSnapshot();
        migrateSnapshot(root);
        const r = path.join(root, "rendered", "r");
        expect(JSON.parse(fs.readFileSync(path.join(r, "freshness", "b"), "utf8"))).toBe("potentially-outdated");
        expect(fs.existsSync(path.join(r, "valid", "a"))).toBe(false);
    });

    test("potentially-outdated node omits validity flags", () => {
        const root = makeSnapshot({ parentFreshness: "potentially-outdated", counter: 7 });
        migrateSnapshot(root);
        const r = path.join(root, "rendered", "r");
        expect(JSON.parse(fs.readFileSync(path.join(r, "freshness", "b"), "utf8"))).toBe("potentially-outdated");
        expect(fs.existsSync(path.join(r, "valid", "a"))).toBe(false);
    });

    test("snapshot with identifier but no cached value is rejected", () => {
        const root = makeSnapshot();
        const r = path.join(root, "rendered", "r");
        fs.rmSync(path.join(r, "values", "b"));
        fs.rmSync(path.join(r, "freshness", "b"));
        writeJson(path.join(r, "freshness", "a"), "potentially-outdated");
        expect(() => migrateSnapshot(root)).toThrow("Identifier has no cached value: b");
    });

    test("dependency changes before parent pull is represented by absent validity", () => {
        const root = makeSnapshot({ parentFreshness: "potentially-outdated", counter: 2 });
        migrateSnapshot(root);
        expect(fs.existsSync(path.join(root, "rendered", "r", "valid", "a"))).toBe(false);
    });

    test.each([
        ["missing identifiers entry", (r) => writeJson(path.join(r, "global", "identifiers_keys_map"), [["a", nodeKey("all_events")]])],
        ["missing counter", (r) => fs.rmSync(path.join(r, "counters", "a"))],
        ["malformed freshness", (r) => writeJson(path.join(r, "freshness", "b"), "stale")],
        ["malformed dependency counter", (r) => writeJson(path.join(r, "counters", "a"), "1")],
        ["missing fingerprint", (r) => fs.rmSync(path.join(r, "global", "fingerprint"))],
        ["malformed last_node_index", (r) => writeJson(path.join(r, "global", "last_node_index"), "1")],
        ["missing version", (r) => fs.rmSync(path.join(r, "global", "version"))],
    ])("malformed source snapshot fails: %s", (_name, mutate) => {
        const root = makeSnapshot();
        mutate(path.join(root, "rendered", "r"));
        expect(() => migrateSnapshot(root)).toThrow();
    });


    test("runtime pull invokes computor for migrated potentially-outdated node", async () => {
        const root = makeSnapshot({ parentFreshness: "potentially-outdated", counter: 3 });
        migrateSnapshot(root);
        const capabilities = getMockedRootCapabilities();
        const { nodeDefs, eventsCountCalls } = graphDefinitionsWithCountedEventsCount(capabilities);
        const db = new MigratedSnapshotDatabase(root);
        const graph = await createIncrementalGraph(capabilities, db, nodeDefs);

        await expect(graph.pull("events_count")).resolves.toEqual({ type: "events_count", count: 0 });
        expect(eventsCountCalls()).toBe(1);
    });


    test("target shape removes source sublevels and writes graph_scheme and valid", () => {
        const root = makeSnapshot();
        migrateSnapshot(root);
        const r = path.join(root, "rendered", "r");
        expect(fs.existsSync(path.join(r, "inputs"))).toBe(false);
        expect(fs.existsSync(path.join(r, "revdeps"))).toBe(false);
        expect(fs.existsSync(path.join(r, "counters"))).toBe(false);
        expect(fs.existsSync(path.join(r, "global", "graph_scheme"))).toBe(true);
        expect(fs.existsSync(path.join(r, "valid"))).toBe(true);
    });
});
