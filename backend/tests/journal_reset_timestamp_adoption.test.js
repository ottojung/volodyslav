/**
 * `incremental-graph-journal-testing.md` §Reset timestamp adoption, exercised through
 * the production reset.
 *
 * The claim is about immutable occurrence fields crossing a lifecycle boundary: when
 * receiver R and source S both materialize semantic node K with different occurrences,
 * reset establishes the source occurrence, and the observable
 * `getCreationTime(K)` / `getModificationTime(K)` become the source's `Cs`/`Ms`
 * exactly. Neither the receiver's previous timestamps nor the reset's own execution
 * instant may appear in their place.
 *
 * Every test drives the production path — `synchronizeNoLock` with a reset-to-hostname
 * over a real checkpoint repository, against a receiver whose records were published
 * by the production `pull` — and observes the result through the interface's own
 * timestamp readers and the receiver's persisted rows:
 *
 * - the source's occurrences carry `Cs`/`Ms` from the source's own publication clock,
 *   and the receiver's previous occurrences carry a later instant, so the source's
 *   timestamps are also numerically older than the ones they replace;
 * - the receiver's own occurrence wins the raw union's head selection, so reset must
 *   author the replacement rather than merely import it;
 * - after reset the observable times are the source's, the replacement `ValueEvent`
 *   carries the source occurrence's identifier, payload and both timestamps, and the
 *   receiver still retains its own writer's history beside the imported records.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const {
    getRootDatabase,
    renderToFilesystem,
    synchronizeNoLock,
    DATABASE_SUBPATH,
} = require("../src/generators/incremental_graph/database");
const {
    createIncrementalGraph,
    resetJournalReceiverToSnapshot,
} = require("../src/generators/incremental_graph");
const {
    journalAuthorToString,
    isValueEvent,
    nodeKeyToCanonicalString,
} = require("../src/generators/incremental_graph/journal");
const { readRetainedJournal } = require("../src/generators/incremental_graph/journal_store");

const allEventsModule = require("../src/generators/individual/all_events/wrapper");
const metaEventsComputor = require("../src/generators/individual/meta_events/wrapper").computor;
const eventContextComputor = require("../src/generators/individual/event_context/wrapper").computor;

const eventId = require("../src/event/id");
const { fromISOString } = require("../src/datetime");
const { getMockedRootCapabilities } = require("./spies");
const { stubDatetime, stubEnvironment, stubLogger } = require("./stubs");

jest.setTimeout(120000);

const CREATOR = {
    name: "tester",
    uuid: "0f6c1a1e-0000-4000-8000-000000000000",
    version: "1.0.0",
    hostname: "host.example",
};

/**
 * The source's own publication clock, which is also older than the receiver's.
 *
 * `SOURCE_MODIFIED` is earlier than `SOURCE_CREATED`, so the held occurrences carry a
 * `createdAt` after their `modifiedAt`: reset adopting them is visible per field, and the
 * adopted pair is not numerically ordered.
 */
const SOURCE_CREATED = "2021-06-01T12:00:00.000Z";
const SOURCE_MODIFIED = "2021-05-01T00:00:00.000Z";
/** The receiver's publication clock, later than the source's, so its occurrence wins. */
const RECEIVER_CREATED = "2023-03-04T05:06:07.000Z";
const RECEIVER_MODIFIED = "2023-03-05T05:06:07.000Z";
/** The reset's own execution instant, later than both, which must never surface. */
const RESET_INSTANT = "2025-12-31T23:59:59.000Z";

/** The materialized heads of the fixture graph, in dependency order. */
const HEADS = ["all_events", "meta_events", "event_context"];

/**
 * The graph both databases run: three real heads whose computors need neither a filesystem
 * nor an AI capability, so a publication in either database is the production one.
 *
 * The box is returned beside the graph because a test changes the event text between two
 * pulls, which is how a fixture occurrence acquires a `createdAt` and a `modifiedAt` that
 * are not the same instant.
 *
 * @param {object} capabilities
 * @param {object} db
 * @param {string} original - The event text this installation's own event carries.
 * @returns {Promise<{graph: import("../src/generators/incremental_graph").IncrementalGraph, box: object}>}
 */
async function makeRealGraph(capabilities, db, original) {
    const box = allEventsModule.makeBox();
    box.value = [
        {
            id: eventId.fromString("aaaaaaaaa:1"),
            date: fromISOString("2020-01-01T09:00:00.000Z"),
            original,
            input: original,
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
        {
            output: "event_context",
            inputs: ["meta_events"],
            computor: eventContextComputor,
            isDeterministic: true,
            hasSideEffects: false,
        },
    ]);
    return { graph, box };
}

/**
 * @param {string} label
 * @returns {object}
 */
