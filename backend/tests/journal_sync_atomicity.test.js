/**
 * `incremental-graph-journal-sync.md` §Atomicity, exercised through the production sync.
 *
 * The claim is one statement about one write: a synchronization may construct `J0` and its
 * repairs in inactive storage, the receiver exposes either `old journal + old graph` or
 * `Jsync + project(Jsync)` and never a split or intermediate state, and a failure before
 * cutover leaves the previous supported receiver active.
 *
 * Every test here drives the production path — `synchronizeNoLock` with a `journalSync`
 * callback over a real checkpoint repository, against a receiver whose records were published
 * by the production `pull` — and observes the receiver afterwards through its own readers:
 *
 * - the receiver retains its own history instead of replacing it, so `Jsync` names both
 *   writers;
 * - the graph the receiver exposes is exactly what its own journal projects to;
 * - the whole sync is carried by one batch which writes the journal and the graph together;
 * - a publication which fails leaves the previously activated replica as the receiver.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const {
    DATABASE_SUBPATH,
    getRootDatabase,
    GRAPH_SCHEME_KEY,
    parseGraphScheme,
    renderToFilesystem,
    synchronizeNoLock,
} = require("../src/generators/incremental_graph/database");
const { createIncrementalGraph, syncJournalReceiverToSource } = require("../src/generators/incremental_graph");
const { readRetainedJournal } = require("../src/generators/incremental_graph/journal_store");
const { makeCurrentInputKeysOfNode } = require("../src/generators/incremental_graph/journal_bootstrap_startup");
const {
    journalAuthorToString,
    makeJournalAuthor,
    makeReplicaSource,
    projectRetainedJournal,
} = require("../src/generators/incremental_graph/journal");

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
 * The graph both databases run: three real heads whose computors need neither a filesystem
 * nor an AI capability, so a publication in either database is the production one.
 *
 * @param {object} capabilities
 * @param {object} db
 * @param {string} original - The event text the source database's own event carries.
 * @returns {Promise<import("../src/generators/incremental_graph").IncrementalGraph>}
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
    return await createIncrementalGraph(capabilities, db, [
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
}

/**
 * @param {number} label
 * @returns {object}
 */
function capabilitiesFor(label) {
    fs.mkdtempSync(path.join(os.tmpdir(), `journal-sync-atomicity-${label}-`));
    const capabilities = getMockedRootCapabilities();
    stubLogger(capabilities);
    stubEnvironment(capabilities);
    stubDatetime(capabilities);
    return capabilities;
}

/**
 * A database whose journal the production path filled by pulling `event_context`.
 *
 * @param {object} capabilities
 * @param {string} original - The event text this installation's own event carries.
 * @returns {Promise<object>}
 */
async function buildPulledDatabase(capabilities, original) {
    const db = await getRootDatabase(capabilities);
    const graph = await makeRealGraph(capabilities, db, original);
    await graph.pull("event_context");
    return db;
}

/**
 * Render one database's active replica into a checkpoint work tree and publish it as a
 * remote hostname branch a synchronization imports from.
 *
 * The remote carries two branches: the receiver's own hostname branch, which the
 * synchronization clones on first contact and which must therefore exist before any
 * synchronization runs, and a foreign hostname branch holding the held snapshot, which
 * `mergeRemoteHostBranches` imports because it is not the receiver's own branch.
 *
 * @param {object} capabilities - The capabilities of the installation being synchronized,
 *   which own the remote and the branch name.
 * @param {object} sourceDatabase - The held snapshot's database.
 * @returns {Promise<void>}
 */
