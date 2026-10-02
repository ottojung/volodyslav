/**
 * Reading the held snapshot of an absent-installation restoration.
 *
 * A published snapshot is a rendered filesystem tree, so the Journal an absent
 * restoration replays is a directory of files rather than a sublevel of a live
 * database. This module turns that directory back into the Journal's own storage
 * surface, and reads the identity the replay lowers into, so that
 * `restore_absent` consumes a retained Journal and a schema rather than a
 * snapshot format.
 *
 * ## The rendered projection is not read
 *
 * Only the `journal` sublevel directory and three `global` records are read. A
 * snapshot's `values`, `freshness`, `valid`, `timestamps`, `inputs` and
 * `counters` sublevels are the snapshot's rendered projection, and a Journal
 * replay reconstructs the graph without them.
 */

const path = require('path');

/** @typedef {import('./synchronize').Capabilities} Capabilities */
/** @typedef {import('../journal/errors').AnyJournalError} JournalError */
/** @typedef {import('../journal/emission').CommittedWriterState} CommittedWriterState */
/** @typedef {import('../journal/replica').JournalReplica} JournalReplica */
/** @typedef {import('./types').JournalKey} JournalKey */
/** @typedef {import('./types').JournalText} JournalText */
/** @typedef {import('./graph_scheme').GraphScheme} GraphScheme */
/** @typedef {import('./restore_absent').RestorationJournal} RestorationJournal */


const { DATABASE_SUBPATH } = require('./gitstore');
const { relativePathToKey, parseValue } = require('./render');
const { GRAPH_SCHEME_KEY, deriveInputPositions, parseGraphScheme } = require('./graph_scheme');
const { requireValidFingerprint } = require('./fingerprint');
const {
    journalKeyToString,
    nodeKeyStringToString,
    stringToJournalKey,
    stringToJournalText,
    stringToNodeKeyString,
} = require('./types');
const { AbsentRestoreError } = require('./restore_absent_errors');

/** The snapshot directory which holds the one replica a snapshot renders. */
const RENDERED_REPLICA_DIRECTORY = 'r';

/** The snapshot sublevel which holds the retained Journal. */
const JOURNAL_SUBLEVEL_DIRECTORY = 'journal';

/** The snapshot sublevel which holds the restored identity. */
const GLOBAL_SUBLEVEL_DIRECTORY = 'global';

const FINGERPRINT_KEY = 'fingerprint';
const VERSION_KEY = 'version';

/**
 * The Journal vocabulary an absent-installation restoration reads through.
 *
 * @typedef {object} RestorationJournal
 * @property {(journalDatabase: { get: (key: JournalKey) => Promise<JournalText | undefined> }, fingerprint: string) => Promise<CommittedWriterState | JournalError>} readCommittedWriterState
 * @property {(journalDatabase: { keys: () => AsyncIterable<JournalKey>, get: (key: JournalKey) => Promise<JournalText | undefined> }) => Promise<JournalReplica | JournalError>} readRetainedJournal
 * @property {(retained: JournalReplica) => *} makeReplicaSource
 * @property {(options: { source: *, localWriter: *, currentInputKeysOfNode: (nodeKeyString: string) => ReadonlyArray<string> }) => Projection | JournalError} projectRetainedJournal
 * @property {(retained: JournalReplica) => JournalError | undefined} validateJournalReplica
 * @property {(record: JournalRecord) => string} encodeJournalRecord
 * @property {(id: import('../journal/types').JournalRecordId) => string} journalRecordIdToString
 * @property {(author: import('../journal/types').JournalAuthor, sequence: import('../journal/types').JournalSequence) => JournalKey | JournalError} makeJournalRecordKey
 * @property {(nodeKey: import('./node_key').NodeKey) => JournalKey} makeJournalOccurrenceKey
 * @property {(state: CommittedWriterState) => object} serializeWriterState
 */

/**
 * The raw-key prefix every Journal key of a rendered snapshot shares.
 *
 * @returns {string}
 */
function rawJournalKeyPrefix() {
    return (
        '!' +
        [RENDERED_REPLICA_DIRECTORY, JOURNAL_SUBLEVEL_DIRECTORY].join('!!') +
        '!'
    );
}

