/**
 * Tests for the Journal-level restoration of a completely absent installation.
 *
 * `docs/specs/incremental-graph-journal-api.md` §Receiver-less absent restore
 * requires `restoreAbsentFrom(source)` to adopt the source's local writer,
 * retain its history, and reconstruct the materialized graph by *replaying
 * those records*. The rendered projection a published snapshot also carries is
 * not one of the things that restoration reconstructs from, so a published
 * snapshot whose rendered projection is absent is still a continuation-safe
 * source.
 *
 * These tests publish exactly such a snapshot: a real published head carrying
 * this installation's retained Journal, republished with its rendered graph
 * sublevels deleted. A restoration which copies the rendered snapshot
 * materializes nothing from those records; a Journal-level restoration
 * materializes the whole graph from them.
 */

jest.setTimeout(30000);

const path = require("path");
const { makeInterface } = require("../src/generators/interface");
const eventId = require("../src/event/id");
const { fromISOString } = require("../src/datetime");
const {
    DATABASE_SUBPATH,
    LIVE_DATABASE_WORKING_PATH,
    GRAPH_SCHEME_KEY,
    deriveInputPositions,
    makeRootDatabase,
    nodeKeyStringToString,
    parseGraphScheme,
    stringToNodeKeyString,
    renderToFilesystem,
} = require("../src/generators/incremental_graph/database");
const {
    makeJournalAuthor,
    makeReplicaSource,
    projectRetainedJournal,
} = require("../src/generators/incremental_graph/journal");
const { readRetainedJournal } = require("../src/generators/incremental_graph/journal_store");
const { getMockedRootCapabilities } = require("./spies");
const {
    stubLogger,
    stubEnvironment,
    stubDatetime,
    ensureLiveDatabaseDirectory,
} = require("./stubs");

/** The identifier-keyed graph sublevels a rendered projection carries. */
const GRAPH_SUBLEVELS = ["values", "freshness", "timestamps", "valid", "inputs"];

/**
 * @typedef {object} Occurrence
 * @property {string} nodeKeyString
 * @property {*} payload
 */

/**
 * @param {string} id
 * @param {string} input
 * @returns {object}
 */
function makeEvent(id, input) {
    return {
        id: eventId.fromString(id),
        date: fromISOString("2024-01-01T00:00:00.000Z"),
        original: `text ${input}`,
        input: `text ${input}`,
        creator: {
            name: "test",
            uuid: "00000000-0000-0000-0000-000000000001",
            version: "0.0.0",
            hostname: "test-host",
        },
    };
}

/**
 * @returns {object}
 */
function makeRestoreCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    return capabilities;
}

/**
 * @param {object} capabilities
 * @returns {string}
 */
function liveDatabasePathOf(capabilities) {
    return path.join(
        capabilities.environment.workingDirectory(),
        LIVE_DATABASE_WORKING_PATH
    );
}

/**
 * Build this installation's state, publish it, and leave the published head
 * holding the retained Journal alone.
 *
 * @param {object} capabilities
 * @param {ReadonlyArray<object>} events
 * @returns {Promise<void>}
 */
async function publishRetainedJournalOnlySnapshot(capabilities, events) {
    ensureLiveDatabaseDirectory(capabilities);
    await capabilities.git.call(
        "init", "--bare", "--",
        capabilities.environment.generatorsRepository()
    );
    const seedTree = await capabilities.creator.createTemporaryDirectory();
    try {
        await capabilities.git.call("init", "--initial-branch", "main", "--", seedTree);
        const readme = await capabilities.creator.createFile(path.join(seedTree, "README"));
        await capabilities.writer.writeFile(readme, "journal-only restore test remote");
        await capabilities.git.call("-C", seedTree, "add", "--all");
        await capabilities.git.call(
            "-C", seedTree,
            "-c", "user.name=test",
            "-c", "user.email=test@example.com",
            "commit", "-m", "initial"
        );
        await capabilities.git.call(
            "-C", seedTree, "remote", "add", "origin", "--",
            capabilities.environment.generatorsRepository()
        );
        await capabilities.git.call("-C", seedTree, "push", "origin", "main");
    } finally {
        await capabilities.deleter.deleteDirectory(seedTree);
    }

    const publishedInterface = makeInterface(() => capabilities);
    await publishedInterface.ensureInitialized();
    await publishedInterface.update(events);
    if (publishedInterface._database !== null) {
        await publishedInterface._database.close();
    }

    const publishTree = await capabilities.creator.createTemporaryDirectory();
    try {
        const database = await makeRootDatabase(capabilities, liveDatabasePathOf(capabilities));
        const replicaName = database.currentReplicaName();
        const replicaDirectory = path.join(publishTree, DATABASE_SUBPATH, "r");
        await renderToFilesystem(capabilities, database, replicaDirectory, replicaName);
        await database.close();

        const journalDirectory = path.join(replicaDirectory, "journal");
        expect(await capabilities.checker.directoryExists(journalDirectory)).not.toBeNull();

        for (const sublevel of GRAPH_SUBLEVELS) {
            const directory = path.join(replicaDirectory, sublevel);
            if (await capabilities.checker.directoryExists(directory)) {
                await capabilities.deleter.deleteDirectory(directory);
            }
        }
        await capabilities.git.call("init", "--initial-branch", "main", "--", publishTree);
        await capabilities.git.call("-C", publishTree, "add", "--all");
        await capabilities.git.call(
            "-C", publishTree,
            "-c", "user.name=test",
            "-c", "user.email=test@example.com",
            "commit", "-m",
            "Publish the retained journal without its rendered projection"
        );
        await capabilities.git.call(
            "-C", publishTree, "remote", "add", "origin", "--",
            capabilities.environment.generatorsRepository()
        );
        await capabilities.git.call(
            "-C", publishTree, "push", "origin",
            `HEAD:refs/heads/${capabilities.environment.hostname()}-main`
        );
    } finally {
        await capabilities.deleter.deleteDirectory(publishTree);
    }
}

