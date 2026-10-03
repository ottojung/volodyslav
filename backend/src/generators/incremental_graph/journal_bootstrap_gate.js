/**
 * The §8 gate: where startup takes the canonical-bootstrap decision.
 *
 * `incremental-graph-journal-lifecycle.md` §8.1 makes the migration/bootstrap gate part
 * of startup, and §8.2 makes its consequences binding: no local cutover before a
 * durable canonical artifact has been selected, and an unresolved publication outcome
 * leaves the supported pre-Journal database selected while startup fails before graph
 * APIs are exposed.
 *
 * This module is the gate. It decides whether the active replica is even a pre-Journal
 * source, resolves the canonical bootstrap when it is, installs the resolved cut, and
 * reports the outcome. Three of its four outcomes leave the replica alone:
 *
 * - `no-pre-journal-state` — the replica is fresh, empty, or already retains Journal
 *   records, so startup continues with whatever the migration gate selected. Startup
 *   never reads a Journal replica as a pre-Journal source.
 * - `unresolved-canonical-bootstrap` — the cohort slot's durable state is unknown, so
 *   nothing was written, the pre-Journal database is still the active persisted state,
 *   and the caller fails startup. §8.2 requires a re-query before any retry, so this
 *   outcome is reported rather than retried here.
 * - `canonical-bootstrapped` — the resolved cut was installed and the replica pointer
 *   moved.
 *
 * A `JournalError` from reading the source, from the arbitration, or from either
 * consumer is thrown: those are compatibility and fork conditions which startup must
 * fail on by name, not outcomes to be retried.
 *
 * The cohort bootstrap source is deployment configuration supplied by the caller. It is
 * deliberately not persisted in the database and not derived from a locator the database
 * owns, which is what keeps a transport identity out of IncrementalGraph state.
 */

/** @typedef {import('./journal/errors').AnyJournalError} JournalError */
/** @typedef {import('./database/root_database').RootDatabase} RootDatabase */
/** @typedef {import('./database/root_database').ReplicaName} ReplicaName */
/** @typedef {import('./journal').JournalAuthor} JournalAuthor */
/** @typedef {import('./journal').CohortBootstrapSource} CohortBootstrapSource */
/** @typedef {import('../../logger').Logger} Logger */
/** @typedef {import('./types').NodeDef} NodeDef */

/**
 * @typedef {object} CanonicalBootstrapGateRequest
 * @property {RootDatabase} rootDatabase - The opened root database.
 * @property {import('../../logger').Logger} [logger] - Logger for the gate's outcome.
 * @property {NodeDef[]} nodeDefs - The running release's node definitions, which fix the
 *   current graph schema replay uses and therefore the bootstrap target's graph scheme.
 * @property {CohortBootstrapSource | undefined} source - The configured cohort bootstrap source.
 *   Absent when the deployment configures none, which is a fail-closed condition for a
 *   supported pre-Journal replica and is not a condition at all for any other replica.
 */

const { makeJournalAuthor, isJournalError } = require("./journal");
const { compileValidatedGraphSchema } = require("./graph_schema");
const { readPreJournalSourceState } = require("./journal_bootstrap_source");
const {
    isStartupCanonicalBootstrap,
    isUnresolvedStartupCanonicalBootstrap,
    makeCurrentInputKeysOfNode,
    resolveCanonicalBootstrapForStartup,
} = require("./journal_bootstrap_startup");
const { installCanonicalBootstrap } = require("./journal_bootstrap_install");
const { buildGraphSchemeStringFromNodeDefs, parseGraphScheme } = require("./database");

/**
 * @typedef {{status: "no-pre-journal-state"}} NoPreJournalState
 * @typedef {{status: "unresolved-canonical-bootstrap", detail: string}} UnresolvedCanonicalBootstrap
 * @typedef {{status: "canonical-bootstrapped", operation: "resume-canonical-creator" | "join-canonical-bootstrap", replica: ReplicaName}} BootstrappedCanonical
 * @typedef {NoPreJournalState | UnresolvedCanonicalBootstrap | BootstrappedCanonical} CanonicalBootstrapGateOutcome
 */

/**
 * Run the canonical-bootstrap part of the §8 gate for one startup.
 *
 * @param {CanonicalBootstrapGateRequest} request
 * @returns {Promise<CanonicalBootstrapGateOutcome>}
 */
async function runCanonicalBootstrapGate(request) {
    const { rootDatabase, nodeDefs, source, logger } = request;
    const storage = rootDatabase.getSchemaStorage();
    const storedVersion = await storage.global.get("version");
    if (storedVersion === undefined) {
        return { status: "no-pre-journal-state" };
    }
    const read = await readPreJournalSourceState(storage);
    if (isJournalError(read)) {
        throw read;
    }
    if (read.retainsJournalRecords || read.materializedNodes === 0 || read.legacyState === undefined) {
        return { status: "no-pre-journal-state" };
    }
    const fingerprint = rootDatabase.getFingerprint();
    const localWriter = makeJournalAuthor(fingerprint);
    if (isJournalError(localWriter)) {
        throw localWriter;
    }
    const target = {
        databaseVersion: rootDatabase.getVersion(),
        graphSchemeString: bootstrapTargetSchemeOf(nodeDefs),
    };
    const resolution = await resolveCanonicalBootstrapForStartup({
        legacyState: read.legacyState,
        localWriter,
        target,
        source,
        currentInputKeysOfNode: makeCurrentInputKeysOfNode(
            parseGraphScheme(JSON.parse(target.graphSchemeString))
        ),
    });
    if (isUnresolvedStartupCanonicalBootstrap(resolution)) {
        if (logger !== undefined) {
            logger.logInfo({}, "Canonical bootstrap unresolved: " + resolution.detail);
        }
        return { status: "unresolved-canonical-bootstrap", detail: resolution.detail };
    }
    if (isJournalError(resolution)) {
        throw resolution;
    }
    if (!isStartupCanonicalBootstrap(resolution)) {
        throw new Error("the canonical bootstrap gate received neither a resolution nor an outcome");
    }
    const replica = await installCanonicalBootstrap(rootDatabase, resolution);
    if (logger !== undefined) {
        logger.logInfo(
            { operation: resolution.operation, replica },
            "Canonical bootstrap installed through " + resolution.operation
        );
    }
    return { status: "canonical-bootstrapped", operation: resolution.operation, replica };
}

/**
 * The graph scheme string the running release configures, which is the bootstrap
 * target's graph scheme and the value an artifact's own scheme is compared against.
 *
 * @param {import('./types').NodeDef[]} nodeDefs
 * @returns {string}
 */
function bootstrapTargetSchemeOf(nodeDefs) {
    return buildGraphSchemeStringFromNodeDefs(compileValidatedGraphSchema(nodeDefs).compiledNodes);
}

module.exports = {
    runCanonicalBootstrapGate,
};
