/**
 * §6 creator resume: install the canonical cut this replica authored.
 *
 * `incremental-graph-journal-migrations.md` §6 covers the crash window in which
 * conditional publication succeeded but the creator never received the result and
 * never cut its local active database over. On restart the cohort holds the
 * artifact, its creator is this replica's own durable `DatabaseFingerprint`, and
 * the local database is still supported pre-Journal state. This module is the
 * `resumeCanonicalBootstrapCreator` §6 names.
 *
 * The comparison §6 step 5 requires is a comparison of the artifact's projection
 * with still-persisted legacy semantics, so this module derives the freshness the
 * persisted source implies under the Journal rule rather than reading the source's
 * `upToDate` flags as freshness. A supported legacy node whose `upToDate` flag is
 * true still implies staleness when one of its certified inputs is itself stale,
 * because Journal freshness requires every current input to be fresh; comparing
 * the persisted flags instead would make a correct canonical cut look forked for
 * exactly the graphs where the derived and persisted readings differ. The derived
 * reading is therefore the correct behaviour, and both sides of the comparison are
 * computed by the same rule.
 *
 * The module authors nothing and cuts nothing over. It returns the value the
 * caller installs, which is the whole of §6 steps 7 and 8's input: exactly the
 * artifact's history, the creator frontier, the reconstructed projection, and the
 * bootstrap target version from which the ordinary migration gate resumes.
 */

const { nodeIdentifierToString, nodeKeyStringToString } = require("../../database");
const {
    makeJournalBootstrapForkError,
    makeJournalPublicationError,
} = require("../errors");
const { isJournalAuthor, journalAuthorToString } = require("../types");
const { makeReplicaSource, projectRetainedJournal } = require("../oracle");
const { nodeKeyToCanonicalString } = require("../basis");
const { canonicalArtifactReplica, isCanonicalBootstrapSnapshot } = require("./canonical_artifact");
const { isLegacyBootstrapState } = require("./legacy_state");

/** @typedef {import('../errors').AnyJournalError} JournalError */
/** @typedef {import('../types').JournalAuthor} JournalAuthor */
/** @typedef {import('../types').JournalFrontier} JournalFrontier */
/** @typedef {import('../records').JournalRecord} JournalRecord */
/** @typedef {import('../replica').JournalReplica} JournalReplica */
/** @typedef {import('../oracle/projection').Projection} Projection */
/** @typedef {import('../basis').NodeKey} NodeKey */
/** @typedef {import('../../database/types').Version} Version */
/** @typedef {import('./canonical_artifact').CanonicalBootstrapSnapshot} CanonicalBootstrapSnapshot */
/** @typedef {import('./legacy_state').LegacyBootstrapState} LegacyBootstrapState */
/** @typedef {import('./legacy_state').LegacyNode} LegacyNode */

/**
 * @callback CurrentInputKeysOfNode
 * @param {string} nodeKeyString
 * @returns {ReadonlyArray<string> | undefined}
 */

/**
 * @typedef {object} CreatorResumeRequest
 * @property {LegacyBootstrapState} legacyState - The still-persisted supported
 *   pre-Journal state this replica cut over from.
 * @property {CanonicalBootstrapSnapshot} artifact - The held canonical artifact
 *   whose creator is this replica.
 * @property {JournalAuthor} localWriter - This replica's durable
 *   `DatabaseFingerprint`, which §6 requires to equal the artifact's creator.
 * @property {CurrentInputKeysOfNode} currentInputKeysOfNode - The current graph
 *   schema's direct inputs per node, which fixes the replay's freshness rule.
 */

/**
 * The canonical cut this replica may install, together with the reconstructed state
 * §6 step 7 requires.
 *
 * The properties that this class carries are:
 * - `records` is exactly the artifact's held cut, so no record is authored and no
 *   later history is included;
 * - `frontier` is the artifact's own `bootstrapFrontier`;
 * - `projection` is that cut replayed under `localWriter`, and it equals the
 *   still-persisted legacy semantics in presence, payloads, NodeIdentifiers,
 *   timestamps, freshness, validity and allocator state;
 * - `databaseVersion` is the bootstrap target the ordinary migration gate resumes
 *   from.
 *
 * The proof of those properties is guaranteed by:
 * - `resumeCanonicalBootstrapCreator(request)`: reads exactly the artifact records
 *   through its `bootstrapFrontier`, projects them with `artifact.creatorWriter` as
 *   local writer, compares every §6 step 5 field and returns
 *   `JournalBootstrapForkError` on the first mismatch, so every value of this type
 *   reached its comparison with equality holding.
 *
 * @param {ReadonlyArray<JournalRecord>} records
 * @param {JournalFrontier} frontier
 * @param {Projection} projection
 * @property {Version} databaseVersion
 */
