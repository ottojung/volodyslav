/**
 * The Journal 3 startup lifecycle: the §8 gate resolving a canonical bootstrap.
 *
 * `database-lifecycle.md` §8.1 sends a supported pre-Journal replica to
 * the canonical-bootstrap-source decision, and §8.2 makes the consequences binding: no
 * local cutover before a durable canonical artifact is selected, and an unresolved
 * publication outcome leaves the pre-Journal database selected while startup fails.
 *
 * The properties under test are exactly those consequences, over the transport answer
 * vocabulary rather than over the pure path:
 *
 * - a replica which already retains Journal records is never offered to the decision,
 *   so a Journal replica's startup is unchanged;
 * - `DefinitelyAbsent` stages this replica's own graph and publishes it, and the gate
 *   then resumes the creator and installs the canonical cut into the inactive replica;
 * - `Exists` naming this replica's own fingerprint resumes the §6 crash window;
 * - `Exists` naming another creator's artifact takes the §7 join, whose installed replica
 *   holds both the canonical records and this replica's own bootstrap records;
 * - an indeterminate query and an indeterminate publication both report an unresolved
 *   outcome, install nothing, and leave the replica pointer where it was;
 * - a supported pre-Journal replica with no configured cohort source fails closed.
 *
 * Each case drives the real gate over a real replica built by the real production path,
 * so the assertions read persisted state rather than a mock's call log.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const { getRootDatabase } = require("../src/generators/incremental_graph/database");
const { createIncrementalGraph } = require("../src/generators/incremental_graph");
const { runCanonicalBootstrapGate } = require("../src/generators/incremental_graph/journal_bootstrap_gate");
const {
    makeCanonicalBootstrapSnapshot,
    makeCohortBootstrapSource,
    stageCanonicalBootstrap,
} = require("../src/generators/incremental_graph/journal");
const { readLegacyBootstrapState } = require("../src/generators/incremental_graph/journal");
const { readRetainedJournal } = require("../src/generators/incremental_graph/journal_store");
const allEventsModule = require("../src/generators/individual/all_events/wrapper");
const metaEventsComputor = require("../src/generators/individual/meta_events/wrapper").computor;
const eventId = require("../src/event/id");
const { fromISOString } = require("../src/datetime");
const { makeInterface } = require("../src/generators/interface");
const { stubIncrementalDatabaseRemote } = require("./stub_incremental_database_remote");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger, stubEnvironment, stubDatetime, stubRandomSeed, ensureLiveDatabaseDirectory } = require("./stubs");

const CREATOR = {
    name: "tester",
    uuid: "0f6c1a1e-0000-4000-8000-000000000000",
    version: "1.0.0",
    hostname: "host.example",
};

const OTHER_CREATOR = "zzzzzzzzz";

/**
 * The real graph the suite bootstraps: two heads, the second of which has the first as
 * an input, so the cut carries a validity edge and a derived value.
 * @param {object} capabilities
 * @param {object} db
 * @returns {Promise<object>}
 */
async function makeRealGraph(capabilities, db) {
    const box = allEventsModule.makeBox();
    box.value = [
        {
            id: eventId.fromString("aaaaaaaaa:1"),
            date: fromISOString("2020-01-01T09:00:00.000Z"),
            original: "today I ate a sandwich",
            input: "today I ate a sandwich",
            creator: CREATOR,
        },
        {
            id: eventId.fromString("aaaaaaaaa:2"),
            date: fromISOString("2020-01-02T09:00:00.000Z"),
            original: "today I ate a second sandwich",
            input: "today I ate a second sandwich",
            creator: CREATOR,
        },
    ];
    const graph = await createIncrementalGraph(capabilities, db, [
        {
            output: "all_events",
            inputs: [],
            computor: allEventsModule.makeComputor(box, {}),
            isDeterministic: false,
            hasSideEffects: false,
        },
        {
            output: "meta_events",
            inputs: ["all_events"],
            computor: metaEventsComputor,
            isDeterministic: true,
            hasSideEffects: false,
        },
    ]);
    await graph.pull("all_events");
    await graph.pull("meta_events");
    return graph;
}

/**
 * @returns {object}
 */
function testCapabilities() {
    fs.mkdtempSync(path.join(os.tmpdir(), "journal-startup-lifecycle-"));
    const capabilities = getMockedRootCapabilities();
    stubLogger(capabilities);
    stubEnvironment(capabilities);
    stubRandomSeed(capabilities);
    return capabilities;
}

