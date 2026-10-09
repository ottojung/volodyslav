/**
 * Installing a resolved canonical bootstrap, the durable half of the §8.2 cutover.
 *
 * `database-lifecycle.md` §8.2 makes the cutover the only moment a
 * supported pre-Journal database stops being the active persisted state, and
 * `incremental-graph-journal-storage.md` requires the selected pair to be published
 * atomically. Both requirements are the same requirement here: the canonical cut, the
 * committed Journal state and the materialized graph replay produces must all land in
 * one atomic write into the inactive replica, and the replica pointer moves only after
 * that write has succeeded. A failure anywhere before the pointer move leaves the
 * pre-Journal database selected, which is the state §8.2 requires an unresolved or
 * failed bootstrap to leave behind.
 *
 * Nothing is authored here. The records are the artifact's own cut plus, for a join,
 * the joining records the §7 consumer built, and the materialized graph is the
 * projection the §6 or §7 consumer already replayed and checked. Installing them is
 * therefore a lowering, and a lowering which cannot be derived from the resolution is
 * refused rather than approximated.
 *
 * The lowering writes exactly the sublevels a Journal replica persists and no others:
 * `values`, `timestamps`, `freshness` and `valid` for the materialized graph, the
 * `journal` sublevel through the same publication seam ordinary publications use, and
 * the replica's `global` metadata. No on-disk format is introduced or changed; the
 * allocator watermark, the identifier lookup and the version are the replica's own
 * persisted facts, and the fingerprint is carried forward because a bootstrap preserves
 * the installation identity rather than minting a new one.
 */

/** @typedef {import('./journal/errors').AnyJournalError} JournalError */
/** @typedef {import('./journal/types').AuthorityTime} AuthorityTime */
/** @typedef {import('./journal/types').JournalAuthor} JournalAuthor */
/** @typedef {import('./journal/types').JournalSequence} JournalSequence */
/** @typedef {import('./journal/records').JournalRecord} JournalRecord */
/** @typedef {import('./journal/emission').CommittedWriterState} CommittedWriterState */
/** @typedef {import('./database/types').DatabaseBatchOperation} DatabaseBatchOperation */
/** @typedef {import('./database/types').IdentifiersKeysMap} IdentifiersKeysMap */
/** @typedef {import('./database/types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./database/root_database').RootDatabase} RootDatabase */
/** @typedef {import('./database/root_database').SchemaStorage} SchemaStorage */
/** @typedef {import('./database/root_database').ReplicaName} ReplicaName */
/** @typedef {import('./journal_bootstrap_startup').StartupCanonicalBootstrap} StartupCanonicalBootstrap */
/** @typedef {import('./journal/bootstrap').LegacyBootstrapState} LegacyBootstrapState */

const {
    GRAPH_SCHEME_KEY,
    IDENTIFIERS_KEY,
    LAST_NODE_INDEX_KEY,
    compareNodeIdentifier,
    serializeIdentifierLookup,
    stringToNodeKeyString,
    setIdentifierMapping,
    makeEmptyIdentifierLookup,
} = require("./database");
const {
    compareAuthorityTime,
    isJournalError,
    isSemanticEvent,
    journalAuthorToString,
    makeAuthorityTime,
    journalSequenceToString,
    makeJournalFrontier,
    nodeKeyToCanonicalString,
} = require("./journal");
const { appendJournalPublicationOps, makeInitialCommittedWriterState } = require("./journal_store");
const { isStartupCanonicalBootstrap } = require("./journal_bootstrap_startup");

/**
 * The committed Journal state a resolved bootstrap installs, reconstructed from the
 * resolved cut rather than produced by an ordinary publication.
 *
 * The local writer head is the frontier's own coordinate for this replica, the
 * authority high-water is the greatest authority any installed record carries, and the
 * allocator watermark is the watermark the resolved projection reconstructs, which the
 * §6 and §7 consumers have already checked against what this replica persists.
 *
 * @param {StartupCanonicalBootstrap} resolution
 * @returns {CommittedWriterState | JournalError}
 */
function committedStateOf(resolution) {
    const initial = makeInitialCommittedWriterState(resolution.localWriter);
    if (isJournalError(initial)) {
        return initial;
    }
    const highWater = greatestAuthorityOf(resolution.records, initial.authorityHighWater);
    if (isJournalError(highWater)) {
        return highWater;
    }
    const committedFrontier = makeJournalFrontier([...resolution.frontier]);
    if (isJournalError(committedFrontier)) {
        return committedFrontier;
    }
    return {
        localWriter: resolution.localWriter,
        writerHead: writerHeadOf(resolution, initial),
        committedFrontier,
        authorityHighWater: highWater,
        allocatorWatermark: resolution.projection.lastNodeIndex,
    };
}

/**
 * @param {ReadonlyArray<JournalRecord>} records
 * @param {AuthorityTime} highWater
 * @returns {AuthorityTime | JournalError}
 */
function greatestAuthorityOf(records, highWater) {
    let greatest = highWater;
    for (const record of records) {
        if (!isSemanticEvent(record)) {
            continue;
        }
        if (compareAuthorityTime(record.authorityTime, greatest) <= 0) {
            continue;
        }
        const raised = makeAuthorityTime(
            record.authorityTime.physical,
            journalSequenceToString(record.authorityTime.logical)
        );
        if (isJournalError(raised)) {
            return raised;
        }
        greatest = raised;
    }
    return greatest;
}

