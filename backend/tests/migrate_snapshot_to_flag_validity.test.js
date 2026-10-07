const fs = require("fs");
const os = require("os");
const path = require("path");
const { migrateSnapshot } = require("../../scripts/migrate-snapshot-to-flag-validity");
const { createIncrementalGraph } = require("../src/generators/incremental_graph");
const { createDefaultGraphDefinition } = require("../src/generators/interface/default_graph");
const allEvents = require("../src/generators/individual/all_events/wrapper");
const { getMockedRootCapabilities } = require("./spies");
const { fixtureAbsentCohortSource } = require("./journal_startup_fixture");
const { ensureLiveDatabaseDirectory, stubDatetime, stubEnvironment, stubLogger, stubRandomSeed } = require("./stubs");
const { runCanonicalBootstrapGate } = require("../src/generators/incremental_graph/journal_bootstrap_gate");
const {
    getRootDatabase,
    scanFromFilesystem,
    serializeNodeKey,
    stringToNodeName,
} = require("../src/generators/incremental_graph/database");

function nodeKey(head, args = []) {
    return serializeNodeKey({ head: stringToNodeName(head), args });
}

function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

const FINGERPRINT = "testfingerprint";
const ALL_EVENTS_ID = "1-" + FINGERPRINT;
const EVENTS_COUNT_ID = "2-" + FINGERPRINT;

function makeSnapshot({ parentFreshness = "up-to-date", counter = 1, includeCounter = true, lastNodeIndex = 1 } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "volodyslav-migration-"));
    const r = path.join(root, "rendered", "r");
    writeJson(path.join(r, "global", "identifiers_keys_map"), [
        [ALL_EVENTS_ID, nodeKey("all_events")],
        [EVENTS_COUNT_ID, nodeKey("events_count")],
    ]);
    writeJson(path.join(r, "global", "fingerprint"), FINGERPRINT);
    writeJson(path.join(r, "global", "last_node_index"), lastNodeIndex);
    writeJson(path.join(r, "global", "version"), "0.0.0-dev");
    writeJson(path.join(r, "values", ALL_EVENTS_ID), { type: "all_events", events: [] });
    writeJson(path.join(r, "values", EVENTS_COUNT_ID), { type: "events_count", count: 0 });
    writeJson(path.join(r, "freshness", ALL_EVENTS_ID), "up-to-date");
    writeJson(path.join(r, "freshness", EVENTS_COUNT_ID), parentFreshness);
    fs.mkdirSync(path.join(r, "inputs"), { recursive: true });
    fs.mkdirSync(path.join(r, "revdeps"), { recursive: true });
    writeJson(path.join(r, "revdeps", ALL_EVENTS_ID), [EVENTS_COUNT_ID]);
    if (includeCounter) writeJson(path.join(r, "counters", ALL_EVENTS_ID), counter);
    return root;
}

/**
 * Open the migrated snapshot as a real database replica and complete the lifecycle
 * transition a supported pre-Journal installation must go through.
 *
 * `incremental-graph-journal-lifecycle.md` §8.2 makes a pre-Journal materialized
 * replica a canonical-bootstrap source, so a fixture which opens one and then publishes
 * graph semantics has to install the resolved canonical cut first. Without that cut the
 * replica persists materialized values with no Journal value occurrence, and the
 * publication seam correctly refuses to validate a recomputation against nothing.
 *
 * @param {string} snapshotRoot - The migrated snapshot root.
 * @param {object} capabilities - Root capabilities.
 * @param {object[]} nodeDefs - The running release's node definitions.
 * @returns {Promise<object>} The database whose active replica retains the canonical cut.
 */
async function openBootstrappedSnapshotDatabase(snapshotRoot, capabilities, nodeDefs) {
    const replica = path.join(snapshotRoot, "rendered", "r");
    const db = await getRootDatabase(capabilities);
    await scanFromFilesystem(capabilities, db, replica, db.currentReplicaName());
    const outcome = await runCanonicalBootstrapGate({
        rootDatabase: db,
        nodeDefs,
        source: fixtureAbsentCohortSource({ queries: 0, publications: 0, published: [] }),
    });
    if (outcome.status !== "canonical-bootstrapped") {
        throw new Error("the migrated snapshot did not complete its canonical bootstrap: " + outcome.status);
    }
    await db.initializeActiveIdentifierLookup();
    return db;
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
        expect(JSON.parse(fs.readFileSync(path.join(r, "freshness", EVENTS_COUNT_ID), "utf8"))).toBe("potentially-outdated");
        expect(fs.existsSync(path.join(r, "valid", ALL_EVENTS_ID))).toBe(false);
    });

    test("potentially-outdated node omits validity flags", () => {
        const root = makeSnapshot({ parentFreshness: "potentially-outdated", counter: 7 });
        migrateSnapshot(root);
        const r = path.join(root, "rendered", "r");
        expect(JSON.parse(fs.readFileSync(path.join(r, "freshness", EVENTS_COUNT_ID), "utf8"))).toBe("potentially-outdated");
        expect(fs.existsSync(path.join(r, "valid", ALL_EVENTS_ID))).toBe(false);
    });

    test("snapshot with identifier but no cached value is rejected", () => {
        const root = makeSnapshot();
        const r = path.join(root, "rendered", "r");
        fs.rmSync(path.join(r, "values", EVENTS_COUNT_ID));
        fs.rmSync(path.join(r, "freshness", EVENTS_COUNT_ID));
        writeJson(path.join(r, "freshness", ALL_EVENTS_ID), "potentially-outdated");
        expect(() => migrateSnapshot(root)).toThrow(`Identifier has no cached value: ${EVENTS_COUNT_ID}`);
    });

    test("dependency changes before parent pull is represented by absent validity", () => {
        const root = makeSnapshot({ parentFreshness: "potentially-outdated", counter: 2 });
        migrateSnapshot(root);
        expect(fs.existsSync(path.join(root, "rendered", "r", "valid", ALL_EVENTS_ID))).toBe(false);
    });

    test.each([
        ["missing identifiers entry", (r) => writeJson(path.join(r, "global", "identifiers_keys_map"), [[ALL_EVENTS_ID, nodeKey("all_events")]])],
        ["missing counter", (r) => fs.rmSync(path.join(r, "counters", ALL_EVENTS_ID))],
        ["malformed freshness", (r) => writeJson(path.join(r, "freshness", EVENTS_COUNT_ID), "stale")],
        ["malformed dependency counter", (r) => writeJson(path.join(r, "counters", ALL_EVENTS_ID), "1")],
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
        stubLogger(capabilities);
        stubEnvironment(capabilities);
        stubDatetime(capabilities);
        stubRandomSeed(capabilities);
        ensureLiveDatabaseDirectory(capabilities);
        const { nodeDefs, eventsCountCalls } = graphDefinitionsWithCountedEventsCount(capabilities);
        const db = await openBootstrappedSnapshotDatabase(root, capabilities, nodeDefs);
        const graph = await createIncrementalGraph(capabilities, db, nodeDefs);

        await expect(graph.pull("events_count")).resolves.toEqual({ type: "events_count", count: 0 });
        expect(eventsCountCalls()).toBe(1);
        await db.close();
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
