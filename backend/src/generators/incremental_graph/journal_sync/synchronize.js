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
 * records to retain, the records it authored, the projection to lower and the
 * retained replay state which describes `Jfinal`, and it commits nothing. That
 * separation is what makes the algorithm testable against a supported graph plus
 * Journal pair without a database, and it is what lets the persistence front
 * publish `Jfinal`, `project(Jfinal)` and the derived state both of them imply in
 * one atomic write.
 *
 * Every cut this operation reads is read from the receiver's retained replay state
 * extended by the records synchronization admits or authors. That is not an
 * implementation convenience: `sync.md` §Phase 2 requires the `P1` state to be
 * "derived ... incrementally over the affected dependency closure using retained
 * projection/index state", and
 * `incremental-graph-journal-storage.md` §Change-bounded proof summary names
 * synchronization as one of the operations which must not fall back to scanning
 * unrelated retained history. Synchronization therefore refuses a receiver which
 * does not supply that state, exactly as reset refuses a missing one, and it refuses
 * a state which does not describe the receiver's own retained journal, because that
 * §Change-bounded proof summary reserves a stale summary for explicit
 * rebuild/maintenance rather than for consumption.
 *
 * Two boundaries follow from the state being the receiver's active derived state
 * rather than a local scratch value. The operation stages into a fork of the supplied
 * state and reaches the caller's state only when it succeeds, so a failure at any step
 * leaves the caller's state as it was found, which is what `sync.md` §Atomic
 * publication means by failure before cutover leaving the previous active supported
 * state selected. And a successful outcome carries the caller's own state object, now
 * describing `Jfinal`, so a caller which staged it and cut over with the records it
 * retains holds the state those records project to.
 *
 * Nothing here is a whole-journal materialisation. Import reads one missing
 * suffix at a time and admits a record at a time; the retained state is extended
 * record by record; the closure and stale-marker worklists are graph-sized sets,
 * which `sync.md` §Streamability permits for graph-sized work.
 */

/** @typedef {import('../journal/errors').AnyJournalError} JournalError */
/** @typedef {import('../journal/emission').CommittedWriterState} CommittedWriterState */
/** @typedef {import('../journal/records').JournalRecord} JournalRecord */
/** @typedef {import('../journal/types').AuthorityTime} AuthorityTime */
/** @typedef {import('../journal/types').JournalAuthor} JournalAuthor */
/** @typedef {import('../journal/oracle/heads').HeadSelection} HeadSelection */
/** @typedef {import('../journal/oracle/projection').Projection} Projection */
/** @typedef {import('../journal/oracle/record_source').JournalSource} JournalSource */
/** @typedef {import('../journal_retained').RetainedReplayState} RetainedReplayState */
/** @typedef {import('./authoring').SyncDeleteRequest} SyncDeleteRequest */
/** @typedef {import('./authoring').SyncInvalidateRequest} SyncInvalidateRequest */
/** @typedef {import('./authoring').SyncPublication} SyncPublication */
/** @typedef {import('./compatibility').SnapshotIdentity} SnapshotIdentity */

const {
    makeJournalProjectionError,
    makeJournalPublicationError,
} = require("../journal");
const {
    isRetainedReplayState,
    projectRetainedReplay,
    refuseStaleRetainedState,
    selectedHeadsOf,
    stageRetainedRecords,
} = require("../journal_retained");
const { assertCompatibleIdentity } = require("./compatibility");
const { finalizeSyncRecords, SyncPublicationClass } = require("./authoring");
const { planForeignSuffixImport } = require("./import_plan");
const { planDependencyClosureRemoval, planStalePropagation } = require("./normalize");

/**
 * The properties that this class carries are:
 * - `records` is the receiver's retained journal growth of this operation: every
 *   imported record unchanged, followed by the authored normalization records;
 * - `projection` is exactly `project(Jfinal)`, so its occurrences, freshness and
 *   validity edges are the graph state the receiver must commit;
 * - `stateAdvancing` is true exactly when this operation imported a record the
 *   receiver did not already retain, or authored a normalization record; and
 * - `retainedState` is the retained replay state of `Jfinal`, which the
 *   persistence front stages with the records and cuts over with them, because
 *   `incremental-graph-journal-storage.md` §Change-bounded proof summary requires
 *   imported and sync-authored records to update a staged summary before cutover
 *   and §Derived indexes requires the same of a maintained candidate index.
 *
 * The proof of those properties is guaranteed by:
 * - `synchronizeRetainedJournal(...)`: it stages each imported record without
 *   touching it, stages only what `finalizeSyncRecords` allocated, takes
 *   `projection` from the retained state extended by exactly those records, and
 *   takes `stateAdvancing` from the two counts directly, which is the predicate
 *   of `sync.md` §Host-count bounded settling schedule. `retainedState` is the
 *   caller's own state, into which the operation's fork has been committed, so it
 *   describes exactly `Jfinal`.
 *
 * @param {ReadonlyArray<JournalRecord>} records
 * @param {SyncPublication} publication
 * @param {Projection} projection
 * @param {boolean} stateAdvancing
 * @param {RetainedReplayState} retainedState
 */
