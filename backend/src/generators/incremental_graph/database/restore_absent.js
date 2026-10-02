/**
 * The Journal-level receiver-less restoration of a completely absent
 * installation.
 *
 * `docs/specs/incremental-graph-journal-api.md` §Receiver-less absent restore
 * gives `restoreAbsentFrom(source)` one job: adopt the source's local writer,
 * retain its history unchanged, and reconstruct the materialized graph, the
 * allocator watermark and the authority high-water by *replaying those
 * records*. This module is that body.
 *
 * ## What is read from the held snapshot
 *
 * Only the snapshot's `journal` sublevel and the identity in its `global`
 * sublevel. The snapshot's rendered projection — its `values`, `freshness`,
 * `valid`, `timestamps`, `inputs` and `counters` sublevels — is not an input at
 * all, so a continuation-safe snapshot whose rendered projection is absent is
 * restored exactly like one which carries it. This is what distinguishes a
 * Journal-level restoration from importing a rendered snapshot.
 *
 * The identity which is read is the snapshot's version, graph scheme and
 * fingerprint: the graph scheme is the schema the replay lowers into, and the
 * fingerprint is the continuing installation identity the snapshot supplies.
 * Everything else is derived rather than copied — `last_node_index` is the
 * projection's reconstructed watermark of the local writer's retained prefix,
 * and `identifiers_keys_map` is the projection's own bijective occurrence
 * mapping.
 *
 * ## No semantic event is authored
 *
 * Restoration appends no record. The retained history it writes is exactly the
 * history it read, so the restored database authors no coordinate merely for
 * having been restored.
 *
 * ## Materializing a fresh replica
 *
 * The target of a restoration is a replica which holds nothing, which is not the
 * situation a synchronization publication lowers into: that one replaces an
 * existing projection and therefore has to delete the occurrences the new
 * projection no longer names. Here every key is written and there is nothing to
 * delete, so this module writes the projection's own keys and leaves the
 * absence of the rest to mean emptiness.
 *
 * ## Why the Journal arrives as a parameter
 *
 * Every Journal module reaches this folder's index for the shared key and value
 * vocabulary. A `database/` module which required one of them directly would be
 * required while that index is still initialising, and would observe a
 * half-built export object. The Journal therefore arrives as `journal`, which
 * the caller composes once its own module graph has finished loading.
 */

/** @typedef {import('./synchronize').Capabilities} Capabilities */
/** @typedef {import('./root_database').RootDatabase} RootDatabase */
/** @typedef {import('./root_database').SchemaStorage} SchemaStorage */
/** @typedef {import('../journal/errors').AnyJournalError} JournalError */
/** @typedef {import('../journal/records').JournalRecord} JournalRecord */
/** @typedef {import('../journal/emission').CommittedWriterState} CommittedWriterState */
/** @typedef {import('../journal/replica').JournalReplica} JournalReplica */
/** @typedef {import('./types').JournalKey} JournalKey */
/** @typedef {import('./types').JournalText} JournalText */
/** @typedef {import('./types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('../journal/oracle/projection').Projection} Projection */

const { makeRootDatabase, LAST_NODE_INDEX_KEY } = require('./root_database');
const {
    IDENTIFIERS_KEY,
    makeIdentifierLookup,
    serializeIdentifierLookup,
} = require('./identifier_lookup');
const { compareNodeIdentifier, nodeIdentifierToString } = require('./node_identifier');
const { GRAPH_SCHEME_KEY } = require('./graph_scheme');
const { AbsentRestoreError } = require('./restore_absent_errors');
const {
    makeCurrentInputKeysOfNode,
    readHeldSnapshot,
    retainedRecordsOf,
} = require('./restore_absent_snapshot');
const {
    stringToJournalKey,
    stringToJournalText,
    stringToNodeKeyString,
} = require('./types');