/**
 * A replica which persists materialized state and no Journal record at all, which is
 * what a supported pre-Journal database is.
 * @param {object} db
 * @returns {Promise<void>}
 */
async function clearJournalRecords(db) {
    const storage = db.getSchemaStorage();
    /** @type {Array<*>} */
    const operations = [];
    for await (const key of storage.journal.keys()) {
        operations.push(storage.journal.delOp(key));
    }
    await storage.batch(operations);
}

/**
 * The materialized graph the installed replica persists, read back through the ordinary
 * inspection surface, so an assertion about it is a statement about persisted state.
 * @param {object} capabilities
 * @param {object} db
 * @returns {Promise<object>}
 */
async function readInstalledGraph(capabilities, db) {
    const graph = await createIncrementalGraph(capabilities, db, nodeDefsOf());
    return await graph.pull("meta_events");
}

/**
 * Every node the installed replica persists, as `identifier -> node key`.
 * @param {object} db
 * @returns {Promise<Map<string, string>>}
 */
async function persistedMaterialization(db) {
    const storage = db.getSchemaStorage();
    const lookup = await storage.global.get("identifiers_keys_map");
    return new Map(lookup.map(([identifier, key]) => [identifier, key]));
}

/**
 * @param {object} db
 * @returns {Promise<Array<string>>}
 */
async function retainedRecordKeys(db) {
    /** @type {Array<string>} */
    const keys = [];
    for await (const key of db.getSchemaStorage().journal.keys()) {
        keys.push(key);
    }
    return keys.sort();
}

/**
 * @param {object} db
 * @returns {Promise<number>}
 */
async function retainedRecordCount(db) {
    const replica = await readRetainedJournal(db.getSchemaStorage().journal);
    if (replica instanceof Error) {
        throw replica;
    }
    return [...replica.values()].flat().length;
}

/**
 * A cohort which holds nothing and publishes whatever it is handed.
 * @param {object} calls
 * @returns {object}
 */
function emptyCohortSource(calls) {
    const configured = makeCohortBootstrapSource({
        async queryCanonicalBootstrap() {
            calls.queries += 1;
            return null;
        },
        async publishCanonicalBootstrapIfAbsent(candidate) {
            calls.publications += 1;
            calls.published.push(candidate);
            return {
                published: true,
                artifact: makeCanonicalBootstrapSnapshot({
                    records: candidate.records,
                    creatorWriter: candidate.creatorWriter,
                    bootstrapFrontier: candidate.bootstrapFrontier,
                    databaseVersion: candidate.targetVersion,
                    graphSchemeString: candidate.graphSchemeString,
                }),
            };
        },
    });
    if (configured instanceof Error) {
        throw configured;
    }
    return configured;
}

/**
 * A cohort which already holds a canonical artifact.
 * @param {object} artifact
 * @returns {object}
 */
function holdingCohortSource(artifact) {
    const configured = makeCohortBootstrapSource({
        async queryCanonicalBootstrap() {
            return artifact;
        },
        async publishCanonicalBootstrapIfAbsent() {
            throw new Error("a cohort which already holds an artifact must never be asked to publish");
        },
    });
    if (configured instanceof Error) {
        throw configured;
    }
    return configured;
}

/**
 * A cohort whose every answer is a value the transport contract does not define, which
 * the arbitration must read as indeterminate rather than as an absence.
 * @param {unknown} answer
 * @returns {object}
 */
function unanswerableCohortSource(answer) {
    const configured = makeCohortBootstrapSource({
        async queryCanonicalBootstrap() {
            return answer;
        },
        async publishCanonicalBootstrapIfAbsent() {
            return answer;
        },
    });
    if (configured instanceof Error) {
        throw configured;
    }
    return configured;
}

/**
 * The canonical artifact another creator's pre-Journal graph stages, which is what a
 * joining replica is offered.
 * @param {object} db
 * @param {string} creator
 * @returns {Promise<object>}
 */
