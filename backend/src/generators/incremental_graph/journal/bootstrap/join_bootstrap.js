/**
 * §7 joining the canonical bootstrap: the historical merge a second replica
 * performs against the cohort's frozen canonical cut.
 *
 * `incremental-graph-journal-migrations.md` §7 keeps this a merge and not a reset:
 * the joining installation keeps its own fingerprint and allocator state, and its
 * legacy graph is read directly from supported persisted state rather than
 * produced by rerunning a legacy migration to the canonical target. The joins of
 * `incremental-graph-journal-replay.md` decide everything the bootstrap passes do
 * not decide, which is why this module replays its own intermediate cuts with the
 * oracle instead of predicting selection.
 *
 * The passes, in the order §7 fixes:
 *
 * - **J1** establishes one occurrence per materialized joining node: an exact
 *   occurrence shared with the canonical basis keeps the canonical `ValueId` and
 *   authors nothing, and every other occurrence becomes a joining-writer
 *   historical `ValueEvent` under the §7.1 context exception, allocated in
 *   `(modifiedAt, canonical NodeKey)` order with authority seeded from its own
 *   legacy `modifiedAt`. A canonical node the joining graph does not materialize
 *   is never a deletion, so no `DeleteEvent` exists in this path at all.
 * - **J2** gives each locally authored selected occurrence a certificate whose
 *   basis names the joining occurrences it was actually validated against, so a
 *   conflict winner on an input side retires that edge instead of manufacturing a
 *   cross-replica proof it never had; an exact-shared occurrence keeps the
 *   canonical certificate and receives a proof-scoped barrier for every canonical
 *   validity edge the joining graph does not hold, plus the conservative OR of
 *   both sides' direct stale evidence.
 * - **J2b** persists recursive-only staleness in one input-to-dependent
 *   topological pass, evaluated at the replay cut J2 reached.
 * - **J3** records the joining writer's own `last_node_index` when the join has not
 *   already reconstructed it.
 *
 * Authority for every joining proof, stale and writer-state record is the
 * deterministic `{physical: H.physical, logical: H.logical + 1}` successor of the
 * greatest authority in the cut, so the join consults no clock. Proof, stale and
 * writer-state records carry the canonical bootstrap frontier in their contexts,
 * which is what lets later joining evidence reference any joining legacy
 * occurrence; only the historical value records use the §7.1 own-writer-only
 * context exception.
 *
 * The module is pure. It performs no I/O and returns the value the caller
 * installs: the joined record set, its frontier, and the joined projection at the
 * bootstrap target version.
 */

const { nodeKeyStringToString } = require("../../database");
const {
    makeJournalBootstrapForkError,
    makeJournalPublicationError,
} = require("../errors");
const {
    journalAuthorToString,
    journalRecordIdToString,
    journalSequenceAtFrontier,
    isJournalAuthor,
    makeJournalRecordId,
} = require("../types");
const { makeValueScope } = require("../basis");
const { makeInvalidateEvent, makeWriterStateRecord } = require("../records");
const { makeJournalReplica, replicaFrontier } = require("../replica");
const { validateJournalReplica } = require("../well_formedness");
const { makeReplicaSource, makeUnionSource, projectRetainedJournal } = require("../oracle");
const { canonicalArtifactReplica, isCanonicalBootstrapSnapshot } = require("./canonical_artifact");
const { isLegacyBootstrapState } = require("./legacy_state");
const {
    JoiningCursorClass,
    greatestHeldAuthority,
    holdsStaleEvidence,
    topologicalOrder,
} = require("./joining_support");
const { establishJoiningOccurrences } = require("./join_occurrences");
const { authorJoiningProof } = require("./join_proof");

