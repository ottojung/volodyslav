/**
 * The startup side of the Journal 3 pre-Journal boundary.
 *
 * `database-lifecycle.md` §8.1 sends supported pre-Journal state to
 * the canonical-bootstrap-source decision and §8.2 makes that decision's consequences
 * binding on startup: no local cutover before a durable canonical artifact has been
 * selected, and an unresolved publication outcome leaves the supported pre-Journal
 * database selected and fails startup before graph APIs are exposed.
 *
 * This module is where that decision is taken. `journal/bootstrap` owns the decision
 * procedure itself, and it is pure by construction, so it deliberately does not read a
 * replica or hold a transport. This module supplies the two things the subfolder cannot
 * have — the read of the persisted pre-Journal replica, and the transport the
 * arbitration is given — and it dispatches the arbitration's answer to the consumer
 * that answer names.
 *
 * The dispatch is total over the answer vocabulary. `arbitrateCanonicalBootstrap`
 * answers with `use-canonical-artifact`, `cut-over-to-local-creator`,
 * `unresolved-publication`, or a `JournalError`, and each of those means exactly one
 * thing here:
 *
 * - `cut-over-to-local-creator` resumes the creator, because the artifact is this
 *   replica's own staged candidate, which is the §6 install path;
 * - `use-canonical-artifact` resumes the creator when the cohort already held this
 *   replica's artifact, and joins when it held a different creator's, which is the §7
 *   install path;
 * - `unresolved-publication` becomes an `UnresolvedStartupCanonicalBootstrap`, which
 *   carries no artifact, no records and no projection, so the pre-Journal database
 *   stays the active persisted state and the caller fails startup;
 * - a `JournalError` is returned as itself.
 *
 * Nothing here coerces an answer. An indeterminate transport answer arrives from the
 * arbitration already normalized as `unresolved-publication`, and it is the one answer
 * which never reaches a consumer, so no path through this module can read an
 * unanswerable question as an absence or as permission to cut over.
 *
 * The module reads through `SchemaStorage` and the Journal store, and writes nothing:
 * installation is `journal_bootstrap_install`, so a resolution can be inspected and
 * rejected before any durable change happens.
 */

/** @typedef {import('./journal/errors').AnyJournalError} JournalError */
/** @typedef {import('./journal/types').AuthorityTime} AuthorityTime */
/** @typedef {import('./journal/types').JournalAuthor} JournalAuthor */
/** @typedef {import('./journal/types').JournalSequence} JournalSequence */
/** @typedef {import('./journal/records').JournalRecord} JournalRecord */
/** @typedef {import('./journal/emission').CommittedWriterState} CommittedWriterState */
/** @typedef {import('./journal/oracle/projection').Projection} Projection */
/** @typedef {import('./database/types').Version} Version */
/** @typedef {import('./database/root_database').SchemaStorage} SchemaStorage */
/** @typedef {import('./database/graph_scheme').GraphScheme} GraphScheme */
/** @typedef {import('./database/types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./database/types').NodeKeyString} NodeKeyString */
/** @typedef {import('./database/types').IdentifiersKeysMap} IdentifiersKeysMap */
/** @typedef {import('./journal').LegacyBootstrapState} LegacyBootstrapState */
/** @typedef {import('./journal').CanonicalBootstrapSnapshot} CanonicalBootstrapSnapshot */
/** @typedef {import('./journal').CohortBootstrapSource} CohortBootstrapSource */
/** @typedef {import('./journal').BootstrapTarget} BootstrapTarget */
/** @typedef {import('./journal').CanonicalBootstrapCandidate} CanonicalBootstrapCandidate */

const {
    deriveInputPositions,
    nodeKeyStringToString,
    stringToNodeKeyString,
} = require("./database");
const {
    arbitrateCanonicalBootstrap,
    isJournalError,
    isJoinedCanonicalBootstrap,
    isResumedCanonicalCreator,
    joinCanonicalBootstrap,
    makeJournalPublicationError,
    resumeCanonicalBootstrapCreator,
    stageCanonicalBootstrap,
} = require("./journal");
const {
    isCanonicalBootstrapSnapshot,
    isLegacyBootstrapState,
} = require("./journal");