/**
 * The held snapshot's directory which holds the one replica a snapshot renders.
 *
 * @param {string} workTree
 * @returns {string}
 */
function snapshotReplicaDirectoryOf(workTree) {
    return path.join(workTree, DATABASE_SUBPATH, RENDERED_REPLICA_DIRECTORY);
}

/**
 * The Journal sublevel of the held snapshot, read as the Journal's own storage
 * surface.
 *
 * `readRetainedJournal` and `readCommittedWriterState` consume a Journal by its
 * keys and its values, so presenting the snapshot's `journal` directory through
 * that surface lets the replay read exactly what a retained Journal is, rather
 * than a snapshot-specific reading of it.
 *
 * The properties this value carries are:
 * - `keys()` enumerates every Journal key the snapshot holds, in ascending
 *   canonical order;
 * - `get(key)` returns the snapshot's stored value for that key, or `undefined`
 *   for a key the snapshot does not hold.
 *
 * The proof of those properties is guaranteed by:
 * - `openRenderedJournal(...)`: it reads the directory once, maps every file
 *   name back to the Journal key the snapshot's key encoding wrote it from, and
 *   answers from that map, so a key is enumerated exactly when a file for it
 *   exists.
 *
 * @param {Capabilities} capabilities
 * @param {string} journalDirectory
 * @returns {Promise<{ keys: () => AsyncIterable<JournalKey>, get: (key: JournalKey) => Promise<JournalText | undefined> }>}
 * @throws {AbsentRestoreError} When the snapshot holds no Journal directory.
 */
async function openRenderedJournal(capabilities, journalDirectory) {
    if (await capabilities.checker.directoryExists(journalDirectory) === null) {
        throw new AbsentRestoreError(
            'the snapshot holds no retained Journal',
            journalDirectory
        );
    }
    const members = await capabilities.scanner.scanDirectory(journalDirectory);
    /** @type {Map<string, { key: JournalKey, filePath: string }>} */
    const entries = new Map();
    for (const member of members) {
        if (await capabilities.checker.fileExists(member.path) === null) {
            continue;
        }
        const rawKey = relativePathToKey(
            RENDERED_REPLICA_DIRECTORY + '/' + JOURNAL_SUBLEVEL_DIRECTORY +
            '/' + path.basename(member.path)
        );
        const key = stringToJournalKey(rawKey.slice(rawJournalKeyPrefix().length));
        if (key instanceof Error) {
            throw new AbsentRestoreError(
                'the snapshot holds an unreadable Journal key: ' + key.message,
                member.path
            );
        }
        entries.set(journalKeyToString(key), { key, filePath: member.path });
    }
    const ordered = [...entries.values()].sort((left, right) =>
        journalKeyToString(left.key) < journalKeyToString(right.key) ? -1 : 1
    );
    return {
        keys: async function * () {
            for (const entry of ordered) {
                yield entry.key;
            }
        },
        get: async (key) => {
            const entry = entries.get(journalKeyToString(key));
            if (entry === undefined) {
                return undefined;
            }
            const stored = parseValue(
                await capabilities.reader.readFileAsText(entry.filePath)
            );
            if (typeof stored !== 'string') {
                throw new AbsentRestoreError(
                    'the snapshot stores a non-text Journal value',
                    entry.filePath
                );
            }
            return stringToJournalText(stored);
        },
    };
}

/**
 * Read one key of the held snapshot's global sublevel.
 *
 * @param {Capabilities} capabilities
 * @param {string} replicaDirectory
 * @param {string} key
 * @returns {Promise<unknown>}
 * @throws {AbsentRestoreError} When the snapshot holds no such global record.
 */
async function readSnapshotGlobal(capabilities, replicaDirectory, key) {
    const filePath = path.join(replicaDirectory, GLOBAL_SUBLEVEL_DIRECTORY, key);
    if (await capabilities.checker.fileExists(filePath) === null) {
        throw new AbsentRestoreError(
            'the snapshot holds no ' + key + ' record',
            filePath
        );
    }
    return parseValue(await capabilities.reader.readFileAsText(filePath));
}

