/**
 * The configured transport-neutral `CohortBootstrapSource` and the §4
 * publication arbitration, `incremental-graph-journal-migrations.md` §4.
 *
 * §4 makes conditional publication, not the query, the arbitration point: for one
 * cohort canonical slot, concurrent distinct candidates cannot both obtain
 * `Published`. So this module keeps the two source operations apart, normalizes
 * each transport result into exactly one of the three specified variants, and
 * never lets a query result alone make a candidate canonical.
 *
 * The variants are nominal values with proofs of their own:
 *
 * - `Exists` carries an artifact already validated by
 *   `makeCanonicalBootstrapSnapshot`, so holding it is enough to proceed;
 * - `DefinitelyAbsent` can only be produced by a source that answered, and it is
 *   explicitly **not** permission to cut over: §4.2 still requires
 *   `publishCanonicalBootstrapIfAbsent`;
 * - `IndeterminateOrError` is the fail-closed variant, and it is also what any
 *   unrecognized transport result becomes, because a source which cannot be
 *   understood must not be treated as an absence.
 *
 * `arbitrateCanonicalBootstrap` is the whole decision procedure: it runs the query,
 * admits or fails on the held artifact's target, stages a deterministic candidate
 * when the cohort slot is free, publishes it conditionally, validates that the
 * publication result is the published form of that staged candidate, and returns
 * an outcome whose variant states exactly what startup may do next. It performs no
 * local cutover and no legacy mutation itself: §4.3 requires that the supported
 * pre-Journal database stays the persisted active state until a durable artifact
 * has been selected.
 *
 * This module is pure with respect to the source: it awaits exactly the two source
 * operations and touches no clock, no database and no transport of its own.
 */

const {
    isJournalError,
    makeJournalBootstrapForkError,
    makeJournalPublicationError,
} = require("../errors");
const { isPlainRecord } = require("../record_fields");
const { journalAuthorToString } = require("../types");
const { canonicalRecordBody } = require("../codec");
const {
    artifactSupportsBootstrapTarget,
    isCanonicalBootstrapSnapshot,
} = require("./canonical_artifact");
const { isCanonicalBootstrapCandidate } = require("./canonical_candidate");

/** @typedef {import('../errors').AnyJournalError} JournalError */
/** @typedef {import('../types').JournalAuthor} JournalAuthor */
/** @typedef {import('./canonical_artifact').BootstrapTarget} BootstrapTarget */
/** @typedef {import('./canonical_artifact').CanonicalBootstrapSnapshot} CanonicalBootstrapSnapshot */
/** @typedef {import('./canonical_candidate').CanonicalBootstrapCandidate} CanonicalBootstrapCandidate */
/** @typedef {import('./canonical_candidate').CanonicalBootstrapRequest} CanonicalBootstrapRequest */

/**
 * `queryCanonicalBootstrap()` answered `Exists`.
 *
 * The properties that this class carries are:
 * - `artifact` is a validated immutable canonical cut whose bootstrap frontier is a
 *   function of its own records.
 *
 * The proof of those properties is guaranteed by:
 * - `observeCanonicalBootstrap(raw)`: produces this variant only from a value
 *   accepted by `isCanonicalBootstrapSnapshot`, which holds only for the frozen
 *   instances built by `makeCanonicalBootstrapSnapshot`.
 * - `publishCanonicalBootstrap(source, candidate)`: produces this variant only from
 *   such an artifact, whether the transport reported `published` or
 *   `already-exists`.
 *
 * @param {CanonicalBootstrapSnapshot} artifact
 */
class CanonicalBootstrapExistsClass {
    /**
     * @param {CanonicalBootstrapSnapshot} artifact
     */
    constructor(artifact) {
        this.artifact = artifact;
        Object.freeze(this);
    }
}

/** @typedef {CanonicalBootstrapExistsClass} CanonicalBootstrapExists */

/**
 * @param {unknown} value
 * @returns {value is CanonicalBootstrapExists}
 */
function isCanonicalBootstrapExists(value) {
    return value instanceof CanonicalBootstrapExistsClass;
}

/**
 * `queryCanonicalBootstrap()` answered `DefinitelyAbsent`.
 *
 * The properties that this class carries are:
 * - the cohort canonical slot is free at the moment of the query, and
 * - this value grants no permission to cut over: §4.2 requires a conditional
 *   publication even after an absence.
 *
 * The proof of those properties is guaranteed by:
 * - `observeCanonicalBootstrap(raw)`: produces this variant only from the explicit
 *   `null` absence token, which is neither an artifact nor a failure.
 *
 * @extends {undefined}
 */