/**
 * The `identifiers_keys_map` the projection implies.
 *
 * The mapping is built through `makeIdentifierLookup` rather than serialised
 * directly, so a projection which maps two canonical node keys onto one physical
 * identifier is rejected here rather than becoming a persisted lookup whose
 * bijectivity no later reader could rely on.
 *
 * @param {RestorationJournal} journal
 * @param {ReadonlyArray<import('../journal/oracle/projection').ProjectedOccurrence>} occurrences
 * @returns {Array<[NodeIdentifier, import('./types').NodeKeyString]>}
 * @throws {AbsentRestoreError} When the projection's mapping is not bijective.
 */
function identifiersMapOf(journal, occurrences) {
    const lookup = makeIdentifierLookup(
        occurrences.map((occurrence) => [
            occurrence.nodeIdentifier,
            stringToNodeKeyString(occurrence.nodeKeyString),
        ])
    );
    if (lookup instanceof Error) {
        throw new AbsentRestoreError(
            'the replayed occurrences do not induce a bijective identifier mapping: ' +
            lookup.message,
            'identifiers_keys_map'
        );
    }
    return serializeIdentifierLookup(lookup);
}

/**
 * The inverted validity map the projection implies: each dependency's
 * identifier mapped to the identifiers of the dependents whose incoming edge it
 * proves.
 *
 * `edgeValid` requires both endpoints to be present, so a dependency the
 * projection does not contain cannot be named by a present occurrence.
 *
 * @param {ReadonlyArray<import('../journal/oracle/projection').ProjectedOccurrence>} occurrences
 * @returns {Map<string, NodeIdentifier[]>}
 */
function invertedValidityOf(occurrences) {
    /** @type {Map<string, import('../journal/oracle/projection').ProjectedOccurrence>} */
    const byNodeKeyString = new Map();
    for (const occurrence of occurrences) {
        byNodeKeyString.set(occurrence.nodeKeyString, occurrence);
    }
    /** @type {Map<string, NodeIdentifier[]>} */
    const inverted = new Map();
    for (const occurrence of occurrences) {
        for (const inputKeyString of occurrence.validInputs) {
            const dependency = byNodeKeyString.get(inputKeyString);
            if (dependency === undefined) {
                continue;
            }
            const key = nodeIdentifierToString(dependency.nodeIdentifier);
            const dependents = inverted.get(key);
            if (dependents === undefined) {
                inverted.set(key, [occurrence.nodeIdentifier]);
                continue;
            }
            dependents.push(occurrence.nodeIdentifier);
        }
    }
    for (const dependents of inverted.values()) {
        dependents.sort(compareNodeIdentifier);
    }
    return inverted;
}

/**
 * @typedef {object} RestoredReplicaContent
 * @property {RestorationJournal} journal
 * @property {ReadonlyArray<JournalRecord>} records
 * @property {CommittedWriterState} committed
 * @property {Projection} projection
 * @property {string} fingerprint
 * @property {string} version
 * @property {import('./graph_scheme').GraphScheme} graphScheme
 */

/**
 * Every write which makes the restored replica current, as one batch.
 *
 * @param {SchemaStorage} target
 * @param {RestoredReplicaContent} content
 * @returns {Promise<Array<*>>}
 */