/**
 * The operation the arbitration named, and the canonical cut this replica installs.
 *
 * The properties that this class carries are:
 * - `operation` is `resume-canonical-creator` or `join-canonical-bootstrap`, the two
 *   cutover operations `arbitrateCanonicalBootstrap` can answer with, so a resolution
 *   can never name an operation the arbitration did not select;
 * - `artifact` is the one canonical artifact the cohort slot holds, admitted against
 *   the running release's configured bootstrap target;
 * - `records` is the exact record set to install, which for a resume is the artifact's
 *   own frozen cut and for a join is the canonical cut followed by this replica's own
 *   bootstrap records;
 * - `frontier` is the frontier those records reach;
 * - `projection` is that record set replayed under this replica's local writer, so the
 *   materialized graph a cutover installs is the one replay produces;
 * - `databaseVersion` is the bootstrap target version the installed pair carries.
 *
 * The proof of those properties is guaranteed by:
 * - `resolveCanonicalBootstrapForStartup(request)`: returns this value only after
 *   `arbitrateCanonicalBootstrap` selected one of its two cutover operations and the
 *   corresponding §6 or §7 consumer returned its own replay-checked value, from which
 *   this class reads the records, frontier, projection and version verbatim.
 *
 * @param {"resume-canonical-creator" | "join-canonical-bootstrap"} operation
 * @param {CanonicalBootstrapSnapshot} artifact
 * @param {ReadonlyArray<JournalRecord>} records
 * @param {import("./journal/types").JournalFrontier} frontier
 * @param {Projection} projection
 * @param {Version} databaseVersion
 * @param {JournalAuthor} localWriter
 */
class StartupCanonicalBootstrapClass {
    /**
     * @param {"resume-canonical-creator" | "join-canonical-bootstrap"} operation
     * @param {CanonicalBootstrapSnapshot} artifact
     * @param {ReadonlyArray<JournalRecord>} records
     * @param {import("./journal/types").JournalFrontier} frontier
     * @param {Projection} projection
     * @param {Version} databaseVersion
     * @param {JournalAuthor} localWriter
     */
    constructor(operation, artifact, records, frontier, projection, databaseVersion, localWriter) {
        this.operation = operation;
        this.artifact = artifact;
        this.records = Object.freeze(records.slice());
        this.frontier = frontier;
        this.projection = projection;
        this.databaseVersion = databaseVersion;
        this.localWriter = localWriter;
        Object.freeze(this);
    }
}

/** @typedef {StartupCanonicalBootstrapClass} StartupCanonicalBootstrap */

/**
 * @param {unknown} value
 * @returns {value is StartupCanonicalBootstrap}
 */
function isStartupCanonicalBootstrap(value) {
    return value instanceof StartupCanonicalBootstrapClass;
}

/**
 * The canonical bootstrap did not resolve, so startup must not cut over.
 *
 * The properties that this class carries are:
 * - `detail` states why the cohort slot's durable state is unknown;
 * - there is no artifact, no record set and no projection, so a caller holding this
 *   value holds nothing it could install, which makes "no cutover" the only available
 *   continuation.
 *
 * The proof of those properties is guaranteed by:
 * - `resolveCanonicalBootstrapForStartup(request)`: constructs this value only from an
 *   `unresolved-publication` outcome, which the arbitration produces only for an
 *   indeterminate query answer or an indeterminate publication answer, and fills it from
 *   that outcome alone.
 *
 * @param {string} detail
 */
class UnresolvedStartupCanonicalBootstrapClass {
    /**
     * @param {string} detail
     */
    constructor(detail) {
        this.detail = detail;
        Object.freeze(this);
    }
}

/** @typedef {UnresolvedStartupCanonicalBootstrapClass} UnresolvedStartupCanonicalBootstrap */

