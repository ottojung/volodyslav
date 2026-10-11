/**
 * Resetting a Journal 3 receiver to the snapshot a filesystem checkpoint carries.
 *
 * `incremental-graph-journal-reset.md` §Reset is the controlled transition away from a
 * receiver's own retained journal and towards a requested source state: the observed
 * history is retained, the missing source history is imported, and only the
 * receiver-authored semantic records which make the receiver's projection
 * observationally equal to the requested source projection are appended. This module is
 * that transition for a receiver reached through the reset lifecycle. It reads the
 * receiver's retained journal and the held snapshot as the two sources `resetToSource`
 * targets, and hands the outcome to the one publication write which exposes it.
 *
 * The operation it exports is handed to the reset lifecycle by the caller which owns a
 * reset, because the `database` barrel and the Journal barrel require each other and the
 * module graph which reaches both from inside the database barrel would read a half-built
 * module in whichever direction the process happened to load first.
 */

const {
    GRAPH_SCHEME_KEY,
    parseGraphScheme,
    requireValidFingerprint,
} = require('../database');
const { readHeldResetSource } = require('./held_reset_source');
const { installResetOutcome } = require('./reset_publication');
const {
    compareAuthorityTime,
    isJournalError,
    isSemanticEvent,
    makeJournalAuthor,
    makeReplicaSource,
} = require('../journal');
const { buildRetainedReplayState, resetToSource } = require('../journal_reset');
const { SnapshotIdentityClass } = require('../journal_sync');
const { makeCurrentInputKeysOfNode } = require('../journal_bootstrap_startup');
const { readCommittedWriterState, readRetainedJournal } = require('../journal_store');

/** @typedef {import('../database/synchronize').Capabilities} Capabilities */
/** @typedef {import('../database/root_database').RootDatabase} RootDatabase */
/** @typedef {import('../database/root_database').SchemaStorage} SchemaStorage */
/** @typedef {import('../database/root_database').ReplicaName} ReplicaName */
/** @typedef {import('../journal/records').JournalRecord} JournalRecord */
/** @typedef {import('../journal/emission').CommittedWriterState} CommittedWriterState */
/** @typedef {import('../journal/types').AuthorityTime} AuthorityTime */
/** @typedef {import('../journal/oracle/record_source').JournalSource} JournalSource */

/**
 * @param {{ keys: () => AsyncIterable<unknown> }} sublevel
 * @returns {Promise<boolean>}
 */
async function hasAnyKey(sublevel) {
    for await (const _key of sublevel.keys()) {
        return true;
    }
    return false;
}

/**
 * Thrown when a receiver which retains Journal records is asked to reset from a
 * filesystem snapshot which retains none.
 *
 * `incremental-graph-journal-reset.md` §Preconditions requires "one stable causally
 * closed source snapshot" and §Source target requires the source's own retained journal
 * to import records from. A pre-Journal checkpoint materializes rows and retains no
 * record, so there is no `S` for reset to target, and adopting the rows would be the
 * pre-Journal canonical-bootstrap join which §Reset is not pre-Journal bootstrap merge
 * forbids reset from being. Restoring such an installation is the absent-state
 * restoration lifecycle of `database-lifecycle.md`, not a reset.
 */
class ResetSourceIsNotAJournalSnapshotError extends Error {
    /**
     * @param {string} fingerprint
     */
    constructor(fingerprint) {
        super(
            `Cannot reset a Journal receiver to snapshot ${fingerprint}: the snapshot retains no ` +
                'Journal records, so it is a pre-Journal checkpoint and not a Journal 3 source snapshot'
        );
        this.name = 'ResetSourceIsNotAJournalSnapshotError';
        this.fingerprint = fingerprint;
    }
}

/**
 * @param {unknown} object
 * @returns {object is ResetSourceIsNotAJournalSnapshotError}
 */
function isResetSourceIsNotAJournalSnapshotError(object) {
    return object instanceof ResetSourceIsNotAJournalSnapshotError;
}

/**
 * Whether a replica namespace retains Journal records at all.
 *
 * A namespace which retains none materializes rows without retaining the records which
 * explain them, so it is a pre-Journal replica rather than a Journal 3 one.
 *
 * @param {SchemaStorage} storage
 * @returns {Promise<boolean>}
 */
async function retainsJournalRecords(storage) {
    return await hasAnyKey(storage.journal);
}

/**
 * @param {unknown} value
 * @param {string} what
 * @returns {string}
 */
function requireText(value, what) {
    if (typeof value !== 'string') {
        throw new Error(`reset requires the receiver's persisted ${what}, which is not a string`);
    }
    return value;
}

/**
 * The greatest authority time the observed union `J0` carries.
 *
 * The receiver's own committed high-water covers `JR`; the source snapshot's records
 * cover the imported part of `S`. Reset-authored records are allocated strictly above
 * this value, so an unobserved high-water would let an authored record share an
 * authority time with an imported one. This is the same install-time metadata read
 * `journal_bootstrap_install.js` performs over the records it installs.
 *
 * @param {AuthorityTime} committedHighWater
 * @param {ReadonlyArray<JournalRecord>} sourceRecords
 * @returns {AuthorityTime}
 */
function observedHighWaterOf(committedHighWater, sourceRecords) {
    let greatest = committedHighWater;
    for (const record of sourceRecords) {
        if (!isSemanticEvent(record)) {
            continue;
        }
        if (compareAuthorityTime(record.authorityTime, greatest) > 0) {
            greatest = record.authorityTime;
        }
    }
    return greatest;
}

/**
 * The current graph schema's direct inputs per node, as replay requires them.
 *
 * `makeCurrentInputKeysOfNode` reports a node the scheme does not name as having no
 * template at all. A node the current schema does not name has no direct inputs in the
 * current schema either, so its input set is empty and the schema's proof rule for it
 * has nothing to require. Reset reads this function as the whole current input
 * derivation, so the rule is applied here once rather than at each reader.
 *
 * @param {import('../database/graph_scheme').GraphScheme} graphScheme
 * @returns {(nodeKeyString: string) => ReadonlyArray<string>}
 */
function currentInputKeysOfGraphScheme(graphScheme) {
    const template = makeCurrentInputKeysOfNode(graphScheme);
    return (nodeKeyString) => template(nodeKeyString) ?? [];
}

/**
 * Every retained record one journal source holds, read through its own readers.
 *
 * The reset needs the snapshot's records once, to read the greatest authority time the
 * observed union carries. The source supplies them through its readers, so the
 * read is the source's own read surface rather than a second traversal of the sublevel.
 *
 * @param {JournalSource} source
 * @returns {ReadonlyArray<JournalRecord>}
 */
function everyRecordOf(source) {
    /** @type {JournalRecord[]} */
    const records = [];
    for (const author of source.writers()) {
        const reader = source.prefixReaderOf(author);
        for (;;) {
            const record = reader.nextRecord();
            if (record === undefined) {
                break;
            }
            records.push(record);
        }
        const failure = reader.failure();
        if (failure !== undefined) {
            throw failure;
        }
    }
    return records;
}

/**
 * @typedef {object} JournalResetRequest
 * @property {RootDatabase} database
 * @property {Capabilities} capabilities
 * @property {ReplicaName} receiver - The activated replica, which retains `JR`.
 * @property {ReplicaName} source - The replica the held snapshot was scanned into, and
 *   which the reset is published into.
 */

/**
 * The properties that this type carries are:
 * - calling it resets a receiver which retains Journal records and returns whether the
 *   receiver's exposed replica changed;
 * - it publishes the whole reset into the inactive replica in one batch and moves the
 *   replica pointer only after that batch has succeeded, so the receiver is never
 *   observed holding a journal which disagrees with its own graph.
 *
 * The proof of those properties is guaranteed by:
 * - This typedef cannot enforce the properties by construction.
 * - Therefore the function which returns it is part of the proof, and there is exactly
 *   one such function:
 *   - `resetJournalReceiverToSnapshot`: it installs the outcome through
 *     `installResetOutcome`, which batches every operation of the publication and moves
 *     the replica pointer after the batch, and it reports the receiver as changed only
 *     when the reset completed.
 *
 * @typedef {(request: JournalResetRequest) => Promise<boolean>} ResetReceiverToSnapshot
 */