class CanonicalBootstrapDefinitelyAbsentClass {
    /**
     * @returns {never}
     */
    delete() {
        throw new Error("CanonicalBootstrapDefinitelyAbsent is immutable");
    }

    /**
     * @returns {never}
     */
    clear() {
        throw new Error("CanonicalBootstrapDefinitelyAbsent is immutable");
    }
}

/** @typedef {CanonicalBootstrapDefinitelyAbsentClass} CanonicalBootstrapDefinitelyAbsent */

/** The one canonical artifact for the cohort was published by this attempt. */
const DEFINITELY_ABSENT = new CanonicalBootstrapDefinitelyAbsentClass();
Object.freeze(DEFINITELY_ABSENT);

/**
 * @param {unknown} value
 * @returns {value is CanonicalBootstrapDefinitelyAbsent}
 */
function isCanonicalBootstrapDefinitelyAbsent(value) {
    return value instanceof CanonicalBootstrapDefinitelyAbsentClass;
}

/**
 * The publication or query outcome is unknown or failed.
 *
 * The properties that this class carries are:
 * - the cohort slot's durable state is **not** known, so startup must fail and
 *   must not create competing canonical history or publish another distinct
 *   artifact.
 *
 * The proof of those properties is guaranteed by:
 * - `observeCanonicalBootstrap(raw)` and `observeCanonicalBootstrapPublication(raw)`:
 *   every unrecognized transport result, every thrown value and every failure the
 *   transport reports as an error becomes this variant, so no path through this
 *   module can read an unknown outcome as an absence or as a selection.
 *
 * @param {string} detail
 */
class CanonicalBootstrapIndeterminateClass {
    /**
     * @param {string} detail
     */
    constructor(detail) {
        this.detail = detail;
        Object.freeze(this);
    }
}

/** @typedef {CanonicalBootstrapIndeterminateClass} CanonicalBootstrapIndeterminate */

/**
 * @param {unknown} value
 * @returns {value is CanonicalBootstrapIndeterminate}
 */
function isCanonicalBootstrapIndeterminate(value) {
    return value instanceof CanonicalBootstrapIndeterminateClass;
}

/**
 * The transport-neutral `CohortBootstrapSource`.
 *
 * The properties that this class carries are:
 * - `queryCanonicalBootstrap` observes the cohort's canonical slot;
 * - `publishCanonicalBootstrapIfAbsent` performs the conditional publication which
 *   is the §4 arbitration point.
 *
 * The proof of those properties is guaranteed by:
 * - `makeCohortBootstrapSource(operations)`: accepts an operations object only when
 *   both members are functions, so every `CohortBootstrapSource` value answers both
 *   §4 operations and neither can be missing.
 *
 * @param {() => unknown} queryCanonicalBootstrap
 * @param {(candidate: CanonicalBootstrapCandidate) => unknown} publishCanonicalBootstrapIfAbsent
 */
class CohortBootstrapSourceClass {
    /**
     * @param {() => unknown} queryCanonicalBootstrap
     * @param {(candidate: CanonicalBootstrapCandidate) => unknown} publishCanonicalBootstrapIfAbsent
     */
    constructor(queryCanonicalBootstrap, publishCanonicalBootstrapIfAbsent) {
        this.queryCanonicalBootstrap = queryCanonicalBootstrap;
        this.publishCanonicalBootstrapIfAbsent = publishCanonicalBootstrapIfAbsent;
        Object.freeze(this);
    }
}

/** @typedef {CohortBootstrapSourceClass} CohortBootstrapSource */

/**
 * @param {unknown} value
 * @returns {value is CohortBootstrapSource}
 */
function isCohortBootstrapSource(value) {
    return value instanceof CohortBootstrapSourceClass;
}

/**
 * Configure the cohort bootstrap source from its two transport-neutral
 * operations.
 * @param {object} operations
 * @param {() => unknown} operations.queryCanonicalBootstrap
 * @param {(candidate: CanonicalBootstrapCandidate) => unknown} operations.publishCanonicalBootstrapIfAbsent
 * @returns {CohortBootstrapSource | JournalError}
 */