class ResumedCanonicalCreatorClass {
    /**
     * @param {ReadonlyArray<JournalRecord>} records
     * @param {JournalFrontier} frontier
     * @param {Projection} projection
     * @param {Version} databaseVersion
     */
    constructor(records, frontier, projection, databaseVersion) {
        this.records = Object.freeze(records.slice());
        this.frontier = frontier;
        this.projection = projection;
        this.databaseVersion = databaseVersion;
        Object.freeze(this);
    }
}

/** @typedef {ResumedCanonicalCreatorClass} ResumedCanonicalCreator */

/**
 * @param {unknown} value
 * @returns {value is ResumedCanonicalCreator}
 */
function isResumedCanonicalCreator(value) {
    return value instanceof ResumedCanonicalCreatorClass;
}

/**
 * The freshness the persisted legacy semantics imply under the Journal rule: a
 * node is fresh when the source persisted it as up to date and every direct input
 * of the current schema is itself implied fresh.
 *
 * This is the legacy-side reading of the §6 step 5 freshness comparison. Reading
 * the persisted `upToDate` flags instead would compare two different notions of
 * freshness, and would reject a canonical cut which faithfully recorded the
 * source's own stale evidence.
 *
 * @param {LegacyBootstrapState} legacyState
 * @param {CurrentInputKeysOfNode} currentInputKeysOfNode
 * @returns {Map<string, boolean> | JournalError}
 */
function deriveLegacyFreshness(legacyState, currentInputKeysOfNode) {
    /** @type {Map<string, boolean>} */
    const freshness = new Map();
    /** @type {Set<string>} */
    const deriving = new Set();

    /**
     * @param {LegacyNode} node
     * @returns {boolean | JournalError}
     */
    function freshnessOf(node) {
        const key = nodeKeyStringToString(node.nodeKeyString);
        const settled = freshness.get(key);
        if (settled !== undefined) {
            return settled;
        }
        if (deriving.has(key)) {
            return makeJournalPublicationError(
                "the persisted pre-Journal graph is not acyclic: " +
                    key +
                    " is its own input dependency, so its implied freshness is undefined"
            );
        }
        deriving.add(key);
        const inputs = currentInputKeysOfNode(key);
        if (inputs === undefined) {
            deriving.delete(key);
            return makeJournalPublicationError(
                "the current graph schema does not describe the materialized pre-Journal node " + key
            );
        }
        let fresh = node.upToDate;
        for (const input of inputs) {
            if (!fresh) {
                break;
            }
            const inputNode = legacyState.nodeAt(input);
            if (inputNode === undefined) {
                // A materialized node whose certified input the source does not
                // materialize cannot be implied fresh, and the replay side reports
                // the same graph as not dependency-closed.
                fresh = false;
                break;
            }
            const inputFreshness = freshnessOf(inputNode);
            if (inputFreshness instanceof Error) {
                deriving.delete(key);
                return inputFreshness;
            }
            if (!inputFreshness) {
                fresh = false;
            }
        }
        deriving.delete(key);
        freshness.set(key, fresh);
        return fresh;
    }

    for (const node of legacyState.nodes) {
        const implied = freshnessOf(node);
        if (implied instanceof Error) {
            return implied;
        }
    }
    return freshness;
}

/**
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
function samePayload(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * @param {ReadonlyArray<string>} left
 * @param {ReadonlyArray<string>} right
 * @returns {boolean}
 */
function sameKeySet(left, right) {
    const sortedLeft = [...left].sort();
    const sortedRight = [...right].sort();
    return (
        sortedLeft.length === sortedRight.length &&
        sortedLeft.every((key, position) => key === sortedRight[position])
    );
}

/**
 * Resume the canonical creator: validate that the held artifact is this replica's
 * own bootstrap and that replaying it reproduces still-persisted legacy semantics.
 *
 * §6 requires equality of presence, payloads, NodeIdentifiers, timestamps,
 * freshness, validity and allocator state. A mismatch on any of them is
 * `JournalBootstrapForkError`, returned without authoring a record and without a
 * cutover, because the local database and the cohort artifact then disagree about
 * the same occurrence.
 *
 * @param {CreatorResumeRequest} request
 * @returns {ResumedCanonicalCreator | JournalError}
 */