/**
 * @param {StartupCanonicalBootstrap} resolution
 * @param {CommittedWriterState} initial
 * @returns {JournalSequence}
 */
function writerHeadOf(resolution, initial) {
    const localName = journalAuthorToString(resolution.localWriter);
    for (const coordinate of resolution.frontier) {
        if (journalAuthorToString(coordinate[0]) === localName) {
            return coordinate[1];
        }
    }
    return initial.writerHead;
}

/**
 * @param {SchemaStorage} storage - The inactive replica the operations are built against.
 * @param {StartupCanonicalBootstrap} resolution
 * @returns {Array<*>}
 */
function graphOperationsOf(storage, resolution) {
    /** @type {Array<*>} */
    const operations = [];
    /** @type {Map<string, NodeIdentifier[]>} */
    const dependentsByInput = new Map();
    for (const occurrence of resolution.projection.occurrences) {
        const identifier = occurrence.nodeIdentifier;
        operations.push(
            storage.values.putOp(identifier, occurrence.payload),
            storage.timestamps.putOp(identifier, {
                createdAt: occurrence.createdAt,
                modifiedAt: occurrence.modifiedAt,
            }),
            storage.freshness.putOp(identifier, occurrence.fresh ? "up-to-date" : "potentially-outdated")
        );
        for (const inputKeyString of occurrence.validInputs) {
            const existing = dependentsByInput.get(inputKeyString);
            if (existing === undefined) {
                dependentsByInput.set(inputKeyString, [identifier]);
                continue;
            }
            existing.push(identifier);
        }
    }
    for (const [inputKeyString, dependents] of dependentsByInput) {
        const inputIdentifier = identifierOf(resolution.projection.occurrences, inputKeyString);
        if (inputIdentifier === undefined) {
            continue;
        }
        operations.push(storage.valid.putOp(inputIdentifier, sortByIdentifier(dependents)));
    }
    return operations;
}

/**
 * @param {ReadonlyArray<import('./journal/oracle/projection').ProjectedOccurrence>} occurrences
 * @param {string} inputKeyString
 * @returns {import('./database/types').NodeIdentifier | undefined}
 */
function identifierOf(occurrences, inputKeyString) {
    for (const occurrence of occurrences) {
        if (occurrence.nodeKeyString === inputKeyString) {
            return occurrence.nodeIdentifier;
        }
    }
    return undefined;
}

/**
 * Install a resolved canonical bootstrap into the inactive replica and select it.
 *
 * The inactive replica is cleared first, so the target holds nothing but what this
 * call installs: a bootstrap is not a merge over residue, and leaving an earlier
 * discarded attempt's keys behind would let a record the current decision never made
 * survive into the replica the next startup declares current.
 *
 * @param {RootDatabase} rootDatabase
 * @param {StartupCanonicalBootstrap} resolution
 * @returns {Promise<ReplicaName>}
 */
async function installCanonicalBootstrap(rootDatabase, resolution) {
    if (!isStartupCanonicalBootstrap(resolution)) {
        throw new Error("installCanonicalBootstrap requires a resolved canonical bootstrap");
    }
    const target = rootDatabase.otherReplicaName();
    await rootDatabase.clearReplicaStorage(target);
    const storage = rootDatabase.schemaStorageForReplica(target);
    const writerState = committedStateOf(resolution);
    if (isJournalError(writerState)) {
        throw writerState;
    }
    const operations = graphOperationsOf(storage, resolution);
    appendJournalPublicationOps(storage.journal, operations, {
        records: resolution.records,
        writerState,
    });
    operations.push(storage.global.putOp(IDENTIFIERS_KEY, identifierLookupOf(resolution)));
    operations.push(storage.global.putOp(LAST_NODE_INDEX_KEY, resolution.projection.lastNodeIndex));
    operations.push(storage.global.putOp(GRAPH_SCHEME_KEY, resolution.artifact.graphSchemeString));
    operations.push(storage.global.putOp("version", resolution.databaseVersion));
    operations.push(storage.global.putOp("fingerprint", journalAuthorToString(resolution.localWriter)));
    await storage.batch(operations);
    await rootDatabase.setCurrentReplicaPointer(target);
    return target;
}

/**
 * @param {StartupCanonicalBootstrap} resolution
 * @returns {IdentifiersKeysMap}
 */
function identifierLookupOf(resolution) {
    const lookup = makeEmptyIdentifierLookup();
    for (const occurrence of resolution.projection.occurrences) {
        setIdentifierMapping(lookup, occurrence.nodeIdentifier, stringToNodeKeyString(nodeKeyToCanonicalString(occurrence.nodeKey)));
    }
    return serializeIdentifierLookup(lookup);
}

/**
 * @param {NodeIdentifier[]} identifiers
 * @returns {NodeIdentifier[]}
 */
function sortByIdentifier(identifiers) {
    return [...identifiers].sort((left, right) =>
        compareNodeIdentifier(left, right)
    );
}

module.exports = {
    committedStateOf,
    installCanonicalBootstrap,
};