function capabilitiesFor(label) {
    fs.mkdtempSync(path.join(os.tmpdir(), `journal-reset-timestamps-${label}-`));
    const capabilities = getMockedRootCapabilities();
    stubLogger(capabilities);
    stubEnvironment(capabilities);
    stubDatetime(capabilities);
    return capabilities;
}

/**
 * A database whose journal the production path filled, with every occurrence carrying a
 * `createdAt` from the first instant and a `modifiedAt` from a later changed pull.
 *
 * The two instants are deliberately distinct, so a fixture timestamp is not confused with
 * a mix-up of the two fields, and the modified instant is earlier than the created one, so
 * the occurrence is one whose timestamps are not numerically ordered.
 *
 * @param {object} capabilities
 * @param {string} firstText - The event text the first publication carries.
 * @param {string} secondText - The event text the changed second publication carries.
 * @param {string} createdInstant - The clock of the first publication.
 * @param {string} modifiedInstant - The clock of the changed second publication.
 * @returns {Promise<object>}
 */
async function buildPulledDatabase(capabilities, firstText, secondText, createdInstant, modifiedInstant) {
    capabilities.datetime.setDateTime(fromISOString(createdInstant));
    const db = await getRootDatabase(capabilities);
    const { graph, box } = await makeRealGraph(capabilities, db, firstText);
    await graph.pull("event_context");
    box.value = [
        {
            id: eventId.fromString("aaaaaaaaa:1"),
            date: fromISOString("2020-01-01T09:00:00.000Z"),
            original: secondText,
            input: secondText,
            creator: CREATOR,
        },
    ];
    capabilities.datetime.setDateTime(fromISOString(modifiedInstant));
    await graph.invalidate("all_events");
    await graph.pull("event_context");
    return db;
}

/**
 * Render one database's active replica into a checkpoint work tree and publish it as the
 * remote hostname branch a reset-to-hostname restores from.
 *
 * @param {object} capabilities - The capabilities of the installation being reset, which
 *   own the remote and the branch name.
 * @param {object} sourceDatabase - The held snapshot's database.
 * @returns {Promise<void>}
 */
async function publishHeldSnapshot(capabilities, sourceDatabase) {
    const remotePath = capabilities.environment.generatorsRepository();
    const branch = `${capabilities.environment.hostname()}-main`;
    const workTree = await capabilities.creator.createTemporaryDirectory();
    try {
        await renderToFilesystem(
            capabilities,
            sourceDatabase,
            path.join(workTree, DATABASE_SUBPATH, 'r'),
            sourceDatabase.currentReplicaName()
        );
        await capabilities.git.call("init", "--bare", "--", remotePath);
        await capabilities.git.call("init", "--initial-branch", branch, "--", workTree);
        await capabilities.git.call("-C", workTree, "add", "--all");
        await capabilities.git.call(
            "-C",
            workTree,
            "-c",
            "user.name=volodyslav",
            "-c",
            "user.email=volodyslav",
            "commit",
            "-m",
            "publish held snapshot"
        );
        await capabilities.git.call("-C", workTree, "remote", "add", "origin", "--", remotePath);
        await capabilities.git.call("-C", workTree, "push", "origin", branch);
    } finally {
        await capabilities.deleter.deleteDirectory(workTree);
    }
}

/**
 * The persisted occurrence rows of one database's activated replica, keyed by canonical
 * node key string: exactly the fields the held snapshot's projection carries.
 *
 * @param {object} db
 * @returns {Promise<Map<string, {nodeIdentifier: object, payload: object, timestamps: object}>>}
 */
async function rowsOf(db) {
    const storage = db.getSchemaStorage();
    /** @type {Map<string, {nodeIdentifier: object, payload: object, timestamps: object}>} */
    const rows = new Map();
    for await (const identifier of storage.values.keys()) {
        rows.set(String(db.nodeIdToKey(identifier)), {
            nodeIdentifier: identifier,
            payload: await storage.values.get(identifier),
            timestamps: await storage.timestamps.get(identifier),
        });
    }
    return rows;
}

/**
 * Reset one installation to the held snapshot `publishHeldSnapshot` published.
 *
 * @param {object} capabilities
 * @returns {Promise<void>}
 */
async function resetToHeldSnapshot(capabilities) {
    await synchronizeNoLock(capabilities, {
        resetToHostname: capabilities.environment.hostname(),
        journalReset: resetJournalReceiverToSnapshot,
    });
}