/**
 * @param {unknown} value
 * @returns {value is UnresolvedStartupCanonicalBootstrap}
 */
function isUnresolvedStartupCanonicalBootstrap(value) {
    return value instanceof UnresolvedStartupCanonicalBootstrapClass;
}

/**
 * The current graph schema's direct inputs per materialized node, which fixes replay's
 * proof and freshness rule for the whole bootstrap decision.
 *
 * Replay derives freshness and validity from the current schema rather than from the
 * records, so the bootstrap decision cannot be taken without it. It is derived from the
 * running release's graph scheme, which is the same schema a cutover installs.
 *
 * @param {GraphScheme} graphScheme
 * @returns {(nodeKeyString: string) => ReadonlyArray<string> | undefined}
 */
function makeCurrentInputKeysOfNode(graphScheme) {
    const currentInputKeysOfNode = (/** @type {string} */ nodeKeyString) => {
        const key = stringToNodeKeyString(nodeKeyString);
        if (key instanceof Error) {
            return undefined;
        }
        const template = schemeInputKeysOf(graphScheme, key);
        if (template === undefined) {
            return undefined;
        }
        return template.map((input) => nodeKeyStringToString(input));
    };
    return currentInputKeysOfNode;
}

/**
 * @param {GraphScheme} graphScheme
 * @param {NodeKeyString} nodeKey
 * @returns {ReadonlyArray<NodeKeyString> | undefined}
 */
function schemeInputKeysOf(graphScheme, nodeKey) {
    try {
        return deriveInputPositions(graphScheme, nodeKey);
    } catch (error) {
        // A node the current schema does not describe has no defined input relation.
        // The consumers report that by name, so the relation is absent rather than
        // empty: an empty list would claim the node has no inputs at all.
        if (error instanceof Error) {
            return undefined;
        }
        throw error;
    }
}

/**
 * @typedef {object} CanonicalBootstrapStartupRequest
 * @property {LegacyBootstrapState} legacyState - The validated supported pre-Journal
 *   state this replica still persists.
 * @property {JournalAuthor} localWriter - This replica's durable `DatabaseFingerprint`.
 * @property {BootstrapTarget} target - The running release's configured bootstrap target.
 * @property {CohortBootstrapSource | undefined} source - The configured cohort bootstrap
 *   source. Absent means the deployment configures none, which is fail-closed for a
 *   supported pre-Journal replica rather than permission to create canonical history.
 * @property {(nodeKeyString: string) => ReadonlyArray<string> | undefined} currentInputKeysOfNode -
 *   The current graph schema's direct inputs per materialized node.
 * @property {CanonicalBootstrapCandidate} [stagedCandidate] - A candidate this replica
 *   already staged, supplied when §6 retries a publication whose outcome is unknown.
 */

/**
 * Resolve the canonical bootstrap for one startup and dispatch the answer.
 *
 * This is the whole §8.2 startup consequence in one call: it hands the configured
 * cohort source and this replica's own writer to the arbitration, and dispatches
 * whichever cutover operation the arbitration named to the consumer which implements
 * that operation.
 *
 * Both cutover answers converge on the same dispatch but not on the same consumer: a
 * `cut-over-to-local-creator` answer is a §6 resume because the artifact is this
 * replica's own staged candidate, while a `use-canonical-artifact` answer is a §6 resume
 * when the cohort already held this replica's artifact and a §7 join when it held a
 * different creator's. The dispatch therefore never decides whether an answer is
 * correct — only which procedure implements it — and each consumer still refuses a
 * mismatch it cannot justify.
 *
 * @param {CanonicalBootstrapStartupRequest} request
 * @returns {Promise<StartupCanonicalBootstrap | UnresolvedStartupCanonicalBootstrap | JournalError>}
 */
