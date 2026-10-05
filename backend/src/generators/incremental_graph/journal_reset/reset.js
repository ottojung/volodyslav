/**
 * Controlled reset of an existing Journal 3 receiver to a chosen source's
 * projected graph state.
 *
 * `incremental-graph-journal-reset.md` §Purpose defines what reset is: retain the
 * observed history, import the missing source history, and append only the
 * receiver-authored semantic records which make the receiver's projection
 * observationally equal to the requested source projection. There is no journal
 * incarnation, no history truncation and no cursor invalidation, and every
 * imported record keeps its own writer.
 *
 * This module performs everything up to but excluding the publication write. It
 * returns the records to retain, the records it authored and the projection to
 * lower, and commits nothing, which is what makes reset testable against a
 * supported graph plus Journal pair without a database and what lets the
 * persistence front publish the whole target in one atomic write.
 *
 * The passes are the specification's, in its order, because each one's cut is the
 * next one's input:
 *
 * - the raw union `J0` is inspected through `selectedHeads(J0)` alone. A union of
 *   two individually valid replicas can have cross-authority winners which are not
 *   dependency-closed, so `project(J0)` may not exist and is never asked for;
 * - Pass 1 makes selected presence and immutable occurrence state equal the target,
 *   and only then is `P1 = project(J1)` well defined;
 * - Pass 2 reads `eligibleEffectiveProofUnion` at that fixed `P1` cut, authors one
 *   occurrence-scoped barrier per unwanted edge, and only then decides which
 *   target certificates replay does not already supply;
 * - Pass 3 makes the target's persistent stale flags durable, and the result is
 *   then checked against the target semantic graph the theorem names.
 *
 * Every cut is read from the activated replica's retained replay state, extended
 * by the records reset admits or authors, because §Pass 1 closure guarantee,
 * §Pass 2 and §Pass 3 all require the required state to be computed as a delta over
 * the affected closure rather than by replaying unrelated retained history. Reset
 * refuses a receiver which does not supply that state instead of falling back to a
 * scan, exactly as it refuses a missing counted proof summary.
 */

/** @typedef {import('../journal/errors').AnyJournalError} JournalError */
/** @typedef {import('../journal/emission').CommittedWriterState} CommittedWriterState */
/** @typedef {import('../journal/records').JournalRecord} JournalRecord */
/** @typedef {import('../journal/types').AuthorityTime} AuthorityTime */
/** @typedef {import('../journal/types').JournalAuthor} JournalAuthor */
/** @typedef {import('../journal/types').NodeKey} NodeKey */
/** @typedef {import('../journal/oracle/projection').Projection} Projection */
/** @typedef {import('../journal/oracle/record_source').JournalSource} JournalSource */
/** @typedef {import('../journal_sync').SnapshotIdentity} SnapshotIdentity */
/** @typedef {import('./authoring').ResetPublication} ResetPublication */
/** @typedef {import('./authoring').ResetRequest} ResetRequest */
/** @typedef {import('./pass1').ResetValueId} ResetValueId */
/** @typedef {import('./pass2').ResetTargetOccurrence} ResetTargetOccurrence */
/** @typedef {import('../journal_retained').RetainedReplayState} RetainedReplayState */
/** @typedef {import('./source').ResetSource} ResetSource */

const {
    isValueEvent,
    makeJournalProjectionError,
    nodeKeyToCanonicalString,
} = require("../journal");
const { assertCompatibleIdentity, planForeignSuffixImport } = require("../journal_sync");
const { finalizeResetRecords, ResetPublicationClass } = require("./authoring");
const { verifyTargetEquivalence } = require("./equivalence");
const { deleteRequestOf, iterateResetDomain, valueRequestOf } = require("./pass1");
const {
    eligibleEffectiveProofUnion,
    planProofBarriers,
    planTargetValidations,
} = require("./pass2");
const { hasUncoveredValueInvalidationOf, planFreshnessMarkers } = require("./pass3");
const {
    authorLookupOf,
    invalidationSummaryOf,
    isRetainedReplayState,
    projectRetainedReplay,
    selectedHeadsOf,
    selectedOccurrencesOf,
    stageRetainedRecords,
} = require("../journal_retained");

