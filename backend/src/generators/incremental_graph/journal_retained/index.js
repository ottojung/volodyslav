/**
 * The retained replay state both reset and synchronization fold their delta into.
 *
 * This module is the only import point of `journal_retained`. A caller outside this
 * subfolder reaches the retained state through the counted proof summary it holds,
 * the staging fold which extends it, the delta projection each named cut is read
 * at, and the maintenance traversal which reconstructs it. Nothing else in this
 * subfolder is reachable, so a caller cannot read a cut without staging the records
 * that reached it.
 *
 * `incremental-graph-journal-storage.md` §Change-bounded proof summary requires
 * imported and reset-authored records to update a staged summary before cutover,
 * and names `reset`/`synchronization`/routine open as the operations which must not
 * fall back to scanning retained history to obtain it. The state this subfolder
 * holds is that summary together with the head selection and the previous cut's
 * resolution, and it belongs to both of those operations because both of them
 * extend it by exactly the records they admit or author.
 */

/** @typedef {import('./proof_summary').CurrentInputKeysOfNode} CurrentInputKeysOfNode */
/** @typedef {import('./proof_summary').ProofSummary} ProofSummary */
/** @typedef {import('./retained').RetainedReplayState} RetainedReplayState */

const {
    ProofSummaryClass,
    buildProofSummary,
    countEligibleProofEdges,
    eligibleProofEdgeUnion,
    invalidationViewOf,
    isProofSummary,
    selectOccurrences,
    stageAdmittedRecords,
} = require("./proof_summary");
const {
    RetainedReplayStateClass,
    admitRetainedHead,
    authorLookupOf,
    invalidationSummaryOf,
    isRetainedReplayState,
    projectRetainedReplay,
    selectedHeadsOf,
    selectedOccurrencesOf,
    stageRetainedRecords,
} = require("./retained");
const { buildRetainedReplayState } = require("./retained_maintenance");
const { refuseStaleRetainedState } = require("./correspondence");
const { commitRetainedReplayState, forkRetainedReplayState } = require("./transaction");

module.exports = {
    ProofSummaryClass,
    RetainedReplayStateClass,
    admitRetainedHead,
    authorLookupOf,
    buildProofSummary,
    buildRetainedReplayState,
    refuseStaleRetainedState,
    commitRetainedReplayState,
    forkRetainedReplayState,
    countEligibleProofEdges,
    eligibleProofEdgeUnion,
    invalidationSummaryOf,
    invalidationViewOf,
    isProofSummary,
    isRetainedReplayState,
    projectRetainedReplay,
    selectedHeadsOf,
    selectedOccurrencesOf,
    selectOccurrences,
    stageAdmittedRecords,
    stageRetainedRecords,
};