async function foreignArtifactOf(db, creator) {
    const storage = db.getSchemaStorage();
    const serializedLookup = await storage.global.get("identifiers_keys_map");
    const inputs = await directInputsOf(storage, serializedLookup);
    /** @type {Array<object>} */
    const nodes = [];
    for (const [identifier, nodeKey] of serializedLookup) {
        const payload = await storage.values.get(identifier);
        const timestamps = await storage.timestamps.get(identifier);
        const freshness = await storage.freshness.get(identifier);
        nodes.push({
            nodeKeyString: nodeKey,
            nodeIdentifier: identifier,
            payload,
            createdAt: timestamps.createdAt,
            modifiedAt: timestamps.modifiedAt,
            upToDate: freshness === "up-to-date",
            validInputs: inputs.get(identifier) ?? [],
        });
    }
    const legacyState = readLegacyBootstrapState({
        graphSchemeString: await storage.global.get("graph_scheme"),
        lastNodeIndex: await storage.global.get("last_node_index"),
        nodes,
    });
    if (legacyState instanceof Error) {
        throw legacyState;
    }
    const candidate = stageCanonicalBootstrap({
        legacyState,
        creatorWriter: require("../src/generators/incremental_graph/journal").makeJournalAuthor(creator),
        targetVersion: db.getVersion(),
    });
    if (candidate instanceof Error) {
        throw candidate;
    }
    return makeCanonicalBootstrapSnapshot({
        records: candidate.records,
        creatorWriter: candidate.creatorWriter,
        bootstrapFrontier: candidate.bootstrapFrontier,
        databaseVersion: candidate.targetVersion,
        graphSchemeString: candidate.graphSchemeString,
    });
}

/**
 * A replica which persists materialized state and no Journal record.
 * @returns {Promise<{capabilities: object, db: object}>}
 */
async function preJournalReplica() {
    const capabilities = testCapabilities();
    const db = await getRootDatabase(capabilities);
    await makeRealGraph(capabilities, db);
    await clearJournalRecords(db);
    return { capabilities, db };
}

/**
 * Startup through the interface itself, over a live database left as supported
 * pre-Journal state.
 * @param {object} source - The configured cohort bootstrap source.
 * @returns {Promise<object>}
 */
async function startupOverPreJournalInterface(source) {
    const capabilities = getMockedRootCapabilities();
    stubLogger(capabilities);
    stubEnvironment(capabilities);
    stubDatetime(capabilities);
    stubRandomSeed(capabilities);
    ensureLiveDatabaseDirectory(capabilities);
    await stubIncrementalDatabaseRemote(capabilities);

    const first = makeInterface(() => capabilities);
    await first.ensureInitialized();
    await first.update([
        {
            id: eventId.fromString("aaaaaaaaa:1"),
            date: fromISOString("2020-01-01T09:00:00.000Z"),
            original: "today I ate a sandwich",
            input: "today I ate a sandwich",
            creator: CREATOR,
        },
    ]);
    await clearJournalRecords(first._database);
    await first._database.close();

    capabilities.cohortBootstrapSource = source;
    const second = makeInterface(() => capabilities);
    await second.ensureInitialized();
    return { capabilities, second };
}