/**
 * Reset a Journal 3 receiver to the held snapshot a filesystem checkpoint carries.
 *
 * The snapshot is read as the one held `JournalSnapshot` reset targets: its retained
 * journal, its committed projection, its version and its graph scheme all come from the
 * same namespace, so the target cannot be paired with the metadata of another cut. The
 * receiver contributes its own retained journal, its own writer identity and its own
 * committed writer state, and the result is published into the snapshot's inactive
 * namespace in one write, after which that namespace becomes the receiver.
 *
 * @param {JournalResetRequest} request
 * @returns {Promise<boolean>} Whether the active replica pointer changed.
 */
async function resetJournalReceiverToSnapshot(request) {
    const { database, capabilities, receiver: receiverReplica, source: sourceReplica } = request;
    const receiverStorage = database.schemaStorageForReplica(receiverReplica);
    const sourceStorage = database.schemaStorageForReplica(sourceReplica);

    const sourceFingerprint = requireValidFingerprint(
        await sourceStorage.global.get('fingerprint'),
        'held reset source snapshot fingerprint'
    );
    if (!await retainsJournalRecords(sourceStorage)) {
        throw new ResetSourceIsNotAJournalSnapshotError(sourceFingerprint);
    }

    const receiverFingerprint = database.getFingerprint();
    const receiverVersion = requireText(await receiverStorage.global.get('version'), 'version');
    const receiverGraphScheme = requireText(
        await receiverStorage.global.get(GRAPH_SCHEME_KEY),
        'graph scheme'
    );
    const currentInputKeysOfNode = currentInputKeysOfGraphScheme(
        parseGraphScheme(receiverGraphScheme)
    );

    const held = await readHeldResetSource({
        storage: sourceStorage,
        currentInputKeysOfNode,
        fingerprint: sourceFingerprint,
    });
    if ('error' in held) {
        throw held.error;
    }

    const receiverReplica_ = await readRetainedJournal(receiverStorage.journal);
    if (receiverReplica_ instanceof Error) {
        throw receiverReplica_;
    }
    /** @type {ReadonlyArray<JournalRecord>} */
    const retainedRecords = [...receiverReplica_.values()].flat();

    const committed = await readCommittedWriterState(receiverStorage.journal, receiverFingerprint);
    if (isJournalError(committed)) {
        throw committed;
    }
    const localWriter = makeJournalAuthor(receiverFingerprint);
    if (isJournalError(localWriter)) {
        throw localWriter;
    }

    const receiver = makeReplicaSource(receiverReplica_);
    const retained = buildRetainedReplayState({
        source: receiver,
        localWriter,
        currentInputKeysOfNode,
    });
    if ('error' in retained) {
        throw retained.error;
    }

    const sourceRecords = everyRecordOf(held.source.journal);

    const result = resetToSource({
        receiver,
        retainedState: retained.state,
        source: held.source,
        localWriter,
        committed,
        observedHighWater: observedHighWaterOf(committed.authorityHighWater, sourceRecords),
        publicationInstant: capabilities.datetime.now().toMillis(),
        currentInputKeysOfNode,
        receiverIdentity: new SnapshotIdentityClass(receiverVersion, receiverGraphScheme),
    });
    if ('error' in result) {
        throw result.error;
    }

    await installResetOutcome({
        rootDatabase: database,
        targetReplica: sourceReplica,
        publication: {
            target: sourceStorage,
            retainedRecords,
            receiverVersion,
            receiverGraphScheme,
            receiverFingerprint,
            outcome: result.outcome,
        },
    });
    return true;
}

module.exports = {
    ResetSourceIsNotAJournalSnapshotError,
    isResetSourceIsNotAJournalSnapshotError,
    resetJournalReceiverToSnapshot,
};