function makeCohortBootstrapSource(operations) {
    if (!isPlainRecord(operations)) {
        return makeJournalPublicationError("a cohort bootstrap source is not an object");
    }
    for (const key of Object.keys(operations)) {
        if (key !== "queryCanonicalBootstrap" && key !== "publishCanonicalBootstrapIfAbsent") {
            return makeJournalPublicationError(
                "a cohort bootstrap source carries the unknown operation " + JSON.stringify(key)
            );
        }
    }
    if (typeof operations.queryCanonicalBootstrap !== "function") {
        return makeJournalPublicationError("a cohort bootstrap source cannot observe the canonical slot");
    }
    if (typeof operations.publishCanonicalBootstrapIfAbsent !== "function") {
        return makeJournalPublicationError("a cohort bootstrap source cannot publish conditionally");
    }
    return new CohortBootstrapSourceClass(
        operations.queryCanonicalBootstrap,
        operations.publishCanonicalBootstrapIfAbsent
    );
}

/**
 * Describe a transport value in the vocabulary of §4 query results.
 * @param {unknown} raw
 * @param {string} operation
 * @returns {string}
 */
function describeRawResult(raw, operation) {
    if (raw instanceof Error) {
        return raw.message;
    }
    if (isPlainRecord(raw)) {
        const detail = raw["detail"];
        if (typeof detail === "string") {
            return detail;
        }
    }
    return "the cohort bootstrap source returned a value which is not a " + operation + " result";
}

/**
 * Normalize one query result into exactly one §4 variant.
 *
 * The transport's absence token is `null`, an artifact answers `Exists`, and a
 * thrown value, a reported error or anything unrecognized answers
 * `IndeterminateOrError`. Fail-closed is the point: §4.3 forbids treating an
 * unanswerable question as an answer, because doing so would let a replica author
 * competing canonical history.
 *
 * @param {unknown} raw
 * @returns {CanonicalBootstrapExists | CanonicalBootstrapDefinitelyAbsent | CanonicalBootstrapIndeterminate}
 */
function observeCanonicalBootstrap(raw) {
    if (isCanonicalBootstrapSnapshot(raw)) {
        return new CanonicalBootstrapExistsClass(raw);
    }
    if (raw === null) {
        return DEFINITELY_ABSENT;
    }
    return new CanonicalBootstrapIndeterminateClass(
        describeRawResult(raw, "queryCanonicalBootstrap")
    );
}

/**
 * @typedef {object} CanonicalBootstrapPublication
 * @property {CanonicalBootstrapSnapshot} artifact - The durable artifact the cohort
 *   slot holds after the conditional publication.
 */

/**
 * @typedef {CanonicalBootstrapPublication & {published: true}} CanonicalBootstrapPublished
 */

/**
 * @typedef {CanonicalBootstrapPublication & {alreadyExists: true}} CanonicalBootstrapAlreadyExists
 */

/**
 * @typedef {CanonicalBootstrapPublished | CanonicalBootstrapAlreadyExists | CanonicalBootstrapIndeterminate} CanonicalBootstrapPublicationResult
 */

/**
 * Normalize one publication result into exactly one §4 publication variant.
 *
 * `published` and `already-exists` are distinct transport answers even though
 * both name an artifact, because §4.1 authorizes local cutover only for the first
 * and §4.2 requires discarding the losing staged candidate for the second.
 *
 * @param {unknown} raw
 * @returns {CanonicalBootstrapPublicationResult}
 */
function observeCanonicalBootstrapPublication(raw) {
    if (isPlainRecord(raw)) {
        const artifact = raw["artifact"];
        if (raw["published"] === true && isCanonicalBootstrapSnapshot(artifact)) {
            return { published: true, artifact };
        }
        if (raw["alreadyExists"] === true && isCanonicalBootstrapSnapshot(artifact)) {
            return { alreadyExists: true, artifact };
        }
    }
    return new CanonicalBootstrapIndeterminateClass(
        describeRawResult(raw, "publishCanonicalBootstrapIfAbsent")
    );
}

/**
 * Whether an artifact is the published form of a staged candidate, which §4.1
 * requires the caller to validate before any local creator cutover.
 *
 * The comparison is over the canonical record bodies, the creator, the frontier
 * and both stored target fields, so a publication which accepted a different cut
 * under the same creator is not mistaken for the one this replica staged.
 *
 * @param {CanonicalBootstrapSnapshot} artifact
 * @param {CanonicalBootstrapCandidate} candidate
 * @returns {boolean}
 */
