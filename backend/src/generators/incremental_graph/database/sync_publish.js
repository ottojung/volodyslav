/**
 * Lowering `project(Jfinal)` into a replica namespace.
 *
 * `incremental-graph-journal-sync.md` §Atomic publication requires that
 * cutover publish, together, `Jfinal`, `project(Jfinal)`, the local writer
 * allocator/high-water state and the derived indexes the implementation keeps.
 * §Final replay and validation then says the target graph is exactly
 * `project(Jfinal)` "lowered to existing storage", and
 * `incremental-graph-journal-storage.md` §Existing graph sublevels remain
 * projection says that lowering writes the *existing* `values`, `freshness`,
 * `valid` and `timestamps` formats rather than introducing Journal provenance
 * into them.
 *
 * This module is that lowering, and it is deliberately the only place which
 * knows how a projection becomes persisted graph bytes:
 *
 * - `values` receives each occurrence's payload under its own physical
 *   identifier, unchanged;
 * - `freshness` receives `up-to-date` or `potentially-outdated` from the
 *   occurrence's derived freshness;
 * - `valid` receives, per dependency identifier, the dependents whose incoming
 *   edge is valid — which is exactly the set of `validInputs` the occurrence
 *   carries, read the other way round;
 * - `timestamps` receives the occurrence's own `createdAt` and `modifiedAt`,
 *   neither normalised nor ordered against each other;
 * - `global` receives `identifiers_keys_map` and `last_node_index`, the two
 *   committed-pair members this lowering is the authority for; and
 * - `journal` receives this operation's records, the occurrence index the
 *   projection implies, and the committed-pair metadata record.
 *
 * Every one of those is an operation in a single array, handed to one
 * `SchemaStorage.batch` call. Nothing here writes: the caller decides when the
 * write happens, which is what lets the same lowering serve a staged target and
 * an active replica.
 *
 * Deletion is part of the lowering rather than a separate sweep. A projection
 * replaces the graph wholesale, so a key the projection does not name must be
 * removed in the same write; leaving it would make the committed projection
 * disagree with `project(Jfinal)` for exactly the occurrences normalization
 * removed. The deletions are derived by enumerating the target's own keys,
 * which is graph-sized work rather than history-sized work.
 */

/** @typedef {import('../journal/errors').AnyJournalError} JournalError */
/** @typedef {import('../journal/records').JournalRecord} JournalRecord */
/** @typedef {import('../journal_sync').SyncOutcome} SyncOutcome */
/** @typedef {import('../journal/oracle/projection').Projection} Projection */
/** @typedef {import('../journal/oracle/projection').ProjectedOccurrence} ProjectedOccurrence */
/** @typedef {import('./types').ComputedValue} ComputedValue */
/** @typedef {import('./types').Freshness} Freshness */
/** @typedef {import('./types').JournalKey} JournalKey */
/** @typedef {import('./types').JournalText} JournalText */
/** @typedef {import('./types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./types').TimestampRecord} TimestampRecord */
/** @typedef {import('./types').IdentifiersKeysMap} IdentifiersKeysMap */
/** @typedef {import('./root_database').SchemaStorage} SchemaStorage */

/**
 * @template T
 * @template K
 * @typedef {import('./typed_database').GenericDatabase<T, K>} GenericDatabase
 */

/**
 * @template T
 * @template [K=import('./types').DatabaseKey]
 * @typedef {import('./types').SimpleSublevel<T, K>} SimpleSublevel
 */

const {
    encodeJournalRecord,
    isJournalError,
    journalRecordIdToString,
} = require('../journal');
const {
    JOURNAL_STATE_KEY,
    makeJournalOccurrenceKey,
    makeJournalRecordKey,
    serializeWriterState,
} = require('../journal_store');
const {
    journalKeyToString,
    stringToJournalText,
    stringToNodeKeyString,
} = require('./types');
const {
    IDENTIFIERS_KEY,
    makeIdentifierLookup,
    serializeIdentifierLookup,
} = require('./identifier_lookup');
const { LAST_NODE_INDEX_KEY } = require('./root_database');
const { compareNodeIdentifier, nodeIdentifierToString } = require('./node_identifier');

/** The Journal sublevel's occurrence-index key family. */
const OCCURRENCE_KEY_PREFIX = 'occurrence|';

/**
 * Thrown when a projection cannot be lowered into the sublevels it names.
 *
 * The properties this class carries are:
 * - `reason` distinguishes the two failures a lowering can have: a projection
 *   whose identifier mapping is not bijective (`'identifiers'`), and a record
 *   whose storage key the Journal sublevel rejects (`'record'`).
 *
 * The proof of those properties is guaranteed by:
 * - `planSyncPublication(...)`: it reports `'identifiers'` only when
 *   `makeIdentifierLookup` rejects the occurrence set, and `'record'` only when
 *   `makeJournalRecordKey` rejects one of the outcome's own coordinates.
 *
 * @param {'identifiers' | 'record'} reason
 * @param {string} message
 */