async function resolveCanonicalBootstrapForStartup(request) {
    const { legacyState, localWriter, target, source, currentInputKeysOfNode } = request;
    if (!isLegacyBootstrapState(legacyState)) {
        return makeJournalPublicationError(
            "canonical bootstrap at startup requires a validated supported pre-Journal source state"
        );
    }
    if (typeof currentInputKeysOfNode !== "function") {
        return makeJournalPublicationError(
            "canonical bootstrap at startup requires the current graph schema's direct inputs"
        );
    }
    if (source === undefined) {
        return makeJournalPublicationError(
            "a supported pre-Journal database is not a supported bootstrap source without a configured cohort " +
                "bootstrap source; startup fails before authoring any history rather than creating a second " +
                "canonical bootstrap"
        );
    }
    const arbitration = await arbitrateCanonicalBootstrap({
        source,
        localWriter,
        target,
        stageCandidate: () =>
            stageCanonicalBootstrap({
                legacyState,
                creatorWriter: localWriter,
                targetVersion: target.databaseVersion,
            }),
        stagedCandidate: request.stagedCandidate,
    });
    if (isJournalError(arbitration)) {
        return arbitration;
    }
    if (arbitration.kind === "unresolved-publication") {
        return new UnresolvedStartupCanonicalBootstrapClass(arbitration.detail);
    }
    if (!isCanonicalBootstrapSnapshot(arbitration.artifact)) {
        return makeJournalPublicationError(
            "canonical bootstrap at startup received an answer whose artifact is not a canonical snapshot"
        );
    }
    if (arbitration.kind === "use-canonical-artifact" && arbitration.operation === "join-canonical-bootstrap") {
        return joinResolution(arbitration.artifact, localWriter, legacyState, currentInputKeysOfNode);
    }
    return resumeResolution(arbitration.artifact, localWriter, legacyState, currentInputKeysOfNode);
}

/**
 * @param {CanonicalBootstrapSnapshot} artifact
 * @param {JournalAuthor} localWriter
 * @param {LegacyBootstrapState} legacyState
 * @param {(nodeKeyString: string) => ReadonlyArray<string> | undefined} currentInputKeysOfNode
 * @returns {StartupCanonicalBootstrap | JournalError}
 */
function joinResolution(artifact, localWriter, legacyState, currentInputKeysOfNode) {
    const joined = joinCanonicalBootstrap({
        legacyState,
        artifact,
        joiningWriter: localWriter,
        currentInputKeysOfNode,
    });
    if (isJournalError(joined)) {
        return joined;
    }
    if (!isJoinedCanonicalBootstrap(joined)) {
        return makeJournalPublicationError("the joining bootstrap consumer did not return a joined bootstrap");
    }
    return new StartupCanonicalBootstrapClass(
        "join-canonical-bootstrap",
        artifact,
        joined.records,
        joined.frontier,
        joined.projection,
        joined.databaseVersion,
        localWriter
    );
}

/**
 * @param {CanonicalBootstrapSnapshot} artifact
 * @param {JournalAuthor} localWriter
 * @param {LegacyBootstrapState} legacyState
 * @param {(nodeKeyString: string) => ReadonlyArray<string> | undefined} currentInputKeysOfNode
 * @returns {StartupCanonicalBootstrap | JournalError}
 */
function resumeResolution(artifact, localWriter, legacyState, currentInputKeysOfNode) {
    const resumed = resumeCanonicalBootstrapCreator({
        legacyState,
        artifact,
        localWriter,
        currentInputKeysOfNode,
    });
    if (isJournalError(resumed)) {
        return resumed;
    }
    if (!isResumedCanonicalCreator(resumed)) {
        return makeJournalPublicationError("the creator-resume consumer did not return a resumable creator");
    }
    return new StartupCanonicalBootstrapClass(
        "resume-canonical-creator",
        artifact,
        resumed.records,
        resumed.frontier,
        resumed.projection,
        resumed.databaseVersion,
        localWriter
    );
}


module.exports = {
    isStartupCanonicalBootstrap,
    isUnresolvedStartupCanonicalBootstrap,
    makeCurrentInputKeysOfNode,
    resolveCanonicalBootstrapForStartup,
};