class SyncOutcomeClass {
    /**
     * @param {ReadonlyArray<JournalRecord>} records
     * @param {SyncPublication} publication
     * @param {Projection} projection
     * @param {boolean} stateAdvancing
     * @param {RetainedReplayState} retainedState
     */
    constructor(records, publication, projection, stateAdvancing, retainedState) {
        this.records = records;
        this.publication = publication;
        this.projection = projection;
        this.stateAdvancing = stateAdvancing;
        this.retainedState = retainedState;
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
 * @property {RetainedReplayState} retainedState - The activated replica's retained
 *   per-node replay state, which carries its counted proof summary and the
 *   resolution of its last projected cut. Synchronization refuses a missing state
 *   instead of deriving its cuts by scanning retained history, because
 *   `incremental-graph-journal-sync.md` §Phase 2 requires the `P1` state to be
 *   derived over the affected dependency closure from retained projection/index
 *   state and
 *   `incremental-graph-journal-storage.md` §Change-bounded proof summary forbids
 *   synchronization from falling back to scanning unrelated retained history. It
 *   also refuses a state which does not describe this `receiver`, which is the
 *   stale-summary case the same section reserves for explicit rebuild/maintenance.
 *   The state is read, not extended: a failed synchronization leaves it as it was
 *   found, and a successful one leaves it describing `Jfinal`.
 */

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
        retainedState,
    } = request;

    if (!isRetainedReplayState(retainedState)) {
        return {
            error: makeJournalProjectionError(
                "synchronization requires the receiver's retained replay state and does not " +
                    "fall back to replaying retained history",
                ""
            ),
        };
    }

    // A state which does not describe the receiver's own retained journal is stale
    // derived state. `incremental-graph-journal-storage.md` §Change-bounded proof
    // summary requires a stale summary to be rebuilt or maintained rather than
    // consumed, so it is refused here: projecting it would report success over a
    // projection of a journal the receiver does not retain. The comparison is one
    // `writers()` call and one `retainedLengthOf` call per writer, so detecting it
    // costs nothing §Phase 2 forbids.
    const stale = refuseStaleRetainedState(retainedState, receiver);
    if (stale !== undefined) {
        return stale;
    }

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

    // The raw maintenance view of `J0`. `project(J0)` is deliberately not taken: a
    // union of two valid replicas can have cross-authority winners which are not
    // dependency-closed, and Phase 1 is what repairs that. The head view is the
    // retained one with the imported records folded in, so no retained Value/Delete
    // record is visited again.
    stageRetainedRecords(retainedState, imported);
    /** @type {Map<string, HeadSelection>} */
    const rawHeads = selectedHeadsOf(retainedState);
    const closure = planDependencyClosureRemoval({
        selections: rawHeads,
        currentInputKeysOfNode,
    });

    /** @type {JournalRecord[]} */
    const authored = [];

    /**
     * Allocate one normalization range, stage it into the retained state and fold
     * it into the accumulated authored records, or report the failure.
     *
     * @param {CommittedWriterState} from
     * @param {ReadonlyArray<SyncDeleteRequest>} deletes
     * @param {ReadonlyArray<SyncInvalidateRequest>} invalidations
     * @returns {{writerState: CommittedWriterState} | {error: JournalError}}
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
        stageRetainedRecords(retainedState, allocated.records);
        authored.push(...allocated.records);
        return { writerState: allocated.writerState };
    };

    /**
     * The cut synchronization has reached, read as a delta over the affected
     * closure.
     * @returns {Projection | {error: JournalError}}
     */
    const cut = () => projectRetainedReplay(retainedState);

    // Phase 1 is allocated first, because its records are what makes the union
    // projectable: a raw union whose selected heads are not dependency-closed has
    // no projection at all.
    const phaseOne = allocateInto(committed, closure.requests, []);
    if ("error" in phaseOne) {
        return phaseOne;
    }
    /** @type {CommittedWriterState} */
    let state = phaseOne.writerState;
    const projectedOnce = cut();
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
        state = marked.writerState;
        const next = cut();
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
            records.length > 0,
            retainedState
        ),
    };
}

module.exports = {
    SyncOutcomeClass,
    isSyncOutcome,
    synchronizeRetainedJournal,
};