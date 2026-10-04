/**
 * The oracle subfolder's encapsulation point.
 *
 * Everything here is a pure function over a `JournalSource` and an in-memory
 * current schema. There is no persistence, no lifecycle, no locking, and no
 * path which materialises the retained journal.
 *
 * The surface has three groups:
 *
 * - `projectRetainedJournal` and the source constructors, which are how a caller
 *   projects a retained journal at all.
 * - the individual passes, which exist so an instrumented streaming test can
 *   drive one pass at a time and assert the shape of its work, and so a future
 *   persistence front can reuse a pass without re-deriving it.
 * - the guards for the values those passes return.
 *
 * The helpers inside a pass stay private, so a caller cannot reach past a pass
 * and reimplement part of it.
 */

const {
    makeReplicaSource,
    makeUnionSource,
    readerOverIterable,
    successorJournalSequence,
} = require("./record_source");
const { streamEveryRecord, streamWithReport, validateContextClaim } = require("./scan");
const { isPresent, selectSemanticHeads, selectedValueId } = require("./heads");
const { isInvalidationSummary, summarizeInvalidations, summaryIsCovered } = require("./invalidations");
const {
    effectiveInputsOf,
    isEligibleCertificate,
    isSelectedCertificate,
    selectCertificates,
} = require("./certificates");
const {
    deriveFreshness,
    edgeValid,
    isNodeFreshness,
    isProjection,
    selfProofReady,
    validateDependencyClosure,
    validateNodeIdentifierDistinctness,
} = require("./projection");
const { projectRetainedJournal, readContextAndWatermark } = require("./project");

module.exports = {
    deriveFreshness,
    effectiveInputsOf,
    edgeValid,
    isEligibleCertificate,
    isInvalidationSummary,
    isNodeFreshness,
    isPresent,
    isProjection,
    isSelectedCertificate,
    makeReplicaSource,
    makeUnionSource,
    projectRetainedJournal,
    readContextAndWatermark,
    readerOverIterable,
    selectCertificates,
    selectSemanticHeads,
    selectedValueId,
    selfProofReady,
    streamEveryRecord,
    streamWithReport,
    successorJournalSequence,
    summarizeInvalidations,
    summaryIsCovered,
    validateContextClaim,
    validateDependencyClosure,
    validateNodeIdentifierDistinctness,
};