describe("Journal 3 startup canonical-bootstrap gate", () => {
    test("a replica which already retains Journal records is not offered to the decision", async () => {
        const capabilities = testCapabilities();
        const db = await getRootDatabase(capabilities);
        await makeRealGraph(capabilities, db);
        const before = await retainedRecordCount(db);
        const outcome = await runCanonicalBootstrapGate({
            rootDatabase: db,
            nodeDefs: nodeDefsOf(),
            source: emptyCohortSource({ queries: 0, publications: 0, published: [] }),
        });
        expect(outcome.status).toBe("no-pre-journal-state");
        expect(await retainedRecordCount(db)).toBe(before);
        await db.close();
    });

    test("definite absence publishes this replica's own cut and resumes the creator", async () => {
        const { capabilities, db } = await preJournalReplica();
        const replicaBefore = db.currentReplicaName();
        const calls = { queries: 0, publications: 0, published: [] };
        const outcome = await runCanonicalBootstrapGate({
            rootDatabase: db,
            nodeDefs: nodeDefsOf(),
            source: emptyCohortSource(calls),
        });
        expect(outcome.status).toBe("canonical-bootstrapped");
        expect(outcome.operation).toBe("resume-canonical-creator");
        expect(outcome.replica).not.toBe(replicaBefore);
        expect(calls.queries).toBe(1);
        expect(calls.publications).toBe(1);
        expect(await retainedRecordCount(db)).toBeGreaterThan(0);

        // The installed pair is the central law: the materialized graph the cutover
        // persisted is the replay of the Journal it persisted with.
        const materialization = await persistedMaterialization(db);
        expect(materialization.size).toBe(2);
        const meta = await readInstalledGraph(capabilities, db);
        expect(meta.type).toBe("meta_events");
        expect(meta.meta_events).toHaveLength(2);
        await db.close();
    });

    test("an artifact this replica authored is resumed from the cohort's held copy", async () => {
        const { db } = await preJournalReplica();
        const artifact = await ownArtifactOf(db);
        const materializationBefore = await persistedMaterialization(db);
        const outcome = await runCanonicalBootstrapGate({
            rootDatabase: db,
            nodeDefs: nodeDefsOf(),
            source: holdingCohortSource(artifact),
        });
        expect(outcome.status).toBe("canonical-bootstrapped");
        expect(outcome.operation).toBe("resume-canonical-creator");
        // A resume transports the persisted identities: it mints no identifier, so the
        // node key each persisted identifier names is the same one afterwards.
        expect(await persistedMaterialization(db)).toEqual(materializationBefore);
        await db.close();
    });

    test("another creator's artifact is joined, and the installed replica holds both writers' records", async () => {
        const { db } = await preJournalReplica();
        const artifact = await foreignArtifactOf(db, OTHER_CREATOR);
        const outcome = await runCanonicalBootstrapGate({
            rootDatabase: db,
            nodeDefs: nodeDefsOf(),
            source: holdingCohortSource(artifact),
        });
        expect(outcome.status).toBe("canonical-bootstrapped");
        expect(outcome.operation).toBe("join-canonical-bootstrap");
        const records = await retainedRecordCount(db);
        expect(records).toBeGreaterThan(0);
        const replica = await readRetainedJournal(db.getSchemaStorage().journal);
        if (replica instanceof Error) {
            throw replica;
        }
        const authors = new Set(
            [...replica.values()].flat().map((record) => record.id.author.__value)
        );
        // The join keeps both the cohort creator's frozen cut and this replica's own
        // bootstrap records, so both writers appear in the installed replica.
        expect([...authors].sort()).toEqual([OTHER_CREATOR, db.getFingerprint()].sort());
        await db.close();
    });

    test("an indeterminate query is unresolved, installs nothing and moves no pointer", async () => {
        const { db } = await preJournalReplica();
        const replicaBefore = db.currentReplicaName();
        const outcome = await runCanonicalBootstrapGate({
            rootDatabase: db,
            nodeDefs: nodeDefsOf(),
            source: unanswerableCohortSource(undefined),
        });
        expect(outcome.status).toBe("unresolved-canonical-bootstrap");
        expect(db.currentReplicaName()).toBe(replicaBefore);
        expect(await retainedRecordKeys(db)).toEqual([]);
        await db.close();
    });

    test("an indeterminate publication is unresolved and leaves no cutover behind", async () => {
        const { db } = await preJournalReplica();
        const replicaBefore = db.currentReplicaName();
        const configured = makeCohortBootstrapSource({
            async queryCanonicalBootstrap() {
                return null;
            },
            async publishCanonicalBootstrapIfAbsent() {
                return { published: "maybe" };
            },
        });
        if (configured instanceof Error) {
            throw configured;
        }
        const outcome = await runCanonicalBootstrapGate({
            rootDatabase: db,
            nodeDefs: nodeDefsOf(),
            source: configured,
        });
        expect(outcome.status).toBe("unresolved-canonical-bootstrap");
        expect(db.currentReplicaName()).toBe(replicaBefore);
        expect(await retainedRecordKeys(db)).toEqual([]);
        await db.close();
    });

    test("a supported pre-Journal replica with no configured source fails closed", async () => {
        const { db } = await preJournalReplica();
        const replicaBefore = db.currentReplicaName();
        await expect(
            runCanonicalBootstrapGate({ rootDatabase: db, nodeDefs: nodeDefsOf() })
        ).rejects.toThrow(/cohort bootstrap source/);
        expect(db.currentReplicaName()).toBe(replicaBefore);
        expect(await retainedRecordKeys(db)).toEqual([]);
        await db.close();
    });
    test("startup over a live pre-Journal database resolves and installs the canonical bootstrap", async () => {
        const calls = { queries: 0, publications: 0, published: [] };
        const { capabilities, second } = await startupOverPreJournalInterface(emptyCohortSource(calls));
        expect(calls.queries).toBe(1);
        expect(calls.publications).toBe(1);
        const messages = capabilities.logger.logInfo.mock.calls.map((call) => call[1]);
        expect(messages.some((message) => typeof message === "string" && message.includes("resume-canonical-creator"))).toBe(true);
        // The events the pre-Journal database persisted are still readable after the
        // cutover, so bootstrap preserved the graph rather than rebuilding one.
        const events = await second.getAllEvents();
        expect(events).toHaveLength(1);
        expect(events[0].id.identifier).toBe("aaaaaaaaa:1");
        expect(await retainedRecordCount(second._database)).toBeGreaterThan(0);
        await second._database.close();
    });

    test("startup over a live pre-Journal database fails when the canonical bootstrap does not resolve", async () => {
        await expect(
            startupOverPreJournalInterface(unanswerableCohortSource(undefined))
        ).rejects.toThrow(/did not resolve/);
    });
});

