/**
 * The canonical-bootstrap path of the Journal 3 pre-Journal boundary.
 *
 * This module is the only import point of the `journal/bootstrap` subfolder. It
 * owns the three normative pieces of `incremental-graph-journal-migrations.md`
 * Part I which precede and arbitrate the canonical cut:
 *
 * - `readLegacyBootstrapState` is the supported pre-Journal source boundary (§1):
 *   a replica is read once into a validated state, or the whole source is rejected
 *   before any history is authored;
 * - `makeCanonicalBootstrapSnapshot` holds the immutable original bootstrap cut
 *   (§3), and `artifactSupportsBootstrapTarget` admits it only on exact equality
 *   with the running release's configured bootstrap target;
 * - `makeCohortBootstrapSource` and `arbitrateCanonicalBootstrap` are the
 *   transport-neutral source and its §4 conditional-publication arbitration, where
 *   publication, not the query, selects the one durable cohort artifact; and
 * - `stageCanonicalBootstrap` is the deterministic staging of passes C1–C4 (§5),
 *   which is what §6 retries when a publication outcome is still unknown;
 * - `resumeCanonicalBootstrapCreator` is the §6 creator-resume consumer, which
 *   installs a replica's own canonical cut once replaying it reproduces
 *   still-persisted legacy semantics; and
 * - `joinCanonicalBootstrap` is the §7 joining consumer, which merges a second
 *   replica's persisted pre-Journal graph with the cohort's frozen canonical cut
 *   through passes J1, J2, J2b and J3.
 *
 * Everything here is pure. Nothing performs I/O, mints an identifier, or consults
 * a clock; a transport is supplied by the caller through `makeCohortBootstrapSource`.
 */

const { isLegacyBootstrapState, isLegacyNode, readLegacyBootstrapState } = require("./legacy_state");
const {
    artifactSupportsBootstrapTarget,
    canonicalArtifactReplica,
    isCanonicalBootstrapSnapshot,
    makeCanonicalBootstrapSnapshot,
} = require("./canonical_artifact");
const {
    isCanonicalBootstrapCandidate,
    stageCanonicalBootstrap,
} = require("./canonical_candidate");
const {
    deriveLegacyFreshness,
    isResumedCanonicalCreator,
    resumeCanonicalBootstrapCreator,
} = require("./creator_resume");
const {
    isJoinedCanonicalBootstrap,
    joinCanonicalBootstrap,
} = require("./join_bootstrap");
const {
    arbitrateCanonicalBootstrap,
    isCanonicalBootstrapDefinitelyAbsent,
    isCanonicalBootstrapExists,
    isCanonicalBootstrapIndeterminate,
    isCohortBootstrapSource,
    makeCohortBootstrapSource,
    observeCanonicalBootstrap,
    observeCanonicalBootstrapPublication,
    publishedArtifactIsStagedCandidate,
    publishCanonicalBootstrap,
    queryCanonicalBootstrap,
} = require("./cohort_source");

/** @typedef {import('./legacy_state').LegacyBootstrapState} LegacyBootstrapState */
/** @typedef {import('./legacy_state').LegacyNode} LegacyNode */
/** @typedef {import('./canonical_artifact').BootstrapTarget} BootstrapTarget */
/** @typedef {import('./canonical_artifact').CanonicalBootstrapSnapshot} CanonicalBootstrapSnapshot */
/** @typedef {import('./canonical_artifact').CanonicalBootstrapSnapshotRequest} CanonicalBootstrapSnapshotRequest */
/** @typedef {import('./canonical_candidate').CanonicalBootstrapCandidate} CanonicalBootstrapCandidate */
/** @typedef {import('./canonical_candidate').CanonicalBootstrapRequest} CanonicalBootstrapRequest */
/** @typedef {import('./cohort_source').CanonicalBootstrapOutcome} CanonicalBootstrapOutcome */
/** @typedef {import('./cohort_source').CanonicalBootstrapPublicationResult} CanonicalBootstrapPublicationResult */
/** @typedef {import('./cohort_source').CohortBootstrapSource} CohortBootstrapSource */
/** @typedef {import('./cohort_source').ArbitrationRequest} ArbitrationRequest */
/** @typedef {import('./creator_resume').CreatorResumeRequest} CreatorResumeRequest */
/** @typedef {import('./creator_resume').ResumedCanonicalCreator} ResumedCanonicalCreator */
/** @typedef {import('./join_bootstrap').JoinCanonicalBootstrapRequest} JoinCanonicalBootstrapRequest */
/** @typedef {import('./join_bootstrap').JoinedCanonicalBootstrap} JoinedCanonicalBootstrap */

module.exports = {
    arbitrateCanonicalBootstrap,
    artifactSupportsBootstrapTarget,
    canonicalArtifactReplica,
    deriveLegacyFreshness,
    isJoinedCanonicalBootstrap,
    isResumedCanonicalCreator,
    joinCanonicalBootstrap,
    isCanonicalBootstrapCandidate,
    isCanonicalBootstrapDefinitelyAbsent,
    isCanonicalBootstrapExists,
    isCanonicalBootstrapIndeterminate,
    isCanonicalBootstrapSnapshot,
    isCohortBootstrapSource,
    isLegacyBootstrapState,
    isLegacyNode,
    makeCanonicalBootstrapSnapshot,
    makeCohortBootstrapSource,
    observeCanonicalBootstrap,
    observeCanonicalBootstrapPublication,
    publishedArtifactIsStagedCandidate,
    publishCanonicalBootstrap,
    queryCanonicalBootstrap,
    readLegacyBootstrapState,
    resumeCanonicalBootstrapCreator,
    stageCanonicalBootstrap,
};