class SyncPublicationPlanError extends Error {
    /**
     * @param {'identifiers' | 'record'} reason
     * @param {string} message
     */
    constructor(reason, message) {
        super(message);
        this.name = 'SyncPublicationPlanError';
        this.reason = reason;
    }
}

/**
 * @param {unknown} object
 * @returns {object is SyncPublicationPlanError}
 */
function isSyncPublicationPlanError(object) {
    return object instanceof SyncPublicationPlanError;
}

/**
 * The `freshness` value one occurrence lowers to.
 *
 * @param {ProjectedOccurrence} occurrence
 * @returns {Freshness}
 */
function freshnessOf(occurrence) {
    return occurrence.fresh ? 'up-to-date' : 'potentially-outdated';
}

/**
 * The inverted validity map the projection implies: each dependency's
 * identifier mapped to the identifiers of the dependents whose incoming edge it
 * proves.
 *
 * A dependency whose validated-dependent set is empty is omitted, because an
 * empty set and an absent key mean the same thing in this format and the graph
 * sublevel stores the smaller of the two.
 *
 * @param {ReadonlyArray<ProjectedOccurrence>} occurrences
 * @returns {Map<string, NodeIdentifier[]>}
 */
function invertedValidityOf(occurrences) {
    /** @type {Map<string, NodeIdentifier[]>} */
    const validatedDependents = new Map();
    for (const occurrence of occurrences) {
        const dependency = nodeIdentifierToString(occurrence.nodeIdentifier);
        const incumbent = validatedDependents.get(dependency);
        if (incumbent === undefined) {
            validatedDependents.set(dependency, []);
            continue;
        }
        incumbent.push(occurrence.nodeIdentifier);
    }
    /** @type {Map<string, NodeIdentifier[]>} */
    const inverted = new Map();
    for (const occurrence of occurrences) {
        const dependency = nodeIdentifierToString(occurrence.nodeIdentifier);
        const dependents = validatedDependents.get(dependency);
        if (dependents !== undefined && dependents.length > 0) {
            inverted.set(dependency, dependents.sort(compareNodeIdentifier));
        }
    }
    return inverted;
}

/**
 * The `identifiers_keys_map` the projection implies.
 *
 * The mapping is built through `makeIdentifierLookup` rather than serialised
 * directly, so a projection which maps two canonical node keys onto one physical
 * identifier is rejected here rather than becoming a persisted lookup whose
 * bijectivity no later reader could rely on. `projectRetainedJournal` already
 * rejects that collision; reusing the same check keeps the persisted form and
 * the replay guarantee from being two independent rules.
 *
 * @param {ReadonlyArray<ProjectedOccurrence>} occurrences
 * @returns {IdentifiersKeysMap}
 */
function identifiersMapOf(occurrences) {
    const lookup = makeIdentifierLookup(
        occurrences.map((occurrence) => [occurrence.nodeIdentifier, stringToNodeKeyString(occurrence.nodeKeyString)])
    );
    if (isJournalError(lookup)) {
        throw new SyncPublicationPlanError(
            'identifiers',
            'the projection does not induce a bijective identifier mapping: ' + lookup.message
        );
    }
    return serializeIdentifierLookup(lookup);
}

/**
 * Read every key of one of a target's own sublevels.
 *
 * @template T
 * @param {GenericDatabase<T, NodeIdentifier>} database
 * @returns {Promise<Array<NodeIdentifier>>}
 */
async function identifierKeysOf(database) {
    /** @type {Array<NodeIdentifier>} */
    const keys = [];
    for await (const key of database.keys()) {
        keys.push(key);
    }
    return keys;
}

/**
 * Read every occurrence key a target's journal sublevel holds.
 *
 * @param {GenericDatabase<JournalText, JournalKey>} journal
 * @returns {Promise<Array<JournalKey>>}
 */
async function occurrenceKeysOf(journal) {
    /** @type {Array<JournalKey>} */
    const keys = [];
    for await (const key of journal.keys()) {
        if (journalKeyToString(key).startsWith(OCCURRENCE_KEY_PREFIX)) {
            keys.push(key);
        }
    }
    return keys;
}

/**
 * Every identifier the three identifier-keyed graph sublevels currently hold and
 * the projection no longer names.
 *
 * The three sublevels are enumerated separately and their key sets joined, so a
 * key which one of them holds and the others do not is still deleted: a
 * supported lowering writes the same identifiers to all three, and the join
 * makes a disagreement a deletion rather than a silent survivor.
 *
 * @param {GenericDatabase<ComputedValue, NodeIdentifier>} values
 * @param {GenericDatabase<Freshness, NodeIdentifier>} freshness
 * @param {GenericDatabase<TimestampRecord, NodeIdentifier>} timestamps
 * @param {ReadonlyMap<string, NodeIdentifier>} presentIdentifiers
 * @returns {Promise<Array<NodeIdentifier>>}
 */