/** @typedef {import('../errors').AnyJournalError} JournalError */
/** @typedef {import('../types').AuthorityTime} AuthorityTime */
/** @typedef {import('../types').JournalAuthor} JournalAuthor */
/** @typedef {import('../types').JournalFrontier} JournalFrontier */
/** @typedef {import('../types').JournalRecordId} JournalRecordId */
/** @typedef {import('../types').JournalSequence} JournalSequence */
/** @typedef {import('../records').JournalRecord} JournalRecord */
/** @typedef {import('../basis').NodeKey} NodeKey */
/** @typedef {import('./joining_support').CurrentInputKeysOfNode} CurrentInputKeysOfNode */
/** @typedef {import('../basis').ValidationBasis} ValidationBasis */
/** @typedef {import('../replica').JournalReplica} JournalReplica */
/** @typedef {import('../oracle/projection').Projection} Projection */
/** @typedef {import('../oracle/projection').ProjectedOccurrence} ProjectedOccurrence */
/** @typedef {import('../../database/types').Version} Version */
/** @typedef {import('./canonical_artifact').CanonicalBootstrapSnapshot} CanonicalBootstrapSnapshot */
/** @typedef {import('./legacy_state').LegacyBootstrapState} LegacyBootstrapState */
/** @typedef {import('./legacy_state').LegacyNode} LegacyNode */

/**
 * @typedef {object} JoinCanonicalBootstrapRequest
 * @property {LegacyBootstrapState} legacyState - The joining replica's validated
 *   persisted pre-Journal graph, read directly and never rerun as a migration.
 * @property {CanonicalBootstrapSnapshot} artifact - The held canonical artifact to
 *   join.
 * @property {JournalAuthor} joiningWriter - The joining replica's own durable
 *   `DatabaseFingerprint`, which keeps its identity and allocator state local.
 * @property {CurrentInputKeysOfNode} currentInputKeysOfNode - The current graph
 *   schema's direct inputs per node, which fixes the replay's proof and freshness
 *   rules for both replicas.
 */

/**
 * The joined bootstrap the caller installs.
 *
 * The properties that this class carries are:
 * - `records` is the canonical cut followed by the joining replica's own bootstrap
 *   records, and contains no `DeleteEvent`, because legacy cache absence is not
 *   timestamped deletion evidence;
 * - `frontier` is the frontier those records reach;
 * - `projection` is the joined cut replayed under `joiningWriter`, in which the
 *   exact-shared occurrences keep their canonical `ValueId`s, the canonical-only
 *   and joining-only materializations both survive, and the allocator watermark is
 *   the joining source's own `last_node_index`;
 * - `databaseVersion` is the bootstrap target the pair is installed at.
 *
 * The proof of those properties is guaranteed by:
 * - `joinCanonicalBootstrap(request)`: builds exactly the passes §7 fixes, validates
 *   the joined record set as a replica and replays the joined cut before
 *   returning, and reports `JournalBootstrapForkError` instead of returning when a
 *   required §7.5 result does not hold.
 *
 * @param {ReadonlyArray<JournalRecord>} records
 * @param {JournalFrontier} frontier
 * @param {Projection} projection
 * @param {Version} databaseVersion
 * @param {JournalAuthor} joiningWriter
 */
class JoinedCanonicalBootstrapClass {
    /**
     * @param {ReadonlyArray<JournalRecord>} records
     * @param {JournalFrontier} frontier
     * @param {Projection} projection
     * @param {Version} databaseVersion
     * @param {JournalAuthor} joiningWriter
     */
    constructor(records, frontier, projection, databaseVersion, joiningWriter) {
        this.records = Object.freeze(records.slice());
        this.frontier = frontier;
        this.projection = projection;
        this.databaseVersion = databaseVersion;
        this.joiningWriter = joiningWriter;
        Object.freeze(this);
    }
}

/** @typedef {JoinedCanonicalBootstrapClass} JoinedCanonicalBootstrap */

/**
 * @param {unknown} value
 * @returns {value is JoinedCanonicalBootstrap}
 */
function isJoinedCanonicalBootstrap(value) {
    return value instanceof JoinedCanonicalBootstrapClass;
}
/**
 * Join the cohort's canonical bootstrap artifact to this replica's persisted
 * pre-Journal graph.
 *
 * @param {JoinCanonicalBootstrapRequest} request
 * @returns {JoinedCanonicalBootstrap | JournalError}
 */
