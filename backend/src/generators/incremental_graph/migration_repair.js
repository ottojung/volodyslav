/**
 * Passes M2 and M3 of Journal-aware migration: target proof and persistent
 * freshness.
 *
 * `incremental-graph-journal-migrations.md` §9 makes the migration target's graph
 * state a projection of the retained history the cutover builds. M1 authors the
 * target's value occurrences and absence; M2 (§16) authors the proof which makes
 * replay derive the target's validity edges, and M3 (§17) authors the persistent
 * markers which make replay derive the target's staleness. Without them the graph
 * state the cutover writes and the retained history disagree about exactly those
 * two facts, which `migration_verification.js` names.
 *
 * The passes are the specification's, in its order, because each one's cut is the
 * next one's input: M2 reads `eligibleEffectiveProofUnion_P1(K)` at the fixed
 * post-M1 cut and authors barriers before target certificates, and M3 reads the
 * post-certificate cut. `migration_repair_plan.js` owns the planning; this module
 * owns the pass order and the allocation, and performs everything up to but
 * excluding the persistence write.
 */

/** @typedef {import('./journal/errors').AnyJournalError} JournalError */
/** @typedef {import('./journal/emission').CommittedWriterState} CommittedWriterState */
/** @typedef {import('./journal/records').JournalRecord} JournalRecord */
/** @typedef {import('./journal/types').JournalAuthor} JournalAuthor */
/** @typedef {import('./journal/types').NodeKey} NodeKey */
/** @typedef {import('./database/graph_scheme').GraphScheme} GraphScheme */
/** @typedef {import('./database/identifier_lookup').IdentifierLookup} IdentifierLookup */
/** @typedef {import('./database/types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./journal/migration_emission').MigrationRepairIntent} MigrationRepairIntent */

const {
    finalizeMigrationRepair,
    journalRecordIdToString,
    makeReplicaSource,
} = require("./journal");
const { deserializeNodeKey, stringToNodeKeyString } = require("./database");
const {
    authorLookupOf,
    buildRetainedReplayState,
    eligibleProofEdgeUnion,
    invalidationSummaryOf,
    projectRetainedReplay,
    selectedOccurrencesOf,
    stageRetainedRecords,
} = require("./journal_retained");
const { readRetainedJournal } = require("./journal_store");
const {
    hasUncoveredValueInvalidationOf,
    makeCurrentInputKeysOfNode,
    planFreshnessMarkers,
    planProofBarriers,
    planTargetValidations,
    targetOccurrencesOf,
} = require("./migration_repair_plan");

/**
 * Build the target replica's M2/M3 repair records over its already-converted and
 * M1-extended history.
 *
 * @param {object} request
 * @param {import('./database/root_database').SchemaStorage} request.targetStorage
 * @param {GraphScheme} request.graphScheme
 * @param {IdentifierLookup} request.targetLookup
 * @param {JournalAuthor} request.localWriter
 * @param {Map<NodeIdentifier, NodeIdentifier[]>} request.desiredValid
 * @param {Map<NodeIdentifier, import('./database/types').Freshness>} request.targetFreshness
 * @param {CommittedWriterState} request.state - The committed state the M1 publication left.
 * @param {number} request.publicationInstant
 * @returns {Promise<{records: ReadonlyArray<JournalRecord>, writerState: CommittedWriterState} | {error: JournalError}>}
 */
async function repairMigrationJournal(request) {
    const {
        targetStorage,
        graphScheme,
        targetLookup,
        localWriter,
        desiredValid,
        targetFreshness,
        publicationInstant,
    } = request;
    let state = request.state;
    const currentInputKeysOfNode = makeCurrentInputKeysOfNode(graphScheme);

    const retained = await readRetainedJournal(targetStorage.journal);
    if (retained instanceof Error) {
        return { error: retained };
    }
    const built = buildRetainedReplayState({
        source: makeReplicaSource(retained),
        localWriter,
        currentInputKeysOfNode,
    });
    if ("error" in built) {
        return { error: built.error };
    }
    const retainedState = built.state;

    /** @type {JournalRecord[]} */
    const authored = [];
    /**
     * @param {string} nodeKeyString
     * @returns {NodeKey | undefined}
     */
    const nodeKeyOf = (nodeKeyString) => {
        try {
            return deserializeNodeKey(stringToNodeKeyString(nodeKeyString));
        } catch {
            return undefined;
        }
    };

    /**
     * @param {ReadonlyArray<MigrationRepairIntent>} requests
     * @returns {JournalError | undefined}
     */
    const applyRepair = (requests) => {
        const finalized = finalizeMigrationRepair({ state, requests, publicationInstant });
        if (finalized instanceof Error) {
            return finalized;
        }
        if (finalized.records.length > 0) {
            stageRetainedRecords(retainedState, finalized.records);
            authored.push(...finalized.records);
            state = finalized.writerState;
        }
        return undefined;
    };

    const projection = projectRetainedReplay(retainedState);
    if ("error" in projection) {
        return { error: projection.error };
    }
    const occurrences = targetOccurrencesOf(projection, targetLookup, desiredValid, targetFreshness);
    const authorOf = authorLookupOf(retainedState);

    // ---- Pass M2: target validity and proof ---------------------------------
    const unions = new Map();
    for (const occurrence of occurrences) {
        unions.set(
            occurrence.nodeKeyString,
            eligibleProofEdgeUnion({
                summary: retainedState.proofs,
                nodeKeyString: occurrence.nodeKeyString,
                valueId: journalRecordIdToString(occurrence.valueId),
                authorOf,
            })
        );
    }
    const barriers = planProofBarriers({ targetOccurrences: occurrences, unions, nodeKeyOf });
    if ("error" in barriers) {
        return { error: barriers.error };
    }
    const barrierFailure = applyRepair(barriers);
    if (barrierFailure !== undefined) {
        return { error: barrierFailure };
    }
    const afterBarriers = projectRetainedReplay(retainedState);
    if ("error" in afterBarriers) {
        return { error: afterBarriers.error };
    }
    const selected = selectedOccurrencesOf(retainedState);
    const validations = planTargetValidations({
        postBarrier: afterBarriers,
        targetOccurrences: occurrences,
        valueIdOf: (nodeKeyString) => {
            const occurrence = selected.get(nodeKeyString);
            return occurrence === undefined ? undefined : occurrence.valueId;
        },
        nodeKeyOf,
        currentInputKeysOfNode,
    });
    if ("error" in validations) {
        return { error: validations.error };
    }
    const validationFailure = applyRepair(validations);
    if (validationFailure !== undefined) {
        return { error: validationFailure };
    }
    const afterValidations = projectRetainedReplay(retainedState);
    if ("error" in afterValidations) {
        return { error: afterValidations.error };
    }

    // ---- Pass M3: persistent target freshness -------------------------------
    const markers = planFreshnessMarkers({
        postValidation: afterValidations,
        targetOccurrences: occurrences,
        hasUncoveredValueInvalidation: (nodeKeyString, valueId) => {
            const freshness = afterValidations.freshness.get(nodeKeyString);
            return hasUncoveredValueInvalidationOf(
                invalidationSummaryOf(retainedState, nodeKeyString, valueId),
                freshness === undefined ? undefined : freshness.certificate,
                authorOf
            );
        },
    });
    const markerFailure = applyRepair(markers);
    if (markerFailure !== undefined) {
        return { error: markerFailure };
    }

    return { records: authored, writerState: state };
}

module.exports = {
    repairMigrationJournal,
};
