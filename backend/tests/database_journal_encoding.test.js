/**
 * Tests for the value encoding of the Journal sublevel.
 *
 * The Journal sublevel stores canonical text, not JSON values: a record's stored
 * value is `JSON.stringify(...)` output which the Journal's own readers parse, and
 * an occurrence's stored value is a bare `author:sequence` record id which is not
 * JSON at all. A read or write which crosses the untyped raw accessors of
 * `RootDatabase` therefore has to use the text encoding, and has to keep using the
 * declared encoding of the sublevel the key names.
 *
 * Every test here drives a real `classic-level` database and the real raw
 * accessors. Nothing is mocked: the point of these tests is the bytes that reach
 * the database and the value that comes back out of them.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    getRootDatabase,
    renderToFilesystem,
    scanFromFilesystem,
} = require('../src/generators/incremental_graph/database');
const {
    stringToJournalKey,
    stringToJournalText,
} = require('../src/generators/incremental_graph/database/types');
const { getMockedRootCapabilities } = require('./spies');
const { stubLogger, stubEnvironment } = require('./stubs');

/**
 * @typedef {import('../src/generators/incremental_graph/database/root_database').RootDatabase} RootDatabase
 */

/** The three key families the Journal sublevel holds, in the shapes it stores them. */
const RECORD_KEY = stringToJournalKey('record|qai1|000000000000000000000000000001');
const RECORD_TEXT = stringToJournalText(
    '{"id":"qai1:1","kind":"value","node":"{\\"head\\":\\"all_events\\",\\"args\\":[]}",' +
    '"context":[],"authorityTime":{"physical":1,"logical":"1"},"nodeIdentifier":"all_events",' +
    '"payload":{"type":"all_events","events":[]},"createdAt":1,"modifiedAt":1,"reason":"write"}'
);
const OCCURRENCE_KEY = stringToJournalKey('occurrence|{"head":"all_events","args":[]}');
const OCCURRENCE_TEXT = stringToJournalText('qai1:1');
const STATE_KEY = stringToJournalKey('state');
const STATE_TEXT = stringToJournalText(
    '{"localWriter":"qai1","writerHead":"1","committedFrontier":[["qai1","1"]],' +
    '"authorityHighWater":[1,"1"],"allocatorWatermark":1}'
);

/**
 * @returns {{ capabilities: object, tmpDir: string }}
 */
function makeTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-encoding-test-'));
    stubLogger(capabilities);
    stubEnvironment(capabilities);
    return { capabilities, tmpDir };
}

/**
 * Open a fresh database and write one entry per Journal key family through the
 * typed Journal database, which is the only writer the Journal has.
 * @param {object} capabilities
 * @returns {Promise<RootDatabase>}
 */
async function makeDatabaseWithJournalText(capabilities) {
    const db = await getRootDatabase(capabilities);
    const journal = db.schemaStorageForReplica(db.currentReplicaName()).journal;
    await journal.put(RECORD_KEY, RECORD_TEXT);
    await journal.put(OCCURRENCE_KEY, OCCURRENCE_TEXT);
    await journal.put(STATE_KEY, STATE_TEXT);
    return db;
}

// ---------------------------------------------------------------------------
// Reading through the raw accessors
// ---------------------------------------------------------------------------

describe('reading the Journal sublevel through the raw accessors', () => {
    test('a record read back is its canonical text, not the structure that text describes', async () => {
        const { capabilities } = makeTestCapabilities();
        const db = await makeDatabaseWithJournalText(capabilities);
        try {
            const read = await db._rawGetInSublevel(
                db.currentReplicaName(),
                `!journal!${RECORD_KEY}`
            );
            expect(read).toBe(RECORD_TEXT);
        } finally {
            await db.close();
        }
    });

    test('an occurrence record id read back is the id text, which is not JSON at all', async () => {
        const { capabilities } = makeTestCapabilities();
        const db = await makeDatabaseWithJournalText(capabilities);
        try {
            const read = await db._rawGetInSublevel(
                db.currentReplicaName(),
                `!journal!${OCCURRENCE_KEY}`
            );
            expect(read).toBe(OCCURRENCE_TEXT);
        } finally {
            await db.close();
        }
    });

    test('iterating the replica yields every Journal value as its stored text', async () => {
        const { capabilities } = makeTestCapabilities();
        const db = await makeDatabaseWithJournalText(capabilities);
        try {
            /** @type {Map<string, unknown>} */
            const entries = new Map();
            for await (const [rawKey, value] of db._rawEntriesForSublevel(db.currentReplicaName())) {
                entries.set(rawKey, value);
            }
            expect(entries.get(`!x!!journal!${RECORD_KEY}`)).toBe(RECORD_TEXT);
            expect(entries.get(`!x!!journal!${OCCURRENCE_KEY}`)).toBe(OCCURRENCE_TEXT);
            expect(entries.get(`!x!!journal!${STATE_KEY}`)).toBe(STATE_TEXT);
        } finally {
            await db.close();
        }
    });

    test('the values sublevel of the same replica still reads back as JSON values', async () => {
        const { capabilities } = makeTestCapabilities();
        const db = await makeDatabaseWithJournalText(capabilities);
        try {
            const replica = db.currentReplicaName();
            const storage = db.schemaStorageForReplica(replica);
            await storage.values.put('all_events', { type: 'all_events', events: [] });
            expect(await db._rawGetInSublevel(replica, '!values!all_events')).toEqual({
                type: 'all_events',
                events: [],
            });
        } finally {
            await db.close();
        }
    });
});

// ---------------------------------------------------------------------------
// Writing through the raw accessors
// ---------------------------------------------------------------------------

describe('writing the Journal sublevel through the raw accessors', () => {
    test('a Journal text written raw is read back by the typed Journal database unchanged', async () => {
        const { capabilities } = makeTestCapabilities();
        const db = await getRootDatabase(capabilities);
        try {
            const replica = db.currentReplicaName();
            await db._rawPut(`!${replica}!!journal!${RECORD_KEY}`, RECORD_TEXT);
            const journal = db.schemaStorageForReplica(replica).journal;
            expect(await journal.get(RECORD_KEY)).toBe(RECORD_TEXT);
        } finally {
            await db.close();
        }
    });

    test('a rendered snapshot scanned back yields the same Journal text', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const source = await makeDatabaseWithJournalText(capabilities);
        const renderDir = path.join(tmpDir, 'render', 'x');
        try {
            await renderToFilesystem(capabilities, source, renderDir, source.currentReplicaName());
        } finally {
            await source.close();
        }

        const target = await getRootDatabase(capabilities);
        try {
            await scanFromFilesystem(capabilities, target, renderDir, target.currentReplicaName());
            const journal = target.schemaStorageForReplica(target.currentReplicaName()).journal;
            expect(await journal.get(RECORD_KEY)).toBe(RECORD_TEXT);
            expect(await journal.get(OCCURRENCE_KEY)).toBe(OCCURRENCE_TEXT);
            expect(await journal.get(STATE_KEY)).toBe(STATE_TEXT);
        } finally {
            await target.close();
        }
    });

    test('a value that is not text is refused rather than stored as its string form', async () => {
        const { capabilities } = makeTestCapabilities();
        const db = await getRootDatabase(capabilities);
        try {
            const replica = db.currentReplicaName();
            await expect(
                db._rawPut(`!${replica}!!journal!${RECORD_KEY}`, { id: 'qai1:1' })
            ).rejects.toThrow(/stores values as utf8 text/);
        } finally {
            await db.close();
        }
    });
});