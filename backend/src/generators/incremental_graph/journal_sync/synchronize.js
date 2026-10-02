/**
 * `project(Jfinal)` for one pairwise synchronization.
 *
 * `incremental-graph-journal-sync.md` §Purpose states the operation this module
 * performs, in the specification's own order:
 *
 * ```text
 * open one stable compatible JournalSnapshot
 * copy every missing foreign-writer suffix
 * validate newly admitted history/causal closure
 * normalize only required IncrementalGraph semantic transitions
 * project final Journal
 * ```
 *
 * The publication step is the persistence front's half: this module returns the
 * records to retain, the records it authored, and the projection to lower, and it
 * commits nothing. That separation is what makes the algorithm testable against a
 * supported graph plus Journal pair without a database, and it is what lets the
 * persistence front publish `Jfinal` and `project(Jfinal)` in one atomic write.
 *
 * Nothing here is a whole-journal materialisation. Import reads one missing
 * suffix at a time and admits a record at a time; the replay passes and the
 * closure walk read the union source; the closure and stale-marker worklists are
 * graph-sized sets, which `sync.md` §Streamability permits for graph-sized work.
 */

/** @typedef {import('../journal/errors').AnyJournalError} JournalError */
/** @typedef {import('../journal/emission').CommittedWriterState} CommittedWriterState */
/** @typedef {import('../journal/records').JournalRecord} JournalRecord */
/** @typedef {import('../journal/types').AuthorityTime} AuthorityTime */
/** @typedef {import('../journal/types').JournalAuthor} JournalAuthor */
/** @typedef {import('../journal/types').JournalFrontier} JournalFrontier */
/** @typedef {import('../journal/oracle/record_source').JournalSource} JournalSource */
/** @typedef {import('../journal/oracle/projection').Projection} Projection */
/** @typedef {import('./authoring').SyncDeleteRequest} SyncDeleteRequest */
/** @typedef {import('./authoring').SyncInvalidateRequest} SyncInvalidateRequest */
/** @typedef {import('./authoring').SyncPublication} SyncPublication */
/** @typedef {import('./compatibility').SnapshotIdentity} SnapshotIdentity */

const {
    isJournalError,
    isProjection,
    journalAuthorToString,
    makeJournalFrontier,
    makeJournalPublicationError,
    makeUnionSource,
    projectRetainedJournal,
    selectSemanticHeads,
} = require("../journal");
const { assertCompatibleIdentity } = require("./compatibility");
const { finalizeSyncRecords, SyncPublicationClass } = require("./authoring");
const {
    importedSourceOf,
    planForeignSuffixImport,
    ImportedSuffixClass,
    ImportPlanClass,
} = require("./import_plan");
const { planDependencyClosureRemoval, planStalePropagation } = require("./normalize");

/**
 * The properties that this class carries are:
 * - `records` is the receiver's retained journal growth of this operation: every
 *   imported record unchanged, followed by the authored normalization records;
 * - `projection` is exactly `project(Jfinal)`, so its occurrences, freshness and
 *   validity edges are the graph state the receiver must commit; and
 * - `stateAdvancing` is true exactly when this operation imported a record the
 *   receiver did not already retain, or authored a normalization record.
 *
 * The proof of those properties is guaranteed by:
 * - `synchronizeRetainedJournal(...)`: it writes each imported record into
 *   `records` in ascending writer-local order without touching it, appends only
 *   the records `finalizeSyncRecords` allocated, and takes `projection` from a
 *   `projectRetainedJournal` over exactly those records; and
 * - `stateAdvancing` is computed from those two facts directly, which is the
 *   predicate of `sync.md` §Host-count bounded settling schedule.
 *
 * @param {ReadonlyArray<JournalRecord>} records
 * @param {SyncPublication} publication
 * @param {Projection} projection
 * @param {boolean} stateAdvancing
 */
class SyncOutcomeClass {
    /**
     * @param {ReadonlyArray<JournalRecord>} records
     * @param {SyncPublication} publication
     * @param {Projection} projection
     * @param {boolean} stateAdvancing
     */
    constructor(records, publication, projection, stateAdvancing) {
        this.records = records;
        this.publication = publication;
        this.projection = projection;
        this.stateAdvancing = stateAdvancing;
    }
}

/** @typedef {SyncOutcomeClass} SyncOutcome */

