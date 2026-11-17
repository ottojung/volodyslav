/**
 * `incremental-graph-journal-testing.md` §Synchronization staging contains no transport locator.
 *
 * `incremental-graph-journal-checklist.md` §9 requires that Journal 3 synchronization staging
 * use persisted sublevel names and keys containing no hostname or other transport locator,
 * per `$id-4373538486707762`. The hostname-keyed `_h_<hostname>` surface is deleted; staging
 * writes into the single fixed `sync_staging` namespace instead, and the production Journal
 * synchronization publishes into the fixed inactive-replica namespace.
 *
 * This regression runs the production pairwise synchronization with the configured hostname
 * `test-host-xyz`, writes representative entries through the staging storage, and enumerates
 * the persisted surface. It requires that no implementation-owned staging sublevel name or key
 * contains the hostname string or the `_h_` prefix. Application-defined NodeKeys and payloads
 * are excluded: the assertions only inspect raw LevelDB keys (sublevel names and key families),
 * never decoded application values.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const {
    getRootDatabase,
    renderToFilesystem,
    scanFromFilesystem,
    stringToJournalText,
} = require("../src/generators/incremental_graph/database");
const {
    SYNC_STAGING_PERSISTED_NAMES,
    SYNC_STAGING_SUBLEVEL_NAME,
} = require("../src/generators/incremental_graph/database/sync_staging");
const {
    makeJournalAuthor,
    makeJournalSequence,
} = require("../src/generators/incremental_graph/journal");
const {
    makeJournalRecordKey,
} = require("../src/generators/incremental_graph/journal_store");
const {
    createIncrementalGraph,
    syncJournalReceiverToSource,
} = require("../src/generators/incremental_graph");

const allEventsModule = require("../src/generators/individual/all_events/wrapper");
const metaEventsComputor = require("../src/generators/individual/meta_events/wrapper").computor;
const eventContextComputor = require("../src/generators/individual/event_context/wrapper").computor;

const eventId = require("../src/event/id");
const { fromISOString } = require("../src/datetime");
const { getMockedRootCapabilities } = require("./spies");
const { stubDatetime, stubEnvironment, stubLogger } = require("./stubs");

jest.setTimeout(120000);

const HOSTNAME = "test-host-xyz";

const CREATOR = {
    name: "tester",
    uuid: "0f6c1a1e-0000-4000-8000-000000000000",
    version: "1.0.0",
    hostname: "host.example",
};

/**
 * Whether a persisted key carries a transport locator: the configured hostname
 * or the retired `_h_` hostname-keyed staging prefix.
 *
 * @param {string} text
 * @returns {boolean}
 */
function containsTransportLocator(text) {
    return text.includes(HOSTNAME) || text.includes("_h_");
}

/**
 * Require a non-empty key collection to be free of transport locators. The
 * non-emptiness requirement is what keeps the regression from passing vacuously
 * on an operation which staged nothing.
 *
 * @param {Array<string>} keys
 */
function assertKeysCarryNoTransportLocator(keys) {
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
        expect(containsTransportLocator(key)).toBe(false);
    }
}

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

function testCapabilities() {
    fs.mkdtempSync(path.join(os.tmpdir(), "journal-sync-no-locator-"));
    const capabilities = getMockedRootCapabilities();
    stubLogger(capabilities);
    stubEnvironment(capabilities);
    stubDatetime(capabilities);
    capabilities.environment.hostname.mockReturnValue(HOSTNAME);
    capabilities.environment.analyzerHostname.mockReturnValue(HOSTNAME);
    return capabilities;
}

function interceptLevel(capabilities) {
    let level;
    const initialize = capabilities.levelDatabase.initialize;
    capabilities.levelDatabase.initialize = (databasePath) => {
        level = initialize(databasePath);
        return level;
    };
    return () => {
        if (level === undefined) {
            throw new Error("the database has not opened a LevelDB instance yet");
        }
        return level;
    };
}

async function buildReceiverWithHeldSnapshot(capabilities) {
    const database = await getRootDatabase(capabilities);
    const graph = await makeRealGraph(capabilities, database, "the receiver wrote this");
    await graph.pull("event_context");

    const receiver = database.currentReplicaName();
    const source = database.otherReplicaName();
    const workTree = await capabilities.creator.createTemporaryDirectory();
    try {
        const replicaDirectory = path.join(workTree, "r");
        await renderToFilesystem(capabilities, database, replicaDirectory, receiver);
        await scanFromFilesystem(capabilities, database, replicaDirectory, source);
    } finally {
        await capabilities.deleter.deleteDirectory(workTree);
    }
    return { database, receiver, source };
}