/**
 * Read the occurrence facts the live database materializes.
 *
 * @param {object} capabilities
 * @returns {Promise<Array<Occurrence>>}
 */
async function readMaterializedOccurrences(capabilities) {
    const database = await makeRootDatabase(capabilities, liveDatabasePathOf(capabilities));
    try {
        const storage = database.getSchemaStorage();
        /** @type {Array<Occurrence>} */
        const occurrences = [];
        for (const [nodeIdentifier, nodeKey] of database.getActiveIdentifierLookup().serialized) {
            const payload = await storage.values.get(nodeIdentifier);
            if (payload === undefined) {
                throw new Error(
                    "the restored database materializes an occurrence with no value"
                );
            }
            occurrences.push({
                nodeKeyString: nodeKeyStringToString(nodeKey),
                payload,
            });
        }
        return occurrences.sort((left, right) =>
            left.nodeKeyString < right.nodeKeyString ? -1 : 1
        );
    } finally {
        await database.close();
    }
}

/**
 * Replay the live database's own retained Journal and report the occurrences
 * that replay selects.
 *
 * @param {object} capabilities
 * @returns {Promise<Array<Occurrence>>}
 */
async function replayRetainedJournalOfLiveDatabase(capabilities) {
    const database = await makeRootDatabase(capabilities, liveDatabasePathOf(capabilities));
    try {
        const storage = database.getSchemaStorage();
        const graphScheme = parseGraphScheme(
            await storage.global.get(GRAPH_SCHEME_KEY),
            "restored database graph scheme"
        );
        const localWriter = makeJournalAuthor(database.getFingerprint());
        if (localWriter instanceof Error) {
            throw localWriter;
        }
        const retained = await readRetainedJournal(storage.journal);
        if (retained instanceof Error) {
            throw retained;
        }
        const projection = projectRetainedJournal({
            source: makeReplicaSource(retained),
            localWriter,
            currentInputKeysOfNode: (nodeKeyString) => {
                try {
                    return deriveInputPositions(
                        graphScheme,
                        stringToNodeKeyString(nodeKeyString)
                    ).map(nodeKeyStringToString);
                } catch {
                    return [];
                }
            },
        });
        if (projection instanceof Error) {
            throw projection;
        }
        return projection.occurrences.map((occurrence) => ({
            nodeKeyString: occurrence.nodeKeyString,
            payload: occurrence.payload,
        }));
    } finally {
        await database.close();
    }
}

describe("journal-level absent-installation restoration", () => {
    test("materializes the graph by replaying the held snapshot's retained journal", async () => {
        const capabilities = makeRestoreCapabilities();
        await publishRetainedJournalOnlySnapshot(capabilities, [
            makeEvent("event-1", "First event"),
            makeEvent("event-2", "Second event"),
        ]);
        const publishedOccurrences = await readMaterializedOccurrences(capabilities);
        expect(publishedOccurrences.length).toBeGreaterThan(0);

        await capabilities.deleter.deleteDirectory(liveDatabasePathOf(capabilities));
        const restoredInterface = makeInterface(() => capabilities);
        await restoredInterface.ensureInitialized().catch(() => undefined);

        expect(await readMaterializedOccurrences(capabilities)).toEqual(
            publishedOccurrences
        );
    });

    test("restores a graph which is exactly the replay of its retained journal", async () => {
        const capabilities = makeRestoreCapabilities();
        await publishRetainedJournalOnlySnapshot(capabilities, [
            makeEvent("event-1", "First event"),
            makeEvent("event-2", "Second event"),
        ]);

        await capabilities.deleter.deleteDirectory(liveDatabasePathOf(capabilities));
        const restoredInterface = makeInterface(() => capabilities);
        await restoredInterface.ensureInitialized().catch(() => undefined);

        expect(await replayRetainedJournalOfLiveDatabase(capabilities)).toEqual(
            await readMaterializedOccurrences(capabilities)
        );
    });
});