/**
 * @param {unknown} value
 * @returns {value is SyncOutcome}
 */
function isSyncOutcome(value) {
    return value instanceof SyncOutcomeClass;
}

/**
 * @typedef {object} SynchronizeRequest
 * @property {JournalSource} receiver - The receiver's retained journal.
 * @property {JournalSource} source - The one held compatible source snapshot's journal.
 * @property {JournalAuthor} localWriter - The receiver's own writer.
 * @property {CommittedWriterState} committed - The receiver's committed writer state.
 * @property {AuthorityTime} observedHighWater - The greatest authority time the receiver has observed.
 * @property {number} publicationInstant - Epoch milliseconds of this synchronization.
 * @property {(nodeKeyString: string) => ReadonlyArray<string>} currentInputKeysOfNode -
 *   The current schema's direct inputs per node.
 * @property {SnapshotIdentity} receiverIdentity - The receiver's active version and graph scheme.
 * @property {SnapshotIdentity} sourceIdentity - The held source snapshot's version and graph scheme.
 */

/**
 * The retained-journal read surface of one contiguous own-writer range the
 * receiver does not yet retain.
 *
 * The range starts at the receiver's writer head successor, so its reader is
 * offered from that coordinate rather than from the canonical first one. Unioning
 * it with the receiver's own retained prefix therefore yields one contiguous
 * stream per writer, and the union's own no-holes check covers the join.
 *
 * @param {JournalAuthor} localWriter
 * @param {ReadonlyArray<JournalRecord>} records
 * @returns {JournalSource | JournalError}
 */
function sourceOfAuthoredRange(localWriter, records) {
    const name = journalAuthorToString(localWriter);
    /** @type {JournalRecord[]} */
    const ofLocalWriter = [];
    for (const record of records) {
        if (journalAuthorToString(record.id.author) !== name) {
            return makeJournalPublicationError(
                "a synchronization publication allocated a record under another writer"
            );
        }
        ofLocalWriter.push(record);
    }
    const first = ofLocalWriter[0];
    if (first === undefined) {
        return makeJournalPublicationError("a synchronization publication allocated no record");
    }
    const seed = makeJournalFrontier([[localWriter, first.id.sequence]]);
    if (isJournalError(seed)) {
        return seed;
    }
    return importedSourceOf(
        new ImportPlanClass(
            [new ImportedSuffixClass(localWriter, first.id.sequence, ofLocalWriter)],
            seed
        )
    );
}

/**
 * Project the union of a base journal and a contiguous range the receiver does
 * not yet retain.
 *
 * @param {object} step
 * @param {JournalSource} step.base
 * @param {ReadonlyArray<JournalRecord>} step.records
 * @param {JournalAuthor} step.localWriter
 * @param {(nodeKeyString: string) => ReadonlyArray<string>} step.currentInputKeysOfNode
 * @returns {Projection | {error: JournalError}}
 */
function projectWithRecords(step) {
    const { base, records, localWriter, currentInputKeysOfNode } = step;
    /** @type {JournalSource} */
    let source = base;
    if (records.length > 0) {
        const authored = sourceOfAuthoredRange(localWriter, records);
        if (isJournalError(authored)) {
            return { error: authored };
        }
        source = makeUnionSource([base, authored]);
    }
    const projection = projectRetainedJournal({
        source,
        localWriter,
        currentInputKeysOfNode,
    });
    if (isJournalError(projection)) {
        return { error: projection };
    }
    if (!isProjection(projection)) {
        return { error: makeJournalPublicationError("replay did not produce a projection") };
    }
    return projection;
}

/**
 * Perform one pairwise synchronization of a retained journal.
 *
 * @param {SynchronizeRequest} request
 * @returns {{outcome: SyncOutcome} | {error: JournalError}}
 */