describe("synchronization staging contains no transport locator", () => {
    test("the locator detector rejects the retired hostname-keyed shape", () => {
        expect(containsTransportLocator(`!_h_${HOSTNAME}!values!k`)).toBe(true);
        expect(containsTransportLocator(`!x!values!${HOSTNAME}`)).toBe(true);
        expect(containsTransportLocator("!sync_staging!!journal!record|abc|00001")).toBe(false);
        expect(containsTransportLocator("!x!!journal!state")).toBe(false);
    });

    test("exported staging names carry no hostname or _h_ prefix", () => {
        expect(SYNC_STAGING_PERSISTED_NAMES.length).toBeGreaterThan(0);
        expect(SYNC_STAGING_PERSISTED_NAMES).toContain(SYNC_STAGING_SUBLEVEL_NAME);
        expect(SYNC_STAGING_SUBLEVEL_NAME).toBe("sync_staging");
        assertKeysCarryNoTransportLocator([...SYNC_STAGING_PERSISTED_NAMES]);
    });

    test("every raw key written by the production sync carries no hostname or _h_ prefix", async () => {
        const capabilities = testCapabilities();
        const levelOf = interceptLevel(capabilities);
        const { database, receiver, source } = await buildReceiverWithHeldSnapshot(capabilities);
        const level = levelOf();
        /** @type {Array<string>} */
        const writtenKeys = [];
        const originalBatch = level.batch.bind(level);
        level.batch = (operations, ...rest) => {
            for (const operation of operations) {
                writtenKeys.push(String(operation.key));
            }
            return originalBatch(operations, ...rest);
        };
        try {
            const changed = await syncJournalReceiverToSource({
                database,
                capabilities,
                receiver,
                source,
            });
            expect(changed).toBe(true);
            assertKeysCarryNoTransportLocator(writtenKeys);
        } finally {
            await database.close();
        }
    });

    test("staging storage writes persist under locator-free keys", async () => {
        const capabilities = testCapabilities();
        const database = await getRootDatabase(capabilities);
        try {
            const author = makeJournalAuthor(database.getFingerprint());
            expect(author instanceof Error).toBe(false);
            if (author instanceof Error) {
                return;
            }
            const sequence = makeJournalSequence("1");
            expect(sequence instanceof Error).toBe(false);
            if (sequence instanceof Error) {
                return;
            }
            const recordKey = makeJournalRecordKey(author, sequence);
            expect(recordKey instanceof Error).toBe(false);
            if (recordKey instanceof Error) {
                return;
            }

            const staging = database.syncStagingStorage();
            await staging.journal.put(recordKey, stringToJournalText('{"kind":"staged"}'));
            await staging.values.put("staged-node", { staged: true });
            await staging.global.put("version", "3");

            /** @type {Array<string>} */
            const stagedKeys = [];
            for await (const [key] of database._rawEntriesForSublevel(SYNC_STAGING_SUBLEVEL_NAME)) {
                stagedKeys.push(String(key));
            }
            assertKeysCarryNoTransportLocator(stagedKeys);

            /** @type {Array<string>} */
            const rawKeys = [];
            for await (const [key] of database._rawEntries()) {
                const text = String(key);
                if (text.includes(SYNC_STAGING_SUBLEVEL_NAME)) {
                    rawKeys.push(text);
                }
            }
            assertKeysCarryNoTransportLocator(rawKeys);
        } finally {
            await database.close();
        }
    });

    test("no _h_-prefixed or hostname-carrying key remains after production sync cutover", async () => {
        const capabilities = testCapabilities();
        const { database, receiver, source } = await buildReceiverWithHeldSnapshot(capabilities);
        try {
            const changed = await syncJournalReceiverToSource({
                database,
                capabilities,
                receiver,
                source,
            });
            expect(changed).toBe(true);
            /** @type {Array<string>} */
            const rawKeys = [];
            for await (const [key] of database._rawEntries()) {
                rawKeys.push(String(key));
            }
            assertKeysCarryNoTransportLocator(rawKeys);
        } finally {
            await database.close();
        }
    });
});
