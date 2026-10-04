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
 * Nothing here is a whole-journal materialisation. Import reads one missing suffix
 * at a time, the raw head view is a running maximum per node, and each pass is
 * graph-sized work over the reset domain, which `reset.md` §Streamability permits.
 */

/** @typedef {import('../journal/errors').AnyJournalError} JournalError */
/** @typedef {import('../journal/emission').CommittedWriterState} CommittedWriterState */
/** @typedef {import('../journal/records').JournalRecord} JournalRecord */
/** @typedef {import('../journal/types').AuthorityTime} AuthorityTime */
/** @typedef {import('../journal/types').JournalAuthor} JournalAuthor */
/** @typedef {import('../journal/types').JournalRecordId} JournalRecordId */
/** @typedef {import('../journal/types').NodeKey} NodeKey */
/** @typedef {import('../journal/oracle/projection').ProjectedOccurrence} ProjectedOccurrence */
/** @typedef {import('../journal/oracle/record_source').JournalSource} JournalSource */
/** @typedef {import('../journal/oracle/projection').Projection} Projection */
/** @typedef {import('../journal_sync').SnapshotIdentity} SnapshotIdentity */
/** @typedef {import('./authoring').ResetPublication} ResetPublication */
/** @typedef {import('./authoring').ResetRequest} ResetRequest */
/** @typedef {import('./pass1').ResetValueId} ResetValueId */
/** @typedef {import('./pass2').ResetTargetOccurrence} ResetTargetOccurrence */
/** @typedef {import('./proof_summary').ProofSummary} ProofSummary */
/** @typedef {import('./source').ResetSource} ResetSource */

const {
    isJournalError,
    isValueEvent,
    journalRecordIdToString,
    makeJournalProjectionError,
    selectSemanticHeads,
    summarizeInvalidations,
} = require("../journal");
const { assertCompatibleIdentity, planForeignSuffixImport } = require("../journal_sync");
const {
    authorLookupOf,
    extendWithOwnRange,
    observedUnion,
    occurrencesByKey,
    projectCut,
    selectedOccurrencesOf,
} = require("./cuts");
const { finalizeResetRecords, ResetPublicationClass } = require("./authoring");
const { planResetDomain, resetRequestsOf } = require("./pass1");
const {
    eligibleEffectiveProofUnion,
    planProofBarriers,
    planTargetValidations,
    sameEdgeSet,
} = require("./pass2");
const { hasUncoveredValueInvalidationOf, planFreshnessMarkers } = require("./pass3");
const {
    isProofSummary,
    selectOccurrences,
    stageAdmittedRecords,
} = require("./proof_summary");

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
 * - `proofSummary` is the counted proof summary of `Jreset`, which the
 *   persistence front stages with the records and cuts over with them, because
 *   `incremental-graph-journal-storage.md` §Change-bounded proof summary requires
 *   imported and reset-authored records to update a staged summary before cutover.
 *
 * The proof of those properties is guaranteed by:
 * - `resetToSource(...)`: it appends each imported record without touching it,
 *   appends only what `finalizeResetRecords` allocated, takes `projection` from a
 *   `projectRetainedJournal` over exactly those records, and derives `changed` from
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
 * @param {ProofSummary} proofSummary
 */
class ResetOutcomeClass {
    /**
     * @param {ReadonlyArray<JournalRecord>} records
     * @param {ResetPublication} publication
     * @param {Projection} projection
     * @param {Map<string, ResetValueId>} valueIds
     * @param {boolean} changed
     * @param {ProofSummary} proofSummary
     */
    constructor(records, publication, projection, valueIds, changed, proofSummary) {
        this.records = records;
        this.publication = publication;
        this.projection = projection;
        this.valueIds = valueIds;
        this.changed = changed;
        this.proofSummary = proofSummary;
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
 * @property {ProofSummary} proofSummary - The receiver's retained counted proof
 *   summary, which `incremental-graph-journal-storage.md` §Change-bounded proof
 *   summary requires the activated replica to maintain and which reset updates as
 *   it admits records. Reset refuses a missing summary rather than deriving the
 *   union by scanning retained history.
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
        proofSummary,
    } = request;