/**
 * The current schema's direct inputs of one semantic node.
 *
 * A node the restored schema does not contain has no current direct inputs,
 * which is what a historical node family absent from the schema projects as.
 *
 * @param {import('./graph_scheme').GraphScheme} graphScheme
 * @returns {(nodeKeyString: string) => ReadonlyArray<string>}
 */
function makeCurrentInputKeysOfNode(graphScheme) {
    return (nodeKeyString) => {
        try {
            return deriveInputPositions(
                graphScheme,
                stringToNodeKeyString(nodeKeyString)
            ).map(nodeKeyStringToString);
        } catch {
            return [];
        }
    };
}

/**
 * @param {JournalReplica} retained
 * @returns {ReadonlyArray<JournalRecord>}
 */
function retainedRecordsOf(retained) {
    /** @type {Array<JournalRecord>} */
    const records = [];
    for (const stream of retained.values()) {
        records.push(...stream);
    }
    return records;
}


/**
 * The properties that this value carries is:
 * - `committed` is the held snapshot's own committed writer state, so the
 *   restored database adopts the snapshot's local writer rather than a new one;
 * - `retained` is exactly the history the snapshot retains, so nothing is added
 *   to and nothing is dropped from what the continuation-safe head published.
 *
 * The proof of those properties is guaranteed by:
 * - `readHeldSnapshot(...)`: it reads both through the Journal's own readers
 *   over the presented snapshot journal, so neither is filtered, reordered or
 *   repaired here.
 *
 * @typedef {object} HeldSnapshot
 * @property {string} version
 * @property {string} fingerprint
 * @property {GraphScheme} graphScheme
 * @property {CommittedWriterState} committed
 * @property {JournalReplica} retained
 */

/**
 * Read the held snapshot's retained Journal and the identity the replay lowers
 * into.
 *
 * @param {Capabilities} capabilities
 * @param {string} workTree
 * @param {RestorationJournal} journal
 * @returns {Promise<HeldSnapshot>}
 * @throws {AbsentRestoreError} When the snapshot cannot be read as a Journal.
 */
async function readHeldSnapshot(capabilities, workTree, journal) {
    const replicaDirectory = snapshotReplicaDirectoryOf(workTree);

    /** @type {unknown} */
    const rawVersion = await readSnapshotGlobal(capabilities, replicaDirectory, VERSION_KEY);
    if (typeof rawVersion !== 'string') {
        throw new AbsentRestoreError(
            'the snapshot version is not a string',
            replicaDirectory
        );
    }
    const fingerprint = requireValidFingerprint(
        await readSnapshotGlobal(capabilities, replicaDirectory, FINGERPRINT_KEY),
        'the held snapshot being restored'
    );
    const graphScheme = parseGraphScheme(
        await readSnapshotGlobal(capabilities, replicaDirectory, GRAPH_SCHEME_KEY),
        'the held snapshot being restored'
    );

    const snapshotJournal = await openRenderedJournal(
        capabilities,
        path.join(replicaDirectory, JOURNAL_SUBLEVEL_DIRECTORY)
    );

    /** @type {CommittedWriterState | JournalError} */
    const committed = await journal.readCommittedWriterState(snapshotJournal, fingerprint);
    if (committed instanceof Error) {
        throw new AbsentRestoreError(
            'the snapshot journal state could not be read: ' + committed.message,
            replicaDirectory
        );
    }

    /** @type {JournalReplica | JournalError} */
    const retained = await journal.readRetainedJournal(snapshotJournal);
    if (retained instanceof Error) {
        throw new AbsentRestoreError(
            'the snapshot retained history could not be read: ' + retained.message,
            replicaDirectory
        );
    }

    const malformed = journal.validateJournalReplica(retained);
    if (malformed !== undefined) {
        throw new AbsentRestoreError(
            'the snapshot retained history is not well formed: ' + malformed.message,
            replicaDirectory
        );
    }

    return { version: rawVersion, fingerprint, graphScheme, committed, retained };
}

module.exports = {
    makeCurrentInputKeysOfNode,
    readHeldSnapshot,
    retainedRecordsOf,
};