function resumeCanonicalBootstrapCreator(request) {
    const { legacyState, artifact, localWriter, currentInputKeysOfNode } = request;
    if (!isLegacyBootstrapState(legacyState)) {
        return makeJournalPublicationError(
            "canonical creator resume requires a validated pre-Journal source state"
        );
    }
    if (!isCanonicalBootstrapSnapshot(artifact)) {
        return makeJournalPublicationError("canonical creator resume requires a canonical artifact");
    }
    if (typeof currentInputKeysOfNode !== "function") {
        return makeJournalPublicationError(
            "canonical creator resume requires the current graph schema's direct inputs"
        );
    }
    if (!isJournalAuthor(localWriter)) {
        return makeJournalPublicationError("canonical creator resume names no local writer");
    }
    const localName = journalAuthorToString(localWriter);
    if (journalAuthorToString(artifact.creatorWriter) !== localName) {
        return makeJournalPublicationError(
            "canonical creator resume requires the artifact's creator to be this replica's fingerprint, and " +
                journalAuthorToString(artifact.creatorWriter) +
                " is not " +
                localName +
                "; a different fingerprint uses the joining path instead"
        );
    }

    const replica = canonicalArtifactReplica(artifact);
    const projection = projectRetainedJournal({
        source: makeReplicaSource(replica),
        localWriter: artifact.creatorWriter,
        currentInputKeysOfNode,
    });
    if (projection instanceof Error) {
        return projection;
    }

    const implied = deriveLegacyFreshness(legacyState, currentInputKeysOfNode);
    if (implied instanceof Error) {
        return implied;
    }

    /** @type {Map<string, import('../oracle/projection').ProjectedOccurrence>} */
    const projected = new Map(
        projection.occurrences.map((occurrence) => [occurrence.nodeKeyString, occurrence])
    );
    /**
     * @param {string} detail
     * @returns {JournalError}
     */
    const forked = (detail) => makeJournalBootstrapForkError(localName, localName, detail);

    for (const node of legacyState.nodes) {
        const key = nodeKeyStringToString(node.nodeKeyString);
        const occurrence = projected.get(key);
        if (occurrence === undefined) {
            return forked(
                "the pre-Journal source still materializes " +
                    key +
                    " while the canonical artifact this replica authored does not, so the artifact is not the " +
                    "cut of this replica's persisted bootstrap"
            );
        }
        if (nodeIdentifierToString(occurrence.nodeIdentifier) !== nodeIdentifierToString(node.nodeIdentifier)) {
            return forked(
                "the canonical artifact holds the NodeIdentifier " +
                    nodeIdentifierToString(occurrence.nodeIdentifier) +
                    " for " +
                    key +
                    " while the pre-Journal source persists " +
                    nodeIdentifierToString(node.nodeIdentifier)
            );
        }
        if (!samePayload(occurrence.payload, node.payload)) {
            return forked(
                "the canonical artifact holds a different persisted payload for " +
                    key +
                    " than the pre-Journal source still persists"
            );
        }
        if (occurrence.createdAt !== node.createdAt || occurrence.modifiedAt !== node.modifiedAt) {
            return forked(
                "the canonical artifact holds the timestamps " +
                    occurrence.createdAt +
                    "/" +
                    occurrence.modifiedAt +
                    " for " +
                    key +
                    " while the pre-Journal source persists " +
                    node.createdAt +
                    "/" +
                    node.modifiedAt +
                    "; §6 regenerates no timestamp"
            );
        }
        const projectedFresh = occurrence.fresh;
        const impliedFresh = implied.get(key) === true;
        if (projectedFresh !== impliedFresh) {
            return forked(
                "the canonical artifact replays " +
                    key +
                    " as " +
                    (projectedFresh ? "fresh" : "stale") +
                    " while the pre-Journal source's own persisted evidence implies " +
                    (impliedFresh ? "fresh" : "stale") +
                    "; bootstrap records the source's stale evidence and lets replay derive freshness, so the " +
                    "two readings must agree"
            );
        }
        if (!sameKeySet([...occurrence.validInputs], node.directInputKeys.map(nodeKeyToCanonicalString))) {
            return forked(
                "the canonical artifact replays the validity of " +
                    key +
                    " differently from the direct legacy inputs the pre-Journal source still persists"
            );
        }
    }
    for (const occurrence of projection.occurrences) {
        if (legacyState.nodeAt(occurrence.nodeKeyString) === undefined) {
            return forked(
                "the canonical artifact this replica authored materializes " +
                    occurrence.nodeKeyString +
                    " while the pre-Journal source does not persist it"
            );
        }
    }
    if (projection.lastNodeIndex !== legacyState.lastNodeIndex) {
        return forked(
            "the canonical artifact reconstructs the allocator watermark " +
                projection.lastNodeIndex +
                " while the pre-Journal source persists last_node_index " +
                legacyState.lastNodeIndex
        );
    }

    return new ResumedCanonicalCreatorClass(
        artifact.records,
        artifact.bootstrapFrontier,
        projection,
        artifact.databaseVersion
    );
}

module.exports = {
    deriveLegacyFreshness,
    isResumedCanonicalCreator,
    resumeCanonicalBootstrapCreator,
};