function publishedArtifactIsStagedCandidate(artifact, candidate) {
    if (!isCanonicalBootstrapSnapshot(artifact) || !isCanonicalBootstrapCandidate(candidate)) {
        return false;
    }
    if (journalAuthorToString(artifact.creatorWriter) !== journalAuthorToString(candidate.creatorWriter)) {
        return false;
    }
    if (artifact.databaseVersion !== candidate.targetVersion) {
        return false;
    }
    if (artifact.graphSchemeString !== candidate.graphSchemeString) {
        return false;
    }
    if (artifact.records.length !== candidate.records.length) {
        return false;
    }
    const reached = [...artifact.bootstrapFrontier];
    const staged = [...candidate.bootstrapFrontier];
    if (JSON.stringify(reached) !== JSON.stringify(staged)) {
        return false;
    }
    for (const [position, record] of artifact.records.entries()) {
        const staged = candidate.records[position];
        if (staged === undefined) {
            return false;
        }
        if (JSON.stringify(canonicalRecordBody(record)) !== JSON.stringify(canonicalRecordBody(staged))) {
            return false;
        }
    }
    return true;
}

/**
 * Ask the cohort whether a canonical artifact exists, normalizing the answer.
 * @param {CohortBootstrapSource} source
 * @returns {Promise<CanonicalBootstrapExists | CanonicalBootstrapDefinitelyAbsent | CanonicalBootstrapIndeterminate>}
 */
async function queryCanonicalBootstrap(source) {
    if (!isCohortBootstrapSource(source)) {
        throw new Error("the cohort bootstrap source is not a configured source");
    }
    try {
        return observeCanonicalBootstrap(await source.queryCanonicalBootstrap());
    } catch (error) {
        return observeCanonicalBootstrap(error);
    }
}

/**
 * Publish a staged candidate conditionally, normalizing the answer.
 * @param {CohortBootstrapSource} source
 * @param {CanonicalBootstrapCandidate} candidate
 * @returns {Promise<CanonicalBootstrapPublicationResult>}
 */
async function publishCanonicalBootstrap(source, candidate) {
    if (!isCohortBootstrapSource(source)) {
        throw new Error("the cohort bootstrap source is not a configured source");
    }
    if (!isCanonicalBootstrapCandidate(candidate)) {
        return new CanonicalBootstrapIndeterminateClass(
            "conditional publication was asked for something which is not a staged canonical candidate"
        );
    }
    try {
        return observeCanonicalBootstrapPublication(
            await source.publishCanonicalBootstrapIfAbsent(candidate)
        );
    } catch (error) {
        return observeCanonicalBootstrapPublication(error);
    }
}

/**
 * The artifact already holds the cohort slot: use it, choosing the operation by
 * whether this replica is its creator.
 *
 * A different fingerprint cannot use creator-resume, so the artifact's creator
 * alone decides.
 *
 * @param {CanonicalBootstrapSnapshot} artifact
 * @param {JournalAuthor} localWriter
 * @returns {{kind: "use-canonical-artifact", artifact: CanonicalBootstrapSnapshot, operation: "resume-canonical-creator" | "join-canonical-bootstrap"}}
 */
function canonicalArtifactOutcome(artifact, localWriter) {
    return {
        kind: "use-canonical-artifact",
        artifact,
        operation:
            journalAuthorToString(artifact.creatorWriter) === journalAuthorToString(localWriter)
                ? "resume-canonical-creator"
                : "join-canonical-bootstrap",
    };
}

/**
 * @typedef {object} ArbitrationRequest
 * @property {CohortBootstrapSource} source - The configured cohort bootstrap source.
 * @property {JournalAuthor} localWriter - This replica's durable `DatabaseFingerprint`.
 * @property {BootstrapTarget} target - The running release's configured bootstrap target.
 * @property {() => CanonicalBootstrapCandidate | JournalError} stageCandidate - Stages the
 *   deterministic candidate from the still-persisted supported pre-Journal state.
 * @property {CanonicalBootstrapCandidate | undefined} stagedCandidate - A candidate this
 *   replica already staged, supplied instead of `stageCandidate` when §6 retries the
 *   publication of a candidate whose outcome is still unknown.
 */

/**
 * @typedef {{kind: "use-canonical-artifact", artifact: CanonicalBootstrapSnapshot, operation: "resume-canonical-creator" | "join-canonical-bootstrap"}} UseCanonicalArtifact
 * @typedef {{kind: "cut-over-to-local-creator", artifact: CanonicalBootstrapSnapshot, candidate: CanonicalBootstrapCandidate}} CutOverToLocalCreator
 * @typedef {{kind: "unresolved-publication", detail: string, artifact: CanonicalBootstrapSnapshot | undefined}} UnresolvedPublication
 * @typedef {UseCanonicalArtifact | CutOverToLocalCreator | UnresolvedPublication} CanonicalBootstrapOutcome
 */

/**
 * Run the §4 canonical-bootstrap decision procedure for one startup.
 *
 * The procedure is the whole of §4 and §6's retry discipline, in the order the
 * specification fixes:
 *
 * 1. query; `IndeterminateOrError` fails startup with no staged candidate and no
 *    publication attempt, and `DefinitelyAbsent` is followed by a conditional
 *    publication rather than a cutover;
 * 2. an existing artifact is admitted only when it matches the configured
 *    bootstrap target, and is then used through creator-resume or ordinary join;
 * 3. with a free slot the candidate is staged once — from `stagedCandidate` when
 *    §6 supplies the very candidate whose outcome is unknown, otherwise from
 *    `stageCandidate` — and published conditionally;
 * 4. `Published` yields local cutover only after the published artifact is
 *    validated to be that staged candidate; `AlreadyExists` discards the staged
 *    candidate and uses the winning artifact through the same rule as step 2; and
 *    `IndeterminateOrError` leaves the pre-Journal database active and reports an
 *    unresolved outcome, which is the condition under which §6 requires a
 *    re-query before any retry.
 *
 * The outcome is a value rather than an exception, so the caller cannot cut over by
 * forgetting an error branch.
 *
 * @param {ArbitrationRequest} request
 * @returns {Promise<CanonicalBootstrapOutcome | JournalError>}
 */
async function arbitrateCanonicalBootstrap(request) {
    const { source, localWriter, target, stageCandidate, stagedCandidate } = request;
    if (!isCohortBootstrapSource(source)) {
        return makeJournalPublicationError("canonical bootstrap requires a configured cohort bootstrap source");
    }
    const observed = await queryCanonicalBootstrap(source);
    if (isCanonicalBootstrapIndeterminate(observed)) {
        return {
            kind: "unresolved-publication",
            detail:
                "the canonical bootstrap slot could not be observed: " +
                observed.detail +
                "; startup fails rather than create competing canonical history",
            artifact: undefined,
        };
    }
    if (isCanonicalBootstrapExists(observed)) {
        const admitted = artifactSupportsBootstrapTarget(observed.artifact, target);
        if (admitted !== undefined) {
            return admitted;
        }
        return canonicalArtifactOutcome(observed.artifact, localWriter);
    }
    if (stagedCandidate !== undefined && !isCanonicalBootstrapCandidate(stagedCandidate)) {
        return makeJournalPublicationError(
            "canonical bootstrap was resumed with something which is not a staged canonical candidate"
        );
    }
    const candidate = stagedCandidate !== undefined ? stagedCandidate : stageCandidate();
    // Staging a candidate can fail on the pre-Journal boundary itself, and that
    // failure is the answer: no publication is attempted.
    if (isJournalError(candidate)) {
        return candidate;
    }
    const publication = await publishCanonicalBootstrap(source, candidate);
    if (isCanonicalBootstrapIndeterminate(publication)) {
        return {
            kind: "unresolved-publication",
            detail:
                "conditional publication of the canonical bootstrap candidate did not resolve: " +
                publication.detail +
                "; the pre-Journal database stays the active persisted state, no local cutover occurs, and the " +
                "outcome is resolved by re-querying",
            artifact: undefined,
        };
    }
    const admitted = artifactSupportsBootstrapTarget(publication.artifact, target);
    if (admitted !== undefined) {
        return admitted;
    }
    if ("published" in publication) {
        if (!publishedArtifactIsStagedCandidate(publication.artifact, candidate)) {
            return makeJournalBootstrapForkError(
                journalAuthorToString(localWriter),
                journalAuthorToString(publication.artifact.creatorWriter),
                "the cohort published a canonical bootstrap artifact which is not the published form of the " +
                    "candidate this replica staged, so local cutover is not authorized"
            );
        }
        return {
            kind: "cut-over-to-local-creator",
            artifact: publication.artifact,
            candidate,
        };
    }
    return canonicalArtifactOutcome(publication.artifact, localWriter);
}

module.exports = {
    isCanonicalBootstrapDefinitelyAbsent,
    isCanonicalBootstrapExists,
    isCanonicalBootstrapIndeterminate,
    isCohortBootstrapSource,
    makeCohortBootstrapSource,
    observeCanonicalBootstrap,
    observeCanonicalBootstrapPublication,
    publishedArtifactIsStagedCandidate,
    queryCanonicalBootstrap,
    publishCanonicalBootstrap,
    arbitrateCanonicalBootstrap,
};