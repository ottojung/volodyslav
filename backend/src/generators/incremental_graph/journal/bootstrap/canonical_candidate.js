/**
 * Staging the canonical bootstrap candidate, `incremental-graph-journal-migrations.md` §§3–5.
 *
 * The canonical artifact is the original frozen bootstrap cut, so the candidate is
 * a pure function of persisted legacy state. Two independent stagings of
 * byte-identical legacy state must produce byte-identical records: that is
 * `incremental-graph-journal-api.md` §Canonical bootstrap operations, and it is
 * what makes a lost publication outcome recoverable by retrying the same
 * conditional publication instead of inventing a second candidate (§6).
 *
 * Determinism comes from two allocation rules, both normative:
 *
 * - C1 seeds each `ValueEvent`'s authority from the occurrence's own persisted
 *   `modifiedAt` and enumerates nodes in nondecreasing `(modifiedAt, canonical
 *   NodeKey)` order (`incremental-graph-journal-types.md` §Pre-Journal bootstrap
 *   ValueEvent authority exception). Writer sequence therefore never contradicts
 *   authority ordering;
 * - after every C1 record is allocated, the high-water is initialized to the
 *   greatest C1 `AuthorityTime` and every C2/C3 record takes
 *   `{physical: H.physical, logical: H.logical + 1}` in deterministic record
 *   order (§Canonical creator post-value authority), so no upgrade or publication
 *   wall clock enters the candidate.
 *
 * The canonical creator starts its Journal at frontier zero and is the only writer
 * in the candidate, so every context is the exact own-writer prefix `q - 1` and
 * causal closure is a property of that construction rather than something this
 * module re-checks.
 *
 * This module is pure. It reads no database, allocates no identifier, and consults
 * no clock.
 */

const { epochMillisecondsOf } = require("../emission");
const { makeJournalPublicationError } = require("../errors");
const {
    makeValidationBasisEntry,
    makeValueScope,
    nodeKeyToCanonicalString,
} = require("../basis");
const {
    compareAuthorityTime,
    makeAuthorityTime,
    makeJournalFrontier,
    journalSequenceToString,
    makeJournalRecordId,
    makeJournalSequence,
} = require("../types");
const {
    predecessorJournalSequence,
    requireSuccessorJournalSequence,
} = require("../coordinates");
const {
    makeInvalidateEvent,
    makeValidateEvent,
    makeValueEvent,
    makeWriterStateRecord,
} = require("../records");
const { isLegacyBootstrapState } = require("./legacy_state");

/** @typedef {import('../errors').AnyJournalError} JournalError */
/** @typedef {import('../records').JournalRecord} JournalRecord */
/** @typedef {import('../types').AuthorityTime} AuthorityTime */
/** @typedef {import('../types').JournalAuthor} JournalAuthor */
/** @typedef {import('../types').JournalFrontier} JournalFrontier */
/** @typedef {import('../types').JournalRecordId} JournalRecordId */
/** @typedef {import('../types').JournalSequence} JournalSequence */
/** @typedef {import('../basis').ValidationBasis} ValidationBasis */
/** @typedef {import('../../database/types').Version} Version */
/** @typedef {import('./legacy_state').LegacyBootstrapState} LegacyBootstrapState */
/** @typedef {import('./legacy_state').LegacyNode} LegacyNode */

/**
 * One node's canonical C1 occurrence identity, which Passes C2 and C3 name.
 *
 * The properties that this typedef carries are:
 * - `nodeKeyString` is the canonical persisted identity of the converted node;
 * - `valueId` is the `ValueId` Pass C1 allocated for it.
 *
 * The proof of those properties is guaranteed by:
 * - this typedef cannot enforce the properties by construction, since it records
 *   one allocation this module performed;
 * - therefore every function which constructs a `BootstrapValueId` is part of the
 *   proof. The current construction site is:
 *   - `stageCanonicalBootstrap(request)`: satisfies the property because it fills
 *     the map only from the `ValueEvent` it has just built for that node, so the
 *     recorded `valueId` is that event's own id.
 *
 * @typedef {object} BootstrapValueId
 * @property {string} nodeKeyString
 * @property {JournalRecordId} valueId
 */

