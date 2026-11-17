/**
 * The shipped reset entry point wires the Journal reset for a Journal receiver.
 *
 * `incremental-graph-journal-reset.md` §Semantic API exposes a reset of a receiver to a
 * known-good source projection, and `incremental-graph-journal-storage.md` §Committed-pair
 * metadata makes the reset of a receiver which retains records a Journal operation rather
 * than a fieldwise adoption of the snapshot's rows. The shipped entry point therefore owes
 * the reset its Journal front exactly as an ordinary synchronization owes its Journal
 * synchronization.
 *
 * This test drives the shipped path — `Interface.synchronizeDatabase` with
 * `resetToHostname` — against a receiver whose records were published by the production
 * `pull`, over a real checkpoint repository. Before the wiring it stops with
 * `JournalResetFrontMissingError`; after it the receiver retains both writers and exposes
 * `Jreset + project(Jreset)`.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const { makeInterface } = require("../src/generators/interface");
const {
    DATABASE_SUBPATH,
    getRootDatabase,
    renderToFilesystem,
} = require("../src/generators/incremental_graph/database");
const { createIncrementalGraph } = require("../src/generators/incremental_graph");
const { readRetainedJournal } = require("../src/generators/incremental_graph/journal_store");
const { journalAuthorToString } = require("../src/generators/incremental_graph/journal");

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
 * @returns {Promise<object>}
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
    fs.mkdtempSync(path.join(os.tmpdir(), `journal-reset-shipped-${label}-`));
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

describe('the shipped reset entry point resets a Journal receiver through the Journal', () => {
    test('Interface.synchronizeDatabase({resetToHostname}) retains Jreset and its projection', async () => {
        const receiverCapabilities = capabilitiesFor('wiring');
        const receiver = await buildPulledDatabase(receiverCapabilities, 'the receiver wrote this');
        const receiverFingerprint = receiver.getFingerprint();
        const before = await retainedRecordsOf(receiver);
        expect(before.length).toBeGreaterThan(0);
        await receiver.close();

        const sourceCapabilities = capabilitiesFor('wiring-source');
        const sourceDatabase = await buildPulledDatabase(sourceCapabilities, 'the held snapshot holds this');
        const sourceFingerprint = sourceDatabase.getFingerprint();
        expect(sourceFingerprint).not.toBe(receiverFingerprint);
        await publishHeldSnapshot(receiverCapabilities, sourceDatabase);
        await sourceDatabase.close();

        const iface = makeInterface(() => receiverCapabilities);
        await iface.synchronizeDatabase({
            resetToHostname: receiverCapabilities.environment.hostname(),
        });

        const reopened = await getRootDatabase(receiverCapabilities);
        try {
            const records = await retainedRecordsOf(reopened);
            const authors = new Set(records.map((record) => journalAuthorToString(record.id.author)));
            expect(authors.has(receiverFingerprint)).toBe(true);
            expect(authors.has(sourceFingerprint)).toBe(true);
        } finally {
            await reopened.close();
        }
    });
});