/**
 * The properties that this class carries are:
 * - `records` is the receiver's retained journal growth of this reset: every
 *   imported record unchanged, followed by every reset-authored record;
 * - `projection` is `project(Jreset)`, so its occurrences, freshness and validity
 *   edges are the graph state the receiver must commit;
 * - `valueIds` names, for every target-present node, the occurrence reset settled
 *   on, which Pass 1 preserved from the raw union or authored; and
 * - `changed` is true exactly when this reset imported a record the receiver did
 *   not already retain or authored a semantic record, which is the specification's
 *   persistent-change definition rather than a semantic-record count; and
 * - `retainedState` is the retained replay state of `Jreset`, which the
 *   persistence front stages with the records and cuts over with them, because
 *   `incremental-graph-journal-storage.md` §Change-bounded proof summary requires
 *   imported and reset-authored records to update a staged summary before cutover
 *   and §Derived indexes requires the same of a maintained candidate index.
 *
 * The proof of those properties is guaranteed by:
 * - `resetToSource(...)`: it stages each imported record without touching it,
 *   stages only what `finalizeResetRecords` allocated, takes `projection` from the
 *   retained state extended by exactly those records, and derives `changed` from
 *   the two counts directly; and
 * - `valueIds` is filled from `selectedHeads(J0)` for preserved occurrences and from
 *   the allocated `ValueEvent`s for authored ones, and Passes 2 and 3 author no
 *   `ValueEvent`, so the map is the selected occurrence of each target-present node
 *   after the final pass.
 *
 * @param {ReadonlyArray<JournalRecord>} records
 * @param {ResetPublication} publication
 * @param {Projection} projection
 * @param {Map<string, ResetValueId>} valueIds
 * @param {boolean} changed
 * @param {RetainedReplayState} retainedState
 */
class ResetOutcomeClass {
    /**
     * @param {ReadonlyArray<JournalRecord>} records
     * @param {ResetPublication} publication
     * @param {Projection} projection
     * @param {Map<string, ResetValueId>} valueIds
     * @param {boolean} changed
     * @param {RetainedReplayState} retainedState
     */
    constructor(records, publication, projection, valueIds, changed, retainedState) {
        this.records = records;
        this.publication = publication;
        this.projection = projection;
        this.valueIds = valueIds;
        this.changed = changed;
        this.retainedState = retainedState;
    }
}

/** @typedef {ResetOutcomeClass} ResetOutcome */

/**
 * @param {unknown} value
 * @returns {value is ResetOutcome}
 */
function isResetOutcome(value) {
    return value instanceof ResetOutcomeClass;
}

/**
 * @typedef {object} ResetRequestBody
 * @property {JournalSource} receiver - The receiver's retained journal.
 * @property {ResetSource} source - The one held compatible source snapshot.
 * @property {JournalAuthor} localWriter - The receiver's own writer, which reset
 *   retains; reset never adopts the source's writer identity.
 * @property {CommittedWriterState} committed - The receiver's committed writer state.
 * @property {AuthorityTime} observedHighWater - The greatest authority time observed.
 * @property {number} publicationInstant - Epoch milliseconds of this reset.
 * @property {(nodeKeyString: string) => ReadonlyArray<string>} currentInputKeysOfNode
 * @property {SnapshotIdentity} receiverIdentity - The receiver's active version and
 *   graph scheme, compared against the held snapshot's own metadata.
 * @property {RetainedReplayState} retainedState - The activated replica's retained
 *   per-node replay state, which carries its counted proof summary. Reset refuses a
 *   missing state instead of deriving the required cuts by scanning retained
 *   history, because `incremental-graph-journal-reset.md` §Pass 1 closure guarantee
 *   requires the affected state to be computed as a delta over the retained
 *   projection/index state.
 */

/**
 * Perform one controlled reset of a retained journal to a held source snapshot.
 *
 * @param {ResetRequestBody} request
 * @returns {{outcome: ResetOutcome} | {error: JournalError}}
 */
function resetToSource(request) {
    const {
        receiver,
        source,
        localWriter,
        committed,
        observedHighWater,
        publicationInstant,
        currentInputKeysOfNode,
        receiverIdentity,
        retainedState,
    } = request;

    if (!isRetainedReplayState(retainedState)) {
        return {
            error: makeJournalProjectionError(
                "reset requires the receiver's retained replay state and does not fall back " +
                    "to replaying retained history",
                ""
            ),
        };
    }

    const incompatible = assertCompatibleIdentity(receiverIdentity, source.identity());
    if (incompatible !== undefined) {
        return { error: incompatible };
    }

    // J0 = union(JR, S). The own-writer rollback boundary is the shared one: a
    // source ahead of the receiver for the receiver's own writer is refused here,
    // before any record is admitted and before any authorship is allocated.
    const plan = planForeignSuffixImport({
        receiver,
        source: source.journal,
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

    // The raw maintenance view. `project(J0)` is deliberately not taken: two valid
    // replicas can have a compatible union whose cross-authority winners are not
    // dependency-closed, and Pass 1 is what repairs that. The head view is the
    // retained one with the imported records folded in, so no retained Value/Delete
    // record is visited again.
    stageRetainedRecords(retainedState, imported);
    const rawHeads = selectedHeadsOf(retainedState);

    const target = source.projection;
    const domain = iterateResetDomain({ selections: rawHeads, target });

    /** @type {JournalRecord[]} */
    const authored = [];
    /** @type {CommittedWriterState} */
    let state = committed;
    /**
     * Allocate one pass's records as the next contiguous own-writer range, stage them
     * into the retained state, or report the failure which stopped it.
     *
     * @param {ReadonlyArray<ResetRequest>} requests
     * @returns {{publication: ResetPublication} | {error: JournalError}}
     */
    const allocateInto = (requests) => {
        const allocated = finalizeResetRecords({
            committed: state,
            observedFrontier: plan.frontier,
            observedHighWater,
            publicationInstant,
            requests,
        });
        if ("error" in allocated) {
            return allocated;
        }
        stageRetainedRecords(retainedState, allocated.records);
        authored.push(...allocated.records);
        state = allocated.writerState;
        return { publication: allocated };
    };

    /**
     * The cut the passes have reached, read as a delta over the affected closure.
     * @returns {Projection | {error: JournalError}}
     */
    const cut = () => projectRetainedReplay(retainedState);

    // ---- Pass 1: target presence and value occurrences -------------------
    /** @type {Map<string, ResetValueId>} */
    const valueIds = new Map();
    /** @type {import('./authoring').ResetRequest[]} */
    const presenceRequests = [];
    for (const entry of domain()) {
        const request = valueRequestOf(entry);
        if (request !== undefined) {
            presenceRequests.push(request);
            continue;
        }
        const winner = entry.selection === undefined ? undefined : entry.selection.winner;
        if (winner !== undefined && isValueEvent(winner)) {
            valueIds.set(entry.nodeKeyString, winner.id);
        }
    }
    /** @type {import('./authoring').ResetRequest[]} */
    const absenceRequests = [];
    for (const entry of domain()) {
        const request = deleteRequestOf(entry);
        if (request !== undefined) {
            absenceRequests.push(request);
        }
    }
    const passOne = allocateInto([...presenceRequests, ...absenceRequests]);
    if ("error" in passOne) {
        return passOne;
    }
    for (const record of passOne.publication.records) {
        if (!isValueEvent(record)) {
            continue;
        }
        valueIds.set(nodeKeyToCanonicalString(record.node), record.id);
    }
    /** @type {Map<string, NodeKey>} */
    const targetNodes = new Map();
    for (const occurrence of target.occurrences) {
        if (!valueIds.has(occurrence.nodeKeyString)) {
            return {
                error: makeJournalProjectionError(
                    "the target-present node has no settled occurrence",
                    occurrence.nodeKeyString
                ),
            };
        }
        targetNodes.set(occurrence.nodeKeyString, occurrence.nodeKey);
    }
    /**
     * @param {string} nodeKeyString
     * @returns {NodeKey | undefined}
     */
    const nodeKeyOf = (nodeKeyString) => targetNodes.get(nodeKeyString);
    /**
     * The target-present occurrences reset settled on, as an ordered view over the
     * source's committed projection rather than as one collection.
     * @returns {Generator<ResetTargetOccurrence>}
     */
    const targetOccurrences = function* occurrences() {
        for (const occurrence of target.occurrences) {
            const valueId = valueIds.get(occurrence.nodeKeyString);
            if (valueId === undefined) {
                continue;
            }
            yield {
                nodeKeyString: occurrence.nodeKeyString,
                nodeKey: occurrence.nodeKey,
                valueId,
                nodeIdentifier: occurrence.nodeIdentifier,
                payload: occurrence.payload,
                createdAt: occurrence.createdAt,
                modifiedAt: occurrence.modifiedAt,
                validInputs: occurrence.validInputs,
                fresh: occurrence.fresh,
            };
        }
    };

    // ---- Pass 2: target validity and proof -------------------------------
    // The union is a count read, not a fold: the retained state already holds the
    // imported and Pass 1 records, and its selected occurrences are the ones Pass 1
    // settled, so nothing below revisits retained certificate history.
    const unions = eligibleEffectiveProofUnion({
        summary: retainedState.proofs,
        targetOccurrences: [...targetOccurrences()],
        authorOf: authorLookupOf(retainedState),
    });
    const barriers = planProofBarriers({
        targetOccurrences: targetOccurrences(),
        unions,
        nodeKeyOf,
    });
    if ("error" in barriers) {
        return barriers;
    }
    const barrierPublication = allocateInto(barriers.barriers);
    if ("error" in barrierPublication) {
        return barrierPublication;
    }
    const afterBarriers = cut();
    if ("error" in afterBarriers) {
        return afterBarriers;
    }

    const validations = planTargetValidations({
        postBarrier: afterBarriers,
        targetOccurrences: targetOccurrences(),
        resetValueIdOf: (nodeKeyString) => valueIds.get(nodeKeyString),
        nodeKeyOf,
        currentInputKeysOfNode,
    });
    if ("error" in validations) {
        return validations;
    }
    const validationPublication = allocateInto(validations.requests);
    if ("error" in validationPublication) {
        return validationPublication;
    }
    const afterValidations = cut();
    if ("error" in afterValidations) {
        return afterValidations;
    }

    // ---- Pass 3: target freshness ----------------------------------------
    const selectedOccurrences = selectedOccurrencesOf(retainedState);
    const markers = planFreshnessMarkers({
        postValidation: afterValidations,
        targetOccurrences: targetOccurrences(),
        hasUncoveredValueInvalidation: (nodeKeyString) => {
            const occurrence = selectedOccurrences.get(nodeKeyString);
            const freshness = afterValidations.freshness.get(nodeKeyString);
            return hasUncoveredValueInvalidationOf(
                invalidationSummaryOf(
                    retainedState,
                    nodeKeyString,
                    occurrence === undefined ? undefined : occurrence.valueId
                ),
                freshness === undefined ? undefined : freshness.certificate,
                authorLookupOf(retainedState)
            );
        },
    });
    const markerPublication = allocateInto(markers.requests);
    if ("error" in markerPublication) {
        return markerPublication;
    }
    const final = cut();
    if ("error" in final) {
        return final;
    }

    const mismatch = verifyTargetEquivalence(final, targetOccurrences());
    if (mismatch !== undefined) {
        return { error: mismatch };
    }

    return {
        outcome: new ResetOutcomeClass(
            [...imported, ...authored],
            new ResetPublicationClass(authored, state),
            final,
            valueIds,
            imported.length > 0 || authored.length > 0,
            retainedState
        ),
    };
}

module.exports = {
    ResetOutcomeClass,
    isResetOutcome,
    resetToSource,
};