function synchronizeRetainedJournal(request) {
    const {
        receiver,
        source,
        localWriter,
        committed,
        observedHighWater,
        publicationInstant,
        currentInputKeysOfNode,
        receiverIdentity,
        sourceIdentity,
    } = request;

    const incompatible = assertCompatibleIdentity(receiverIdentity, sourceIdentity);
    if (incompatible !== undefined) {
        return { error: incompatible };
    }

    const plan = planForeignSuffixImport({
        receiver,
        source,
        localWriter,
        currentInputKeysOfNode,
    });
    if ("error" in plan) {
        return plan;
    }

    /** @type {JournalRecord[]} */
    const imported = [];
    for (const suffix of plan.suffixes) {
        imported.push(...suffix.records);
    }
    const unionAfterImport = imported.length === 0
        ? receiver
        : makeUnionSource([receiver, importedSourceOf(plan)]);

    const rawHeads = selectSemanticHeads(unionAfterImport);
    if ("error" in rawHeads) {
        return rawHeads;
    }
    const closure = planDependencyClosureRemoval({
        selections: rawHeads.selections,
        currentInputKeysOfNode,
    });

    /** @type {SyncPublication[]} */
    const publications = [];
    /** @type {JournalRecord[]} */
    const authored = [];

    /**
     * Allocate one normalization range and fold it into the accumulated
     * publications, or report the failure.
     *
     * @param {CommittedWriterState} from
     * @param {ReadonlyArray<SyncDeleteRequest>} deletes
     * @param {ReadonlyArray<SyncInvalidateRequest>} invalidations
     * @returns {{publication: SyncPublication} | {error: JournalError}}
     */
    const allocateInto = (from, deletes, invalidations) => {
        const allocated = finalizeSyncRecords({
            committed: from,
            observedFrontier: plan.frontier,
            observedHighWater,
            publicationInstant,
            deletes,
            invalidations,
        });
        if ("error" in allocated) {
            return allocated;
        }
        publications.push(allocated);
        authored.push(...allocated.records);
        return { publication: allocated };
    };

    /**
     * @param {ReadonlyArray<JournalRecord>} records
     * @returns {Projection | {error: JournalError}}
     */
    const projectAfter = (records) => projectWithRecords({
        base: unionAfterImport,
        records,
        localWriter,
        currentInputKeysOfNode,
    });

    // Phase 1 is allocated first, because its records are what makes the union
    // projectable: a raw union whose selected heads are not dependency-closed has
    // no projection at all.
    const phaseOne = allocateInto(committed, closure.requests, []);
    if ("error" in phaseOne) {
        return phaseOne;
    }
    /** @type {CommittedWriterState} */
    let state = phaseOne.publication.writerState;
    const projectedOnce = projectAfter(authored);
    if ("error" in projectedOnce) {
        return projectedOnce;
    }
    /** @type {Projection} */
    let afterPhaseOne = projectedOnce;

    // Phase 2 marks the occurrences which are self-proof-ready and yet stale
    // because a direct input is stale. Such a marker is what makes that staleness
    // durable, so marking one also makes every dependent of the marked node stale,
    // and `sync.md` §Phase 2 requires the rule through the affected dependency
    // closure. The current schema is acyclic, so each round marks at least the
    // deepest remaining occurrence and the walk ends within one round per present
    // occurrence. Each round allocates its own contiguous own-writer range, and the
    // ranges together are one contiguous run from the committed head.
    const presentNodes = afterPhaseOne.occurrences.length;
    for (let round = 0; round < presentNodes + 1; round += 1) {
        const due = planStalePropagation(afterPhaseOne);
        if (due.requests.length === 0) {
            break;
        }
        const marked = allocateInto(state, [], due.requests);
        if ("error" in marked) {
            return marked;
        }
        state = marked.publication.writerState;
        const next = projectAfter(authored);
        if ("error" in next) {
            return next;
        }
        afterPhaseOne = next;
    }
    if (planStalePropagation(afterPhaseOne).requests.length > 0) {
        return {
            error: makeJournalPublicationError(
                "stale propagation over the affected dependency closure did not reach a fixed point"
            ),
        };
    }

    if (afterPhaseOne.unmarkedPropagatedStaleness.size > 0) {
        return {
            error: makeJournalPublicationError(
                "the final projection leaves " +
                    afterPhaseOne.unmarkedPropagatedStaleness.size +
                    " self-proof-ready occurrence(s) stale without a persistent marker"
            ),
        };
    }

    /** @type {JournalRecord[]} */
    const records = [...imported, ...authored];
    return {
        outcome: new SyncOutcomeClass(
            records,
            new SyncPublicationClass(authored, state),
            afterPhaseOne,
            records.length > 0
        ),
    };
}

module.exports = {
    SyncOutcomeClass,
    isSyncOutcome,
    projectWithRecords,
    synchronizeRetainedJournal,
};