/**
 * Each materialized node's direct inputs, which the replica persists as the inverse
 * relation `valid[D] = [dependents validated against D]`.
 * @param {object} storage
 * @param {Array<Array<string>>} serializedLookup
 * @returns {Promise<Map<string, Array<string>>>}
 */
async function directInputsOf(storage, serializedLookup) {
    const keyByIdentifier = new Map(serializedLookup.map(([identifier, key]) => [identifier, key]));
    /** @type {Map<string, Array<string>>} */
    const inputs = new Map();
    for (const [identifier] of serializedLookup) {
        for (const dependent of (await storage.valid.get(identifier)) ?? []) {
            const existing = inputs.get(dependent);
            if (existing === undefined) {
                inputs.set(dependent, [keyByIdentifier.get(identifier)]);
                continue;
            }
            existing.push(keyByIdentifier.get(identifier));
        }
    }
    return inputs;
}

/**
 * The node definitions the running release configures, which fix the graph scheme the
 * gate compares an artifact against.
 * @returns {Array<object>}
 */
function nodeDefsOf() {
    const box = allEventsModule.makeBox();
    box.value = [];
    return [
        {
            output: "all_events",
            inputs: [],
            computor: allEventsModule.makeComputor(box, {}),
            isDeterministic: false,
            hasSideEffects: false,
        },
        {
            output: "meta_events",
            inputs: ["all_events"],
            computor: metaEventsComputor,
            isDeterministic: true,
            hasSideEffects: false,
        },
    ];
}

/**
 * The canonical artifact this replica's own persisted graph stages.
 * @param {object} db
 * @returns {Promise<object>}
 */
async function ownArtifactOf(db) {
    const { makeJournalAuthor } = require("../src/generators/incremental_graph/journal");
    const storage = db.getSchemaStorage();
    const serializedLookup = await storage.global.get("identifiers_keys_map");
    /** @type {Array<object>} */
    const nodes = [];
    const inputs = await directInputsOf(storage, serializedLookup);
    for (const [identifier, nodeKey] of serializedLookup) {
        const payload = await storage.values.get(identifier);
        const timestamps = await storage.timestamps.get(identifier);
        const freshness = await storage.freshness.get(identifier);
        nodes.push({
            nodeKeyString: nodeKey,
            nodeIdentifier: identifier,
            payload,
            createdAt: timestamps.createdAt,
            modifiedAt: timestamps.modifiedAt,
            upToDate: freshness === "up-to-date",
            validInputs: inputs.get(identifier) ?? [],
        });
    }
    const legacyState = readLegacyBootstrapState({
        graphSchemeString: await storage.global.get("graph_scheme"),
        lastNodeIndex: await storage.global.get("last_node_index"),
        nodes,
    });
    if (legacyState instanceof Error) {
        throw legacyState;
    }
    const candidate = stageCanonicalBootstrap({
        legacyState,
        creatorWriter: makeJournalAuthor(db.getFingerprint()),
        targetVersion: db.getVersion(),
    });
    if (candidate instanceof Error) {
        throw candidate;
    }
    return makeCanonicalBootstrapSnapshot({
        records: candidate.records,
        creatorWriter: candidate.creatorWriter,
        bootstrapFrontier: candidate.bootstrapFrontier,
        databaseVersion: candidate.targetVersion,
        graphSchemeString: candidate.graphSchemeString,
    })

}