describe('reset adopts the held occurrence timestamps rather than either clock', () => {
    test('the observable creation and modification times become the source occurrence\'s', async () => {
        const receiverCapabilities = capabilitiesFor('adopt');
        const sourceCapabilities = capabilitiesFor('adopt-source');

        const sourceDatabase = await buildPulledDatabase(
            sourceCapabilities,
            'the held snapshot first wrote this',
            'the held snapshot then wrote this',
            SOURCE_CREATED,
            SOURCE_MODIFIED
        );
        const sourceFingerprint = sourceDatabase.getFingerprint();
        const sourceRows = await rowsOf(sourceDatabase);
        expect(sourceRows.size).toBeGreaterThan(0);
        for (const row of sourceRows.values()) {
            expect(row.timestamps.createdAt).toBe(SOURCE_CREATED);
            expect(row.timestamps.modifiedAt).toBe(SOURCE_MODIFIED);
        }
        await publishHeldSnapshot(receiverCapabilities, sourceDatabase);
        await sourceDatabase.close();

        const receiver = await buildPulledDatabase(
            receiverCapabilities,
            'the receiver first wrote this',
            'the receiver then wrote this',
            RECEIVER_CREATED,
            RECEIVER_MODIFIED
        );
        const receiverFingerprint = receiver.getFingerprint();
        expect(receiverFingerprint).not.toBe(sourceFingerprint);
        const receiverRows = await rowsOf(receiver);
        expect(receiverRows.size).toBe(sourceRows.size);
        // The receiver's own occurrences are the later lineage, so reset moves both
        // timestamps backwards: the result cannot be the receiver's previous state.
        for (const [nodeKeyString, row] of receiverRows) {
            expect(row.timestamps.createdAt).toBe(RECEIVER_CREATED);
            expect(row.timestamps.modifiedAt).toBe(RECEIVER_MODIFIED);
            expect(sourceRows.get(nodeKeyString).payload).not.toEqual(row.payload);
        }
        await receiver.close();

        receiverCapabilities.datetime.setDateTime(fromISOString(RESET_INSTANT));
        await resetToHeldSnapshot(receiverCapabilities);

        const reopened = await getRootDatabase(receiverCapabilities);
        try {
            const { graph } = await makeRealGraph(
                receiverCapabilities,
                reopened,
                'the receiver first wrote this'
            );
            for (const head of HEADS) {
                expect((await graph.getCreationTime(head)).toISOString()).toBe(SOURCE_CREATED);
                expect((await graph.getModificationTime(head)).toISOString()).toBe(SOURCE_MODIFIED);
            }
            expect(await rowsOf(reopened)).toEqual(sourceRows);
        } finally {
            await reopened.close();
        }
    });

    test('the replacement ValueEvent carries the source occurrence and the receiver keeps its own history', async () => {
        const receiverCapabilities = capabilitiesFor('replacement');
        const sourceCapabilities = capabilitiesFor('replacement-source');

        const sourceDatabase = await buildPulledDatabase(
            sourceCapabilities,
            'the held snapshot first wrote this',
            'the held snapshot then wrote this',
            SOURCE_CREATED,
            SOURCE_MODIFIED
        );
        const sourceFingerprint = sourceDatabase.getFingerprint();
        const sourceRows = await rowsOf(sourceDatabase);
        await publishHeldSnapshot(receiverCapabilities, sourceDatabase);
        await sourceDatabase.close();

        const receiver = await buildPulledDatabase(
            receiverCapabilities,
            'the receiver first wrote this',
            'the receiver then wrote this',
            RECEIVER_CREATED,
            RECEIVER_MODIFIED
        );
        const receiverFingerprint = receiver.getFingerprint();
        await receiver.close();

        receiverCapabilities.datetime.setDateTime(fromISOString(RESET_INSTANT));
        await resetToHeldSnapshot(receiverCapabilities);

        const reopened = await getRootDatabase(receiverCapabilities);
        try {
            const replica = await readRetainedJournal(reopened.getSchemaStorage().journal);
            if (replica instanceof Error) {
                throw replica;
            }
            const records = [...replica.values()].flat();
            const authors = new Set(records.map((record) => journalAuthorToString(record.id.author)));
            expect(authors.has(receiverFingerprint)).toBe(true);
            expect(authors.has(sourceFingerprint)).toBe(true);

            // Reset authored the replacement under the receiver's own writer, one per
            // target-present node, carrying exactly the held source occurrence.
            const replacements = records.filter(
                (record) =>
                    isValueEvent(record) &&
                    record.reason === 'reset' &&
                    journalAuthorToString(record.id.author) === receiverFingerprint
            );
            expect(replacements.map((record) => nodeKeyToCanonicalString(record.node)).sort())
                .toEqual([...sourceRows.keys()].sort());
            for (const replacement of replacements) {
                const row = sourceRows.get(nodeKeyToCanonicalString(replacement.node));
                expect(replacement.nodeIdentifier).toEqual(row.nodeIdentifier);
                expect(replacement.payload).toEqual(row.payload);
                expect(replacement.createdAt).toBe(row.timestamps.createdAt);
                expect(replacement.modifiedAt).toBe(row.timestamps.modifiedAt);
            }
        } finally {
            await reopened.close();
        }
    });
});