/**
 * @typedef {object} CanonicalBootstrapRequest
 * @property {LegacyBootstrapState} legacyState - The validated supported pre-Journal source.
 * @property {JournalAuthor} creatorWriter - The source replica's durable `DatabaseFingerprint`,
 *   used as `JournalAuthor`.
 * @property {Version} targetVersion - The bootstrap target database version.
 */

/**
 * The properties that this class carries are:
 * - `records` is the exact canonical bootstrap cut: a contiguous own-writer range
 *   starting at sequence 1, with deterministic contexts, deterministic authority
 *   times and no wall-clock input;
 * - `creatorWriter` is the writer which authored every record in it;
 * - `bootstrapFrontier` is the creator frontier immediately after those records
 *   and before any ordinary post-bootstrap operation;
 * - `targetVersion` and `graphSchemeString` are the bootstrap target this
 *   candidate is built for, and §3 supports joining it only on exact equality with
 *   the running release's configured bootstrap target.
 *
 * The proof of those properties is guaranteed by:
 * - `stageCanonicalBootstrap(request)`: reads no clock and no database, enumerates
 *   C1 by `(modifiedAt, canonical NodeKey)` and C2/C3 by canonical NodeKey,
 *   allocates every C2/C3 authority strictly above the greatest C1 authority, and
 *   builds the frontier from the last allocated sequence.
 *
 * @param {ReadonlyArray<JournalRecord>} records
 * @param {JournalAuthor} creatorWriter
 * @param {JournalFrontier} bootstrapFrontier
 * @param {Version} targetVersion
 * @param {string} graphSchemeString
 */
class CanonicalBootstrapCandidateClass {
    /**
     * @param {ReadonlyArray<JournalRecord>} records
     * @param {JournalAuthor} creatorWriter
     * @param {JournalFrontier} bootstrapFrontier
     * @param {Version} targetVersion
     * @param {string} graphSchemeString
     */
    constructor(records, creatorWriter, bootstrapFrontier, targetVersion, graphSchemeString) {
        this.records = Object.freeze(records.slice());
        this.creatorWriter = creatorWriter;
        this.bootstrapFrontier = bootstrapFrontier;
        this.targetVersion = targetVersion;
        this.graphSchemeString = graphSchemeString;
        Object.freeze(this);
    }
}

/** @typedef {CanonicalBootstrapCandidateClass} CanonicalBootstrapCandidate */

/**
 * @param {unknown} value
 * @returns {value is CanonicalBootstrapCandidate}
 */
function isCanonicalBootstrapCandidate(value) {
    return value instanceof CanonicalBootstrapCandidateClass;
}

/**
 * The context of the record at own-writer coordinate `q` of a single-writer
 * candidate: the exact own-writer prefix `q - 1`, which is what
 * `incremental-graph-journal-types.md` §Causal context requires.
 * @param {JournalAuthor} writer
 * @param {JournalSequence} sequence
 * @returns {JournalFrontier | JournalError}
 */
function exactOwnWriterContext(writer, sequence) {
    const ownPrefix = predecessorJournalSequence(sequence);
    if (ownPrefix instanceof Error) {
        return ownPrefix;
    }
    return makeJournalFrontier([[writer, ownPrefix]]);
}

/**
 * The deterministic creator authority of one C2/C3 record:
 * `{physical: H.physical, logical: H.logical + 1}`, with `H` advanced to it.
 * @param {AuthorityTime} highWater
 * @returns {{authorityTime: AuthorityTime, highWater: AuthorityTime} | {error: JournalError}}
 */
function allocateDeterministicAuthority(highWater) {
    const logical = requireSuccessorJournalSequence(highWater.logical);
    if (logical instanceof Error) {
        return { error: logical };
    }
    const authorityTime = makeAuthorityTime(highWater.physical, journalSequenceToString(logical));
    if (authorityTime instanceof Error) {
        return { error: authorityTime };
    }
    return { authorityTime, highWater: authorityTime };
}

/**
 * Total order on two authority times by `(physical, logical)`.
 * @param {AuthorityTime} left
 * @param {AuthorityTime} right
 * @returns {number}
 */