async function planRestoredReplica(target, content) {
    const { journal, projection } = content;
    const occurrences = projection.occurrences;

    /** @type {Map<string, NodeIdentifier>} */
    const presentIdentifiers = new Map();
    for (const occurrence of occurrences) {
        presentIdentifiers.set(
            nodeIdentifierToString(occurrence.nodeIdentifier),
            occurrence.nodeIdentifier
        );
    }

    /** @type {Array<*>} */
    const operations = [];
    for (const occurrence of occurrences) {
        operations.push(target.values.putOp(occurrence.nodeIdentifier, occurrence.payload));
        operations.push(
            target.freshness.putOp(
                occurrence.nodeIdentifier,
                occurrence.fresh ? 'up-to-date' : 'potentially-outdated'
            )
        );
        operations.push(
            target.timestamps.putOp(occurrence.nodeIdentifier, {
                createdAt: occurrence.createdAt,
                modifiedAt: occurrence.modifiedAt,
            })
        );
        operations.push(
            target.journal.putOp(
                journal.makeJournalOccurrenceKey(occurrence.nodeKey),
                stringToJournalText(journal.journalRecordIdToString(occurrence.valueId))
            )
        );
    }
    for (const [dependency, dependents] of invertedValidityOf(occurrences)) {
        const identifier = presentIdentifiers.get(dependency);
        if (identifier !== undefined) {
            operations.push(target.valid.putOp(identifier, dependents));
        }
    }

    operations.push(
        target.global.putOp(IDENTIFIERS_KEY, identifiersMapOf(journal, occurrences)),
        target.global.putOp(LAST_NODE_INDEX_KEY, projection.lastNodeIndex),
        target.global.putOp(VERSION_KEY, content.version),
        target.global.putOp(GRAPH_SCHEME_KEY, JSON.stringify(content.graphScheme)),
        target.global.putOp(FINGERPRINT_KEY, content.fingerprint)
    );

    for (const record of content.records) {
        const key = journal.makeJournalRecordKey(record.id.author, record.id.sequence);
        if (key instanceof Error) {
            throw new AbsentRestoreError(
                'the retained history holds an unstorable record: ' + key.message,
                'journal'
            );
        }
        operations.push(
            target.journal.putOp(key, stringToJournalText(journal.encodeJournalRecord(record)))
        );
    }
    operations.push(
        target.journal.putOp(
            JOURNAL_STATE_KEY,
            stringToJournalText(JSON.stringify(journal.serializeWriterState(content.committed)))
        )
    );
    return operations;
}

/**
 * The one key the Journal's committed-pair metadata occupies.
 */
const JOURNAL_STATE_KEY = stringToJournalKey('state');

const FINGERPRINT_KEY = 'fingerprint';
const VERSION_KEY = 'version';

/**
 * Publish the restored replica into the absent installation's live database and
 * select it.
 *
 * The batch, the pointer switch and the close happen together, so the live
 * database never exposes a graph which disagrees with the retained history it
 * was restored from.
 *
 * @param {Capabilities} capabilities
 * @param {string} liveDatabasePath
 * @param {RestoredReplicaContent} content
 * @returns {Promise<void>}
 */
async function materializeRestoredReplica(capabilities, liveDatabasePath, content) {
    /** @type {RootDatabase} */
    let database = await makeRootDatabase(capabilities, liveDatabasePath);
    try {
        const targetReplica = database.otherReplicaName();
        /** @type {SchemaStorage} */
        const target = database.schemaStorageForReplica(targetReplica);
        await target.batch(await planRestoredReplica(target, content));
        await database.setCurrentReplicaPointer(targetReplica);
    } finally {
        await database.close();
    }
}

/**
 * @typedef {object} AbsentRestoreRequest
 * @property {string} workTree - The held snapshot's work tree.
 * @property {string} liveDatabasePath - The absent installation's live database
 *   directory, which restoration creates.
 * @property {RestorationJournal} journal - The Journal vocabulary to read the
 *   held snapshot through.
 */

/**
 * Restore a completely absent installation from the held snapshot's retained
 * Journal.
 *
 * @param {Capabilities} capabilities
 * @param {AbsentRestoreRequest} request
 * @returns {Promise<void>}
 * @throws {AbsentRestoreError} When the held snapshot cannot be restored from.
 */
async function restoreAbsentFrom(capabilities, request) {
    const { journal } = request;
    const snapshot = await readHeldSnapshot(capabilities, request.workTree, journal);

    /** @type {Projection | JournalError} */
    const projection = journal.projectRetainedJournal({
        source: journal.makeReplicaSource(snapshot.retained),
        localWriter: snapshot.committed.localWriter,
        currentInputKeysOfNode: makeCurrentInputKeysOfNode(snapshot.graphScheme),
    });
    if (projection instanceof Error) {
        throw new AbsentRestoreError(
            'the snapshot retained history does not replay: ' + projection.message,
            request.workTree
        );
    }

    await materializeRestoredReplica(capabilities, request.liveDatabasePath, {
        journal,
        records: retainedRecordsOf(snapshot.retained),
        committed: snapshot.committed,
        projection,
        fingerprint: snapshot.fingerprint,
        version: snapshot.version,
        graphScheme: snapshot.graphScheme,
    });
}

module.exports = {
    restoreAbsentFrom,
};