function joinCanonicalBootstrap(request) {
    const { legacyState, artifact, joiningWriter, currentInputKeysOfNode } = request;
    if (!isLegacyBootstrapState(legacyState)) {
        return makeJournalPublicationError(
            "joining the canonical bootstrap requires a validated pre-Journal source state"
        );
    }
    if (!isCanonicalBootstrapSnapshot(artifact)) {
        return makeJournalPublicationError(
            "joining the canonical bootstrap requires a canonical artifact"
        );
    }
    if (!isJournalAuthor(joiningWriter)) {
        return makeJournalPublicationError("joining the canonical bootstrap names no joining writer");
    }
    if (typeof currentInputKeysOfNode !== "function") {
        return makeJournalPublicationError(
            "joining the canonical bootstrap requires the current graph schema's direct inputs"
        );
    }
    const joiningName = journalAuthorToString(joiningWriter);
    if (joiningName === journalAuthorToString(artifact.creatorWriter)) {
        return makeJournalPublicationError(
            "joining the canonical bootstrap requires a joining fingerprint distinct from the artifact's creator " +
                joiningName +
                "; a replica which authored the canonical cut resumes it instead"
        );
    }

    const canonicalRecords = artifact.records;
    const canonicalReplica = canonicalArtifactReplica(artifact);
    const creatorFrontierSequence = journalSequenceAtFrontier(
        artifact.bootstrapFrontier,
        artifact.creatorWriter
    );

    const initialAuthority = greatestHeldAuthority(canonicalRecords, []);
    if (initialAuthority instanceof Error) {
        return initialAuthority;
    }
    const cursor = new JoiningCursorClass(
        joiningWriter,
        artifact.creatorWriter,
        creatorFrontierSequence,
        initialAuthority
    );

    /**
     * Replay the canonical cut together with the joining records authored so far.
     * @returns {Projection | JournalError}
     */
    function replayJoined() {
        const joiningReplica = makeJournalReplica([[joiningWriter, cursor.records]]);
        if (joiningReplica instanceof Error) {
            return joiningReplica;
        }
        return projectRetainedJournal({
            source: makeUnionSource([
                makeReplicaSource(canonicalReplica),
                makeReplicaSource(joiningReplica),
            ]),
            localWriter: joiningWriter,
            currentInputKeysOfNode,
        });
    }

    const canonicalProjection = projectRetainedJournal({
        source: makeReplicaSource(canonicalReplica),
        localWriter: joiningWriter,
        currentInputKeysOfNode,
    });
    if (canonicalProjection instanceof Error) {
        return canonicalProjection;
    }
    const canonicalOccurrences = new Map(
        canonicalProjection.occurrences.map((occurrence) => [occurrence.nodeKeyString, occurrence])
    );
    // Pass J1: one occurrence per materialized joining node.
    const occurrences = establishJoiningOccurrences({
        legacyState,
        canonicalOccurrences,
        cursor,
        replay: replayJoined,
    });
    if (occurrences instanceof Error) {
        return occurrences;
    }

    // Pass J2: local proof and the exact-shared proof barriers.
    const proofFailure = authorJoiningProof({
        legacyState,
        canonicalRecords,
        valueIdOf: occurrences.valueIdOf,
        locallyAuthored: occurrences.locallyAuthored,
        selected: occurrences.selected,
        cursor,
        currentInputKeysOfNode,
    });
    if (proofFailure !== undefined) {
        return proofFailure;
    }

    // Pass J2b: persist recursive-only staleness at the cut J2 reached.
    const afterProof = replayJoined();
    if (afterProof instanceof Error) {
        return afterProof;
    }
    const presentAfterProof = afterProof.occurrences.map((occurrence) => occurrence.nodeKeyString);
    const order = topologicalOrder(presentAfterProof, currentInputKeysOfNode);
    if (order instanceof Error) {
        return order;
    }
    for (const key of order) {
        if (!afterProof.selfProofReadyNodes.has(key)) {
            continue;
        }
        const selected = afterProof.occurrences.find(
            (occurrence) => occurrence.nodeKeyString === key
        );
        if (selected === undefined) {
            continue;
        }
        const valueIdText = journalRecordIdToString(selected.valueId);
        if (holdsStaleEvidence([...canonicalRecords, ...cursor.records], key, valueIdText)) {
            continue;
        }
        const staleInput = (currentInputKeysOfNode(key) ?? []).some((input) => {
            const inputNode = afterProof.freshness.get(input);
            return inputNode !== undefined && !inputNode.fresh;
        });
        if (!staleInput) {
            continue;
        }
        const allocated = cursor.allocate(false, undefined);
        if ("error" in allocated) {
            return allocated.error;
        }
        const record = makeInvalidateEvent(
            { ...allocated.fields, node: selected.nodeKey },
            makeValueScope(selected.valueId),
            "bootstrap"
        );
        if (record instanceof Error) {
            return record;
        }
        cursor.append(record);
    }

    // Pass J3: the joining writer's own allocator watermark, when the join has not
    // already reconstructed it.
    if (afterProof.lastNodeIndex !== legacyState.lastNodeIndex) {
        const sequence = cursor.nextSequence();
        if (sequence instanceof Error) {
            return sequence;
        }
        const id = makeJournalRecordId(joiningWriter, sequence);
        if (id instanceof Error) {
            return id;
        }
        const record = makeWriterStateRecord(id, legacyState.lastNodeIndex);
        if (record instanceof Error) {
            return record;
        }
        cursor.append(record);
        cursor.lastSequence = sequence;
    }

    const joined = replayJoined();
    if (joined instanceof Error) {
        return joined;
    }
    const joinedReplica = makeJournalReplica([
        [artifact.creatorWriter, canonicalRecords],
        [joiningWriter, cursor.records],
    ]);
    if (joinedReplica instanceof Error) {
        return joinedReplica;
    }
    const wellFormed = validateJournalReplica(joinedReplica);
    if (wellFormed !== undefined) {
        return wellFormed;
    }

    /**
     * @param {string} detail
     * @returns {JournalError}
     */
    const forked = (detail) =>
        makeJournalBootstrapForkError(joiningName, journalAuthorToString(artifact.creatorWriter), detail);
    const joinedOccurrences = new Map(
        joined.occurrences.map((occurrence) => [occurrence.nodeKeyString, occurrence])
    );
    for (const [key, occurrence] of canonicalOccurrences) {
        if (!joinedOccurrences.has(key)) {
            return forked(
                "the canonical materialization " + key + " does not survive the joining bootstrap"
            );
        }
        if (!occurrences.exactShared.has(key)) {
            continue;
        }
        const survivor = joinedOccurrences.get(key);
        if (
            survivor !== undefined &&
            journalRecordIdToString(survivor.valueId) !== journalRecordIdToString(occurrence.valueId)
        ) {
            return forked(
                "the exact-shared occurrence " + key + " lost the canonical ValueId in the joining bootstrap"
            );
        }
    }
    for (const legacyNode of legacyState.nodes) {
        const key = nodeKeyStringToString(legacyNode.nodeKeyString);
        if (!joinedOccurrences.has(key)) {
            return forked("the joining materialization " + key + " does not survive the join");
        }
    }
    if (joined.lastNodeIndex !== legacyState.lastNodeIndex) {
        return forked(
            "the joined allocator watermark is " +
                joined.lastNodeIndex +
                " while the joining source persists last_node_index " +
                legacyState.lastNodeIndex +
                ", so the joining allocator state is not local"
        );
    }
    const frontier = replicaFrontier(joinedReplica);
    return new JoinedCanonicalBootstrapClass(
        [...canonicalRecords, ...cursor.records],
        frontier,
        joined,
        artifact.databaseVersion,
        joiningWriter
    );
}

module.exports = {
    isJoinedCanonicalBootstrap,
    joinCanonicalBootstrap,
};