function compareAuthorityAscending(left, right) {
    if (left.physical !== right.physical) {
        return left.physical < right.physical ? -1 : 1;
    }
    return compareAuthorityTime(left, right);
}

/**
 * Pass C1's order: nondecreasing `(modifiedAt, canonical NodeKey)`, so
 * same-writer sequence order does not contradict authority ordering.
 * @param {LegacyBootstrapState} legacyState
 * @returns {ReadonlyArray<LegacyNode>}
 */
function canonicalValueOrder(legacyState) {
    return legacyState.nodes.slice().sort((left, right) => {
        if (left.modifiedAt !== right.modifiedAt) {
            return left.modifiedAt < right.modifiedAt ? -1 : 1;
        }
        const leftKey = nodeKeyToCanonicalString(left.node);
        const rightKey = nodeKeyToCanonicalString(right.node);
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
}

/**
 * Stage the canonical bootstrap candidate from persisted legacy state.
 *
 * Passes C1 through C4 of `incremental-graph-journal-migrations.md` §5, in that
 * order: one `ValueEvent` per materialized legacy occurrence carrying the source
 * replica's persisted identifier and timestamps unchanged, one self-describing
 * `ValidateEvent` per materialized node whose basis names exactly one entry per
 * direct legacy input, one value-scoped `InvalidateEvent` per legacy-stale node
 * after its own certificate, and the creator's legacy `last_node_index` as a
 * `WriterStateRecord`. No migration callback runs, no identifier is minted and no
 * timestamp is synthesized.
 *
 * @param {CanonicalBootstrapRequest} request
 * @returns {CanonicalBootstrapCandidate | JournalError}
 */
function stageCanonicalBootstrap(request) {
    const { legacyState, creatorWriter, targetVersion } = request;
    if (!isLegacyBootstrapState(legacyState)) {
        return makeJournalPublicationError(
            "canonical bootstrap staging requires a validated pre-Journal source state"
        );
    }
    if (legacyState.nodes.length === 0) {
        return makeJournalPublicationError(
            "canonical bootstrap staging requires a source which materializes at least one node"
        );
    }

    /** @type {JournalRecord[]} */
    const records = [];
    /** @type {Map<string, JournalRecordId>} */
    const valueIds = new Map();
    const first = makeJournalSequence("1");
    if (first instanceof Error) {
        return first;
    }
    /** @type {JournalSequence} */
    let nextSequence = first;
    /** @type {AuthorityTime | undefined} */
    let greatestC1 = undefined;

    for (const legacyNode of canonicalValueOrder(legacyState)) {
        const nodeKey = nodeKeyToCanonicalString(legacyNode.node);
        const id = makeJournalRecordId(creatorWriter, nextSequence);
        if (id instanceof Error) {
            return id;
        }
        const context = exactOwnWriterContext(creatorWriter, id.sequence);
        if (context instanceof Error) {
            return context;
        }
        const physical = epochMillisecondsOf(legacyNode.modifiedAt);
        if (!Number.isSafeInteger(physical) || physical < 0) {
            return makeJournalPublicationError(
                "the pre-Journal source persists the modifiedAt " +
                    JSON.stringify(legacyNode.modifiedAt) +
                    ", which is not a canonical whole-millisecond instant, so no canonical authority " +
                    "can be seeded from it"
            );
        }
        const authorityTime = makeAuthorityTime(physical, "0");
        if (authorityTime instanceof Error) {
            return authorityTime;
        }
        const record = makeValueEvent(
            { id, context, authorityTime, node: legacyNode.node },
            legacyNode.nodeIdentifier,
            legacyNode.payload,
            legacyNode.createdAt,
            legacyNode.modifiedAt,
            "bootstrap"
        );
        if (record instanceof Error) {
            return record;
        }
        records.push(record);
        valueIds.set(nodeKey, id);
        if (greatestC1 === undefined || compareAuthorityAscending(authorityTime, greatestC1) > 0) {
            greatestC1 = authorityTime;
        }
        const successor = requireSuccessorJournalSequence(nextSequence);
        if (successor instanceof Error) {
            return successor;
        }
        nextSequence = successor;
    }

    if (greatestC1 === undefined) {
        return makeJournalPublicationError("canonical bootstrap staging authored no value record");
    }

    // Pass C2: one self-describing certificate per materialized node, in canonical
    // persisted NodeKey order, naming exactly one entry per direct legacy input.
    for (const legacyNode of legacyState.nodes) {
        const nodeKey = nodeKeyToCanonicalString(legacyNode.node);
        const own = valueIds.get(nodeKey);
        if (own === undefined) {
            return makeJournalPublicationError(
                "canonical bootstrap staging lost the Pass C1 occurrence of " + nodeKey
            );
        }
        const id = makeJournalRecordId(creatorWriter, nextSequence);
        if (id instanceof Error) {
            return id;
        }
        const context = exactOwnWriterContext(creatorWriter, id.sequence);
        if (context instanceof Error) {
            return context;
        }
        const allocated = allocateDeterministicAuthority(greatestC1);
        if ("error" in allocated) {
            return allocated.error;
        }
        greatestC1 = allocated.highWater;
        /** @type {ValidationBasis} */
        const basis = [];
        for (const input of legacyNode.directInputKeys) {
            // A legacy validity edge naming a node this replica does not materialize
            // is still recorded, as "unknown": §5.2 requires one entry per direct
            // legacy input, and the certificate states what the legacy graph held.
            const named = valueIds.get(nodeKeyToCanonicalString(input));
            basis.push(makeValidationBasisEntry(input, named === undefined ? "unknown" : named));
        }
        const record = makeValidateEvent(
            { id, context, authorityTime: allocated.authorityTime, node: legacyNode.node },
            own,
            basis,
            "bootstrap"
        );
        if (record instanceof Error) {
            return record;
        }
        records.push(record);
        const successor = requireSuccessorJournalSequence(nextSequence);
        if (successor instanceof Error) {
            return successor;
        }
        nextSequence = successor;
    }

    // Pass C3: one value-scoped invalidation per legacy-stale node, after its own
    // certificate, in canonical persisted NodeKey order.
    for (const legacyNode of legacyState.nodes) {
        if (legacyNode.upToDate) {
            continue;
        }
        const own = valueIds.get(nodeKeyToCanonicalString(legacyNode.node));
        if (own === undefined) {
            return makeJournalPublicationError(
                "canonical bootstrap staging lost the Pass C1 occurrence of " +
                    nodeKeyToCanonicalString(legacyNode.node)
            );
        }
        const id = makeJournalRecordId(creatorWriter, nextSequence);
        if (id instanceof Error) {
            return id;
        }
        const context = exactOwnWriterContext(creatorWriter, id.sequence);
        if (context instanceof Error) {
            return context;
        }
        const allocated = allocateDeterministicAuthority(greatestC1);
        if ("error" in allocated) {
            return allocated.error;
        }
        greatestC1 = allocated.highWater;
        const record = makeInvalidateEvent(
            { id, context, authorityTime: allocated.authorityTime, node: legacyNode.node },
            makeValueScope(own),
            "bootstrap"
        );
        if (record instanceof Error) {
            return record;
        }
        records.push(record);
        const successor = requireSuccessorJournalSequence(nextSequence);
        if (successor instanceof Error) {
            return successor;
        }
        nextSequence = successor;
    }

    // Pass C4: the creator's durable allocator watermark, exactly as the source
    // persisted it.
    const writerStateId = makeJournalRecordId(creatorWriter, nextSequence);
    if (writerStateId instanceof Error) {
        return writerStateId;
    }
    const writerState = makeWriterStateRecord(writerStateId, legacyState.lastNodeIndex);
    if (writerState instanceof Error) {
        return writerState;
    }
    records.push(writerState);

    const bootstrapFrontier = makeJournalFrontier([[creatorWriter, writerStateId.sequence]]);
    if (bootstrapFrontier instanceof Error) {
        return bootstrapFrontier;
    }
    return new CanonicalBootstrapCandidateClass(
        records,
        creatorWriter,
        bootstrapFrontier,
        targetVersion,
        legacyState.graphSchemeString
    );
}

module.exports = {
    isCanonicalBootstrapCandidate,
    stageCanonicalBootstrap,
};