    if (!isProofSummary(proofSummary)) {
        return {
            error: makeJournalProjectionError(
                "reset requires the receiver's counted proof summary and does not fall back " +
                    "to scanning retained certificate history",
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
    let journal = observedUnion({ receiver, plan });

    // The raw maintenance view. `project(J0)` is deliberately not taken: two valid
    // replicas can have a compatible union whose cross-authority winners are not
    // dependency-closed, and Pass 1 is what repairs that.
    const rawHeads = selectSemanticHeads(journal);
    if ("error" in rawHeads) {
        return rawHeads;
    }

    const target = source.projection;
    const domain = planResetDomain({ selections: rawHeads.selections, target });

    // The receiver's retained summary, updated as this reset admits records.
    const summary = proofSummary;
    stageAdmittedRecords({ summary, records: imported });

    /** @type {JournalRecord[]} */
    const authored = [];
    /** @type {CommittedWriterState} */
    let state = committed;
    /**
     * Allocate one pass's records as the next contiguous own-writer range, extend
     * the journal with exactly that range, or report the failure which stopped it.
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
        const extended = extendWithOwnRange(journal, localWriter, allocated.records);
        if (isJournalError(extended)) {
            return { error: extended };
        }
        journal = extended;
        authored.push(...allocated.records);
        state = allocated.writerState;
        return { publication: allocated };
    };

    /**
     * Project the journal the passes have reached so far.
     * @returns {Projection | {error: JournalError}}
     */
    const project = () => projectCut(journal, localWriter, currentInputKeysOfNode);

    // ---- Pass 1: target presence and value occurrences -------------------
    const passOne = allocateInto(resetRequestsOf(domain));
    if ("error" in passOne) {
        return passOne;
    }
    const p1 = project();
    if ("error" in p1) {
        return p1;
    }
    selectOccurrences({ summary, occurrences: selectedOccurrencesOf(p1) });

    /** @type {Map<string, ResetValueId>} */
    const valueIds = new Map();
    /** @type {number} */
    let nextValueRecord = 0;
    for (const nodeKeyString of domain.keys) {
        const request = domain.values.get(nodeKeyString);
        if (request === undefined) {
            const selection = rawHeads.selections.get(nodeKeyString);
            const winner = selection === undefined ? undefined : selection.winner;
            if (winner !== undefined && isValueEvent(winner)) {
                valueIds.set(nodeKeyString, winner.id);
            }
            continue;
        }
        const record = passOne.publication.records[nextValueRecord];
        nextValueRecord += 1;
        if (record === undefined) {
            return {
                error: makeJournalProjectionError(
                    "Pass 1 authored fewer occurrences than it planned",
                    nodeKeyString
                ),
            };
        }
        valueIds.set(nodeKeyString, record.id);
    }

    /** @type {ResetTargetOccurrence[]} */
    const targetOccurrences = [];
    /** @type {Map<string, ResetTargetOccurrence>} */
    const targetOccurrenceByKey = new Map();
    for (const occurrence of target.occurrences) {
        const valueId = valueIds.get(occurrence.nodeKeyString);
        if (valueId === undefined) {
            return {
                error: makeJournalProjectionError(
                    "the target-present node has no settled occurrence",
                    occurrence.nodeKeyString
                ),
            };
        }
        const settled = {
            nodeKeyString: occurrence.nodeKeyString,
            nodeKey: occurrence.nodeKey,
            valueId,
            validInputs: occurrence.validInputs,
            fresh: occurrence.fresh,
        };
        targetOccurrences.push(settled);
        targetOccurrenceByKey.set(occurrence.nodeKeyString, settled);
    }

    /**
     * @param {string} nodeKeyString
     * @returns {NodeKey | undefined}
     */
    const nodeKeyOf = (nodeKeyString) => {
        const occurrence = targetOccurrenceByKey.get(nodeKeyString);
        return occurrence === undefined ? undefined : occurrence.nodeKey;
    };

    // ---- Pass 2: target validity and proof -------------------------------
    // The union is a count read, not a fold: the summary already holds the
    // imported and Pass 1 records, and its selected occurrences are the ones Pass 1
    // settled, so nothing below revisits retained certificate history.
    const unions = eligibleEffectiveProofUnion({
        summary,
        targetOccurrences,
        authorOf: authorLookupOf(journal),
    });
    const barriers = planProofBarriers({
        targetOccurrences,
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
    const afterBarriers = project();
    if ("error" in afterBarriers) {
        return afterBarriers;
    }

    const validations = planTargetValidations({
        postBarrier: afterBarriers,
        targetOccurrences,
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
    stageAdmittedRecords({ summary, records: barrierPublication.publication.records });
    stageAdmittedRecords({ summary, records: validationPublication.publication.records });
    const afterValidations = project();
    if ("error" in afterValidations) {
        return afterValidations;
    }

    // ---- Pass 3: target freshness ----------------------------------------
    const summariesAfterValidations = summarizeInvalidations(
        journal,
        selectedOccurrencesOf(afterValidations)
    );
    if ("error" in summariesAfterValidations) {
        return summariesAfterValidations;
    }
    const authorOf = authorLookupOf(journal);
    const markers = planFreshnessMarkers({
        postValidation: afterValidations,
        targetOccurrences,
        hasUncoveredValueInvalidation: (nodeKeyString) => {
            const freshness = afterValidations.freshness.get(nodeKeyString);
            return hasUncoveredValueInvalidationOf(
                summariesAfterValidations.summaries,
                freshness === undefined ? undefined : freshness.certificate,
                nodeKeyString,
                authorOf
            );
        },
    });
    const markerPublication = allocateInto(markers.requests);
    if ("error" in markerPublication) {
        return markerPublication;
    }
    stageAdmittedRecords({ summary, records: markerPublication.publication.records });
    const final = project();
    if ("error" in final) {
        return final;
    }
    selectOccurrences({ summary, occurrences: selectedOccurrencesOf(final) });

    const mismatch = verifyTargetEquivalence(final, targetOccurrences);
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
            summary
        ),
    };
}

/**
 * Does the committed result equal the requested target semantic graph?
 *
 * The comparison is exactly the reset theorem's: present keys, payloads,
 * identifiers, timestamps, freshness and validity edges. ValueIds are excluded,
 * because reset preserves the union's occurrence whenever it already has the
 * target's immutable occurrence state.
 *
 * @param {Projection} final
 * @param {ReadonlyArray<ResetTargetOccurrence>} targetOccurrences
 * @returns {JournalError | undefined}
 */
function verifyTargetEquivalence(final, targetOccurrences) {
    const finalByKey = occurrencesByKey(final);
    for (const occurrence of targetOccurrences) {
        const committed = finalByKey.get(occurrence.nodeKeyString);
        if (committed === undefined) {
            return makeJournalProjectionError(
                "the committed result does not contain a target-present node",
                occurrence.nodeKeyString
            );
        }
        if (journalRecordIdToString(committed.valueId) !== journalRecordIdToString(occurrence.valueId)) {
            return makeJournalProjectionError(
                "the committed occurrence is not the occurrence reset settled on",
                occurrence.nodeKeyString
            );
        }
        if (!sameEdgeSet(committed.validInputs, occurrence.validInputs)) {
            return makeJournalProjectionError(
                "the committed validity edges are not the target's",
                occurrence.nodeKeyString
            );
        }
        if (committed.fresh !== occurrence.fresh) {
            return makeJournalProjectionError(
                "the committed freshness is not the target's",
                occurrence.nodeKeyString
            );
        }
    }
    return undefined;
}

module.exports = {
    ResetOutcomeClass,
    isResetOutcome,
    resetToSource,
};