async function unprojectedIdentifiers(values, freshness, timestamps, presentIdentifiers) {
    /** @type {Map<string, NodeIdentifier>} */
    const held = new Map();
    for (const key of await identifierKeysOf(values)) {
        held.set(nodeIdentifierToString(key), key);
    }
    for (const key of await identifierKeysOf(freshness)) {
        held.set(nodeIdentifierToString(key), key);
    }
    for (const key of await identifierKeysOf(timestamps)) {
        held.set(nodeIdentifierToString(key), key);
    }
    return [...held.entries()]
        .filter(([held_]) => !presentIdentifiers.has(held_))
        .map(([, key]) => key);
}

/**
 * @typedef {object} SyncPublishRequest
 * @property {SchemaStorage} target - The namespace to lower into: an inactive
 *   replica, or the staging sublevel of an operation which has not cut over.
 * @property {SyncOutcome} outcome - What `synchronizeRetainedJournal`
 *   computed: the records to retain, the receiver-authored publication and
 *   exactly `project(Jfinal)`.
 */

/**
 * The operations which lower one projection into a target namespace.
 *
 * @param {SyncPublishRequest} request
 * @returns {Promise<ReadonlyArray<*>>}
 * @throws {SyncPublicationPlanError} If the projection cannot be lowered.
 */
async function planSyncPublication(request) {
    const { target, outcome } = request;
    const projection = outcome.projection;
    const occurrences = projection.occurrences;

    const identifiersMap = identifiersMapOf(occurrences);

    /** @type {Map<string, NodeIdentifier>} */
    const presentIdentifiers = new Map();
    for (const occurrence of occurrences) {
        presentIdentifiers.set(nodeIdentifierToString(occurrence.nodeIdentifier), occurrence.nodeIdentifier);
    }

    /** @type {Array<*>} */
    const operations = [];

    // Every identifier-keyed graph sublevel is replaced wholesale, so a key the
    // projection does not name is removed in the same write.
    const unprojected = await unprojectedIdentifiers(
        target.values,
        target.freshness,
        target.timestamps,
        presentIdentifiers
    );
    for (const identifier of unprojected) {
        operations.push(target.values.delOp(identifier));
        operations.push(target.freshness.delOp(identifier));
        operations.push(target.timestamps.delOp(identifier));
    }

    for (const occurrence of occurrences) {
        operations.push(
            target.values.putOp(occurrence.nodeIdentifier, occurrence.payload)
        );
        operations.push(target.freshness.putOp(occurrence.nodeIdentifier, freshnessOf(occurrence)));
        /** @type {TimestampRecord} */
        const timestamps = { createdAt: occurrence.createdAt, modifiedAt: occurrence.modifiedAt };
        operations.push(target.timestamps.putOp(occurrence.nodeIdentifier, timestamps));
    }

    const validity = invertedValidityOf(occurrences);
    for (const key of await identifierKeysOf(target.valid)) {
        if (!validity.has(nodeIdentifierToString(key))) {
            operations.push(target.valid.delOp(key));
        }
    }
    for (const [dependency, dependents] of validity) {
        const identifier = presentIdentifiers.get(dependency);
        if (identifier !== undefined) {
            operations.push(target.valid.putOp(identifier, dependents));
        }
    }

    operations.push(target.global.putOp(IDENTIFIERS_KEY, identifiersMap));
    operations.push(target.global.putOp(LAST_NODE_INDEX_KEY, projection.lastNodeIndex));

    for (const record of outcome.records) {
        const key = makeJournalRecordKey(record.id.author, record.id.sequence);
        if (isJournalError(key)) {
            throw new SyncPublicationPlanError('record', key.message);
        }
        operations.push(target.journal.putOp(key, stringToJournalText(encodeJournalRecord(record))));
    }
    for (const key of await occurrenceKeysOf(target.journal)) {
        operations.push(target.journal.delOp(key));
    }
    for (const occurrence of occurrences) {
        operations.push(
            target.journal.putOp(
                makeJournalOccurrenceKey(occurrence.nodeKey),
                stringToJournalText(journalRecordIdToString(occurrence.valueId))
            )
        );
    }
    operations.push(
        target.journal.putOp(
            JOURNAL_STATE_KEY,
            stringToJournalText(JSON.stringify(serializeWriterState(outcome.publication.writerState)))
        )
    );

    return operations;
}

/**
 * Publish one synchronization outcome into a target namespace.
 *
 * The whole lowering is one array of operations and one `batch` call, so the
 * target never exposes a graph which disagrees with its own Journal: either
 * both become visible together or neither does. Deletions of occurrences the
 * projection no longer contains are part of that same write.
 *
 * @param {SyncPublishRequest} request
 * @returns {Promise<void>}
 * @throws {SyncPublicationPlanError} If the projection cannot be lowered.
 */
async function publishSyncOutcome(request) {
    /** @type {Array<*>} */
    const operations = [...await planSyncPublication(request)];
    await request.target.batch(operations);
}

module.exports = {
    OCCURRENCE_KEY_PREFIX,
    SyncPublicationPlanError,
    isSyncPublicationPlanError,
    planSyncPublication,
    publishSyncOutcome,
};
