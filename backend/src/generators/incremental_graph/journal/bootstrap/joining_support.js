/**
 * The allocation and inspection helpers §7's joining passes share.
 *
 * `incremental-graph-journal-migrations.md` §7 builds the joining replica's own
 * bootstrap prefix one record at a time, and each of those records needs the same
 * four answers: the next own-writer coordinate, the deterministic authority above
 * everything the join holds, the context shape the pass is allowed, and the read
 * of the canonical or persisted state the pass compares against. This module holds
 * them, so the joining procedure in `join_bootstrap.js` reads as the sequence of
 * normative passes rather than as coordinate arithmetic.
 *
 * `JoiningCursorClass` is the one stateful value here, and its three properties are
 * the ones §7.1, §5.1 and §7.2 rely on: its records are a contiguous own-writer
 * prefix starting at sequence 1, its authority is always the deterministic
 * successor of the greatest authority in the whole join, and a historical value
 * allocation carries the exact own-writer prefix while every later allocation also
 * names the canonical bootstrap frontier.
 *
 * Everything here is pure: no clock, no database, no transport.
 */

const {
    deserializeNodeKey,
    nodeIdentifierToString,
    stringToNodeKeyString,
} = require("../../database");
const { makeJournalPublicationError } = require("../errors");
const {
    journalRecordIdToString,
    journalSequenceToString,
    makeAuthorityTime,
    makeJournalFrontier,
    makeJournalRecordId,
    makeJournalSequence,
} = require("../types");
const { isNodeKey, nodeKeyToCanonicalString } = require("../basis");
const { isInvalidateEvent, isValidateEvent } = require("../records");
const {
    predecessorJournalSequence,
    requireSuccessorJournalSequence,
} = require("../coordinates");

/** @typedef {import('../errors').AnyJournalError} JournalError */
/** @typedef {import('../types').AuthorityTime} AuthorityTime */
/** @typedef {import('../types').JournalAuthor} JournalAuthor */
/** @typedef {import('../types').JournalFrontier} JournalFrontier */
/** @typedef {import('../types').JournalRecordId} JournalRecordId */
/** @typedef {import('../types').JournalSequence} JournalSequence */
/** @typedef {import('../records').JournalRecord} JournalRecord */
/** @typedef {import('../basis').NodeKey} NodeKey */
/** @typedef {import('../oracle/projection').ProjectedOccurrence} ProjectedOccurrence */
/** @typedef {import('./legacy_state').LegacyBootstrapState} LegacyBootstrapState */
/** @typedef {import('./legacy_state').LegacyNode} LegacyNode */

/**
 * The current graph schema's direct inputs of one node, keyed by canonical
 * persisted NodeKey identity. A node the schema does not describe has no entry.
 * @callback CurrentInputKeysOfNode
 * @param {string} nodeKeyString
 * @returns {ReadonlyArray<string> | undefined}
 */

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
    const leftLogical = Number(journalSequenceToString(left.logical));
    const rightLogical = Number(journalSequenceToString(right.logical));
    if (leftLogical === rightLogical) {
        return 0;
    }
    return leftLogical < rightLogical ? -1 : 1;
}

/**
 * The greatest authority over every record the join holds, canonical records
 * included.
 * @param {ReadonlyArray<JournalRecord>} canonicalRecords
 * @param {ReadonlyArray<JournalRecord>} joiningRecords
 * @returns {AuthorityTime | JournalError}
 */
function greatestHeldAuthority(canonicalRecords, joiningRecords) {
    /** @type {AuthorityTime | undefined} */
    let greatest;
    for (const record of [...canonicalRecords, ...joiningRecords]) {
        if (!("authorityTime" in record)) {
            continue;
        }
        const authorityTime = record.authorityTime;
        if (greatest === undefined || compareAuthorityAscending(authorityTime, greatest) > 0) {
            greatest = authorityTime;
        }
    }
    if (greatest === undefined) {
        return makeJournalPublicationError(
            "the canonical cut holds no authority time, so no deterministic joining authority exists"
        );
    }
    return greatest;
}

/**
 * The joining replica's bootstrap prefix, allocated one record at a time.
 *
 * The properties that this class carries are:
 * - `records` is a contiguous own-writer prefix starting at sequence 1, in
 *   allocation order;
 * - `highWater` is the greatest authority over every record the join holds, and
 *   every allocated record takes its deterministic successor, so no wall clock
 *   enters the join;
 * - a historical value allocation's context is the exact own-writer prefix, the
 *   §7.1 exception, while every later allocation's context also names the canonical
 *   bootstrap frontier.
 */
class JoiningCursorClass {
    /**
     * @param {JournalAuthor} joiningWriter
     * @param {JournalAuthor} creatorWriter
     * @param {JournalSequence} creatorFrontierSequence
     * @param {AuthorityTime} highWater
     */
    constructor(joiningWriter, creatorWriter, creatorFrontierSequence, highWater) {
        this.joiningWriter = joiningWriter;
        this.creatorWriter = creatorWriter;
        this.creatorFrontierSequence = creatorFrontierSequence;
        this.highWater = highWater;
        /** @type {JournalRecord[]} */
        this.records = [];
        /** @type {JournalSequence | undefined} */
        this.lastSequence = undefined;
    }

    /**
     * The next own-writer coordinate.
     * @returns {JournalSequence | JournalError}
     */
    nextSequence() {
        if (this.lastSequence === undefined) {
            return makeJournalSequence("1");
        }
        return requireSuccessorJournalSequence(this.lastSequence);
    }

    /**
     * Allocate the next own-writer coordinate, its deterministic authority, and the
     * context shape this pass requires.
     * @param {boolean} historicalValue - The §7.1 context exception, which omits
     *   the canonical bootstrap frontier.
     * @param {number | undefined} physical - The whole millisecond to seed a
     *   historical value's authority from, or `undefined` to take the deterministic
     *   successor of the high-water mark.
     * @returns {{fields: {id: JournalRecordId, context: JournalFrontier, authorityTime: AuthorityTime}} | {error: JournalError}}
     */
    allocate(historicalValue, physical) {
        const sequence = this.nextSequence();
        if (sequence instanceof Error) {
            return { error: sequence };
        }
        const id = makeJournalRecordId(this.joiningWriter, sequence);
        if (id instanceof Error) {
            return { error: id };
        }
        const predecessor = predecessorJournalSequence(sequence);
        if (predecessor instanceof Error) {
            return { error: predecessor };
        }
        /** @type {AuthorityTime} */
        let authorityTime;
        if (physical === undefined) {
            const next = makeAuthorityTime(
                this.highWater.physical,
                String(Number(journalSequenceToString(this.highWater.logical)) + 1)
            );
            if (next instanceof Error) {
                return { error: next };
            }
            authorityTime = next;
        } else {
            const seeded = makeAuthorityTime(physical, "0");
            if (seeded instanceof Error) {
                return { error: seeded };
            }
            authorityTime = seeded;
            if (compareAuthorityAscending(authorityTime, this.highWater) > 0) {
                this.highWater = authorityTime;
            }
        }
        const context = historicalValue
            ? makeJournalFrontier([[this.joiningWriter, predecessor]])
            : makeJournalFrontier([
                  [this.creatorWriter, this.creatorFrontierSequence],
                  [this.joiningWriter, predecessor],
              ]);
        if (context instanceof Error) {
            return { error: context };
        }
        this.lastSequence = sequence;
        if (compareAuthorityAscending(authorityTime, this.highWater) > 0) {
            this.highWater = authorityTime;
        }
        return { fields: { id, context, authorityTime } };
    }

    /**
     * @param {JournalRecord} record
     */
    append(record) {
        this.records.push(record);
    }

    /**
     * @returns {JournalSequence | undefined}
     */
    head() {
        return this.lastSequence;
    }
}

/**
 * The canonical validity edges into one occurrence, as canonical NodeKey identity to
 * the semantic key: the union of the bases of the certificates the canonical cut
 * holds for that occurrence. A canonical bootstrap cut holds exactly one
 * certificate per materialized node.
 * @param {ReadonlyArray<JournalRecord>} canonicalRecords
 * @param {string} valueIdText
 * @returns {Map<string, NodeKey>}
 */
function canonicalValidityEdges(canonicalRecords, valueIdText) {
    /** @type {Map<string, NodeKey>} */
    const edges = new Map();
    for (const record of canonicalRecords) {
        if (!isValidateEvent(record) || journalRecordIdToString(record.value) !== valueIdText) {
            continue;
        }
        for (const entry of record.basis) {
            const key = nodeKeyToCanonicalString(entry.input);
            if (!edges.has(key)) {
                edges.set(key, entry.input);
            }
        }
    }
    return edges;
}

/**
 * Whether the join already holds direct stale evidence for this occurrence: a
 * node-scoped or value-scoped invalidation naming it. Proof-scoped barriers are
 * per-edge evidence and are not direct stale evidence for the occurrence.
 * @param {ReadonlyArray<JournalRecord>} records
 * @param {string} nodeKeyString
 * @param {string} valueIdText
 * @returns {boolean}
 */
function holdsStaleEvidence(records, nodeKeyString, valueIdText) {
    for (const record of records) {
        if (!isInvalidateEvent(record) || nodeKeyToCanonicalString(record.node) !== nodeKeyString) {
            continue;
        }
        if (record.scope.kind === "node") {
            return true;
        }
        if (journalRecordIdToString(record.scope.value) === valueIdText) {
            return true;
        }
    }
    return false;
}

/**
 * The current graph schema's direct inputs of one materialized node as semantic
 * keys, which is the form a validation basis entry names.
 * @param {string} nodeKeyString
 * @param {CurrentInputKeysOfNode} currentInputKeysOfNode
 * @returns {ReadonlyArray<NodeKey> | JournalError}
 */
function semanticInputKeys(nodeKeyString, currentInputKeysOfNode) {
    const inputs = currentInputKeysOfNode(nodeKeyString);
    if (inputs === undefined) {
        return makeJournalPublicationError(
            "the current graph schema does not describe the materialized joining node " + nodeKeyString
        );
    }
    /** @type {NodeKey[]} */
    const keys = [];
    for (const input of inputs) {
        const parsed = deserializeNodeKey(stringToNodeKeyString(input));
        if (!isNodeKey(parsed)) {
            return makeJournalPublicationError(
                "the current graph schema names the direct input " +
                    JSON.stringify(input) +
                    " of " +
                    nodeKeyString +
                    ", which is not a canonical semantic node key text"
            );
        }
        keys.push(parsed);
    }
    return keys;
}

/**
 * The joining replica's occurrences in Pass J1 order: nondecreasing
 * `(modifiedAt, canonical NodeKey)`, which is the writer-local authority rule
 * canonical bootstrap uses too.
 * @param {LegacyBootstrapState} legacyState
 * @returns {ReadonlyArray<LegacyNode>}
 */
function joiningValueOrder(legacyState) {
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
 * Whether the canonical occurrence of a node and the joining persisted occurrence
 * are the same immutable occurrence, which §7.2 makes the condition for keeping the
 * canonical `ValueId` instead of authoring a historical value.
 * @param {ProjectedOccurrence} occurrence
 * @param {LegacyNode} node
 * @returns {boolean}
 */
function isExactSharedOccurrence(occurrence, node) {
    return (
        nodeIdentifierToString(occurrence.nodeIdentifier) === nodeIdentifierToString(node.nodeIdentifier) &&
        JSON.stringify(occurrence.payload) === JSON.stringify(node.payload) &&
        occurrence.createdAt === node.createdAt &&
        occurrence.modifiedAt === node.modifiedAt
    );
}

/**
 * Present nodes in one input-to-dependent topological order of the current schema,
 * so a single pass over them reaches the §7.4 fixed point because the schema is
 * acyclic.
 * @param {ReadonlyArray<string>} nodeKeyStrings
 * @param {CurrentInputKeysOfNode} currentInputKeysOfNode
 * @returns {ReadonlyArray<string> | JournalError}
 */
function topologicalOrder(nodeKeyStrings, currentInputKeysOfNode) {
    const present = new Set(nodeKeyStrings);
    /** @type {Map<string, ReadonlyArray<string>>} */
    const dependents = new Map();
    /** @type {Map<string, number>} */
    const remaining = new Map();
    for (const key of nodeKeyStrings) {
        remaining.set(key, 0);
    }
    for (const key of nodeKeyStrings) {
        for (const input of currentInputKeysOfNode(key) ?? []) {
            if (!present.has(input) || input === key) {
                continue;
            }
            remaining.set(key, (remaining.get(key) ?? 0) + 1);
            const existing = dependents.get(input) ?? [];
            dependents.set(input, [...existing, key]);
        }
    }
    /** @type {string[]} */
    const ready = nodeKeyStrings.filter((key) => remaining.get(key) === 0);
    /** @type {string[]} */
    const order = [];
    while (ready.length > 0) {
        const key = ready.shift();
        if (key === undefined) {
            break;
        }
        order.push(key);
        for (const dependent of dependents.get(key) ?? []) {
            const left = (remaining.get(dependent) ?? 0) - 1;
            remaining.set(dependent, left);
            if (left === 0) {
                ready.push(dependent);
            }
        }
    }
    if (order.length !== nodeKeyStrings.length) {
        return makeJournalPublicationError(
            "the current graph schema is not acyclic, so the joining bootstrap has no input-to-dependent order"
        );
    }
    return order;
}
module.exports = {
    JoiningCursorClass,
    canonicalValidityEdges,
    compareAuthorityAscending,
    greatestHeldAuthority,
    holdsStaleEvidence,
    isExactSharedOccurrence,
    joiningValueOrder,
    semanticInputKeys,
    topologicalOrder,
};