async function publishHeldSnapshot(capabilities, sourceDatabase) {
    const remotePath = capabilities.environment.generatorsRepository();
    const ownBranch = `${capabilities.environment.hostname()}-main`;
    const sourceBranch = 'source-host-main';
    const workTree = await capabilities.creator.createTemporaryDirectory();
    try {
        await capabilities.git.call("init", "--bare", "--", remotePath);
        await capabilities.git.call("init", "--initial-branch", ownBranch, "--", workTree);
        await capabilities.git.call(
            "-C",
            workTree,
            "-c",
            "user.name=volodyslav",
            "-c",
            "user.email=volodyslav",
            "commit",
            "--quiet",
            "--allow-empty",
            "-m",
            "seed the receiver's own branch"
        );
        await capabilities.git.call("-C", workTree, "remote", "add", "origin", "--", remotePath);
        await capabilities.git.call("-C", workTree, "push", "origin", ownBranch);
        await capabilities.git.call("-C", workTree, "checkout", "--quiet", "-b", sourceBranch);
        await renderToFilesystem(
            capabilities,
            sourceDatabase,
            path.join(workTree, DATABASE_SUBPATH, 'r'),
            sourceDatabase.currentReplicaName()
        );
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
        await capabilities.git.call("-C", workTree, "push", "origin", sourceBranch);
    } finally {
        await capabilities.deleter.deleteDirectory(workTree);
    }
}

/**
 * Record, per durable batch the process issues, which sublevels its operations address.
 *
 * Level normalizes the operations of a sublevel batch before issuing them, so the sublevel
 * an operation belongs to is recovered from the prefixed key the operation carries: every
 * key of the Journal sublevel carries the sublevel's own separator-delimited name.
 *
 * @param {object} capabilities
 * @returns {Array<Array<string>>}
 */
function instrumentBatches(capabilities) {
    /** @type {Array<Array<string>>} */
    const issued = [];
    const initialize = capabilities.levelDatabase.initialize;
    capabilities.levelDatabase.initialize = (databasePath) => {
        const level = initialize(databasePath);
        const batch = level.batch.bind(level);
        level.batch = (operations) => {
            issued.push(operations.map((operation) => String(operation.key)));
            return batch(operations);
        };
        return level;
    };
    return issued;
}

/**
 * The batches which carried both a journal write and a graph write, which is the shape of
 * the one write §Atomicity requires.
 *
 * @param {ReadonlyArray<Array<string>>} issued
 * @returns {Array<Array<string>>}
 */
function graphAndJournalBatches(issued) {
    return issued.filter(
        (keys) =>
            keys.some((key) => key.includes('journal')) &&
            keys.some((key) => key.includes('values') || key.includes('timestamps'))
    );
}

/**
 * The retained journal of one replica namespace.
 *
 * @param {object} db
 * @returns {Promise<Array<object>>}
 */
async function retainedRecordsOf(db) {
    const replica = await readRetainedJournal(db.getSchemaStorage().journal);
    if (replica instanceof Error) {
        throw replica;
    }
    return [...replica.values()].flat();
}

/**
 * The stored graph state of the activated replica, as one row per materialized node.
 *
 * @param {object} db
 * @returns {Promise<Map<string, object>>}
 */
async function storedRowsOf(db) {
    const storage = db.getSchemaStorage();
    /** @type {Map<string, object>} */
    const rows = new Map();
    for await (const identifier of storage.values.keys()) {
        rows.set(db.nodeIdToKey(identifier), {
            payload: await storage.values.get(identifier),
            freshness: await storage.freshness.get(identifier),
            timestamps: await storage.timestamps.get(identifier),
        });
    }
    return rows;
}

/**
 * Synchronize one installation from the held snapshot `publishHeldSnapshot` published.
 *
 * @param {object} capabilities
 * @returns {Promise<void>}
 */
async function syncFromHeldSnapshot(capabilities) {
    await synchronizeNoLock(capabilities, {
        journalSync: syncJournalReceiverToSource,
    });
}

describe('sync exposes Jsync + project(Jsync) in one write', () => {
    test('the receiver retains its own history and exposes exactly what its journal projects to', async () => {
        const receiverCapabilities = capabilitiesFor('retain');
        const receiver = await buildPulledDatabase(receiverCapabilities, 'the receiver wrote this');
        const receiverFingerprint = receiver.getFingerprint();
        const before = await retainedRecordsOf(receiver);
        expect(before.length).toBeGreaterThan(0);
        await receiver.close();

        const sourceCapabilities = capabilitiesFor('retain-source');
        const sourceDatabase = await buildPulledDatabase(sourceCapabilities, 'the held snapshot holds this');
        const sourceFingerprint = sourceDatabase.getFingerprint();
        expect(sourceFingerprint).not.toBe(receiverFingerprint);
        await publishHeldSnapshot(receiverCapabilities, sourceDatabase);
        await sourceDatabase.close();

        const issued = instrumentBatches(receiverCapabilities);
        await syncFromHeldSnapshot(receiverCapabilities);

        const reopened = await getRootDatabase(receiverCapabilities);
        try {
            const records = await retainedRecordsOf(reopened);
            const authors = new Set(records.map((record) => journalAuthorToString(record.id.author)));

            expect(authors.has(receiverFingerprint)).toBe(true);
            expect(authors.has(sourceFingerprint)).toBe(true);

            const localWriter = makeJournalAuthor(receiverFingerprint);
            if (localWriter instanceof Error) {
                throw localWriter;
            }
            const template = makeCurrentInputKeysOfNode(
                parseGraphScheme(
                    await reopened.getSchemaStorage().global.get(GRAPH_SCHEME_KEY)
                )
            );
            const projected = projectRetainedJournal({
                source: makeReplicaSource(
                    await readRetainedJournalOrThrow(reopened)
                ),
                localWriter,
                currentInputKeysOfNode: (nodeKeyString) => template(nodeKeyString) ?? [],
            });
            if (projected instanceof Error) {
                throw projected;
            }

            const stored = await storedRowsOf(reopened);
            const projectedRows = new Map(
                projected.occurrences.map((occurrence) => [
                    occurrence.nodeKeyString,
                    {
                        payload: occurrence.payload,
                        freshness: occurrence.fresh ? 'up-to-date' : 'potentially-outdated',
                        timestamps: {
                            createdAt: occurrence.createdAt,
                            modifiedAt: occurrence.modifiedAt,
                        },
                    },
                ])
            );
            expect([...stored.keys()].sort()).toEqual([...projectedRows.keys()].sort());
            for (const [nodeKey, row] of stored) {
                expect(projectedRows.get(nodeKey)).toEqual(row);
            }

            expect(graphAndJournalBatches(issued)).toHaveLength(1);
        } finally {
            await reopened.close();
        }
    });

    test('a publication which fails leaves the previously activated replica active', async () => {
        const receiverCapabilities = capabilitiesFor('failure');
        const receiver = await buildPulledDatabase(receiverCapabilities, 'the receiver wrote this');
        const receiverReplica = receiver.currentReplicaName();
        const before = await storedRowsOf(receiver);
        await receiver.close();

        const sourceCapabilities = capabilitiesFor('failure-source');
        const sourceDatabase = await buildPulledDatabase(sourceCapabilities, 'the held snapshot holds this');
        await publishHeldSnapshot(receiverCapabilities, sourceDatabase);
        await sourceDatabase.close();

        let syncPhase = false;
        const initialize = receiverCapabilities.levelDatabase.initialize;
        receiverCapabilities.levelDatabase.initialize = (databasePath) => {
            const level = initialize(databasePath);
            const batch = level.batch.bind(level);
            level.batch = (operations) => {
                const keys = operations.map((operation) => String(operation.key));
                if (syncPhase && graphAndJournalBatches([keys]).length > 0) {
                    return Promise.reject(new Error('injected publication failure'));
                }
                return batch(operations);
            };
            return level;
        };

        const originalSync = syncJournalReceiverToSource;
        /** @type {import('../src/generators/incremental_graph/journal_publish').SyncReceiverToSource} */
        const wrappedSync = async (request) => {
            syncPhase = true;
            try {
                return await originalSync(request);
            } finally {
                syncPhase = false;
            }
        };

        await expect(
            synchronizeNoLock(receiverCapabilities, { journalSync: wrappedSync })
        ).rejects.toThrow('injected publication failure');

        const reopened = await getRootDatabase(receiverCapabilities);
        try {
            expect(reopened.currentReplicaName()).toBe(receiverReplica);
            expect(await storedRowsOf(reopened)).toEqual(before);
        } finally {
            await reopened.close();
        }
    });
});

/**
 * @param {object} db
 * @returns {Promise<object>}
 */
async function readRetainedJournalOrThrow(db) {
    const replica = await readRetainedJournal(db.getSchemaStorage().journal);
    if (replica instanceof Error) {
        throw replica;
    